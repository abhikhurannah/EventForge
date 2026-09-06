import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import mongoose from 'mongoose';
import { z, ZodError } from 'zod';
import { ApiKey, Event, Project, Session, User, Delivery } from './db.js';
import { canonical, eventInput, hash, passwordHash, passwordMatches, token } from './core.js';
import { redis, queuePrefix } from './redis.js';
import { resolveWebhook } from './webhooks.js';

const credentials = z.object({ email: z.string().trim().email().toLowerCase(), password: z.string().min(12).max(128) });
const origin = () => process.env.WEB_ORIGIN || 'http://localhost:5173';
function fail(statusCode: number, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
function id(value: string) { if (!mongoose.isValidObjectId(value)) fail(400, 'Invalid resource ID'); return value; }
export async function buildApp() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Set JWT_SECRET to at least 32 characters.');
  const app = Fastify({ bodyLimit: 65536, logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-api-key'] } });
  await app.register(cors, { origin: origin(), credentials: true });
  await app.register(jwt, { secret });
  await app.register(rateLimit, { redis, max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(422).send({ error: 'Invalid request', details: err.flatten() });
    if ((err as { code?: number }).code === 11000) return reply.code(409).send({ error: 'Resource already exists' });
    const status = Number((err as { statusCode?: number }).statusCode) || 500;
    return reply.code(status).send({ error: status >= 500 ? 'Service unavailable; please retry.' : (err as Error).message });
  });
  app.addHook('onRequest', async (req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== origin()) fail(403, 'Origin not allowed');
  });
  async function user(req: FastifyRequest) {
    try { const claims = await req.jwtVerify<{ sub: string; kind: string }>(); if (claims.kind !== 'access') fail(401, 'Sign in required'); return claims.sub; }
    catch { return fail(401, 'Sign in required'); }
  }
  async function project(req: FastifyRequest, projectId: string) {
    const ownerId = await user(req);
    const found = await Project.findOne({ _id: id(projectId), ownerId });
    if (!found) fail(404, 'Project not found');
    return found;
  }
  async function session(userId: string, reply: { header: (name: string, value: string) => unknown }) {
    const raw = token();
    await Session.create({ hash: hash(raw), userId, expiresAt: new Date(Date.now() + 30 * 86400000) });
    reply.header('set-cookie', `ef_refresh=${raw}; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return { accessToken: app.jwt.sign({ sub: userId, kind: 'access' }, { expiresIn: '15m' }) };
  }
  app.get('/api/health', async (_req, reply) => {
    const ok = mongoose.connection.readyState === 1 && redis.status === 'ready';
    return reply.code(ok ? 200 : 503).send({ ok });
  });
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.parse(req.body);
    const created = await User.create({ email: body.email, password: await passwordHash(body.password) });
    return reply.code(201).send({ ...(await session(created.id, reply)), email: created.email });
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.parse(req.body);
    const found = await User.findOne({ email: body.email });
    if (!found || !await passwordMatches(body.password, found.password)) fail(401, 'Invalid email or password');
    return { ...(await session(found.id, reply)), email: found.email };
  });
  app.post('/api/auth/refresh', async (req, reply) => {
    if (req.headers.origin !== origin()) fail(403, 'Origin required');
    const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ef_refresh='))?.slice(11);
    if (!raw) fail(401, 'Sign in required');
    const old = await Session.findOneAndDelete({ hash: hash(raw), expiresAt: { $gt: new Date() } });
    if (!old) fail(401, 'Session expired');
    return session(old.userId, reply);
  });
  app.post('/api/auth/logout', async (req, reply) => {
    if (req.headers.origin !== origin()) fail(403, 'Origin required');
    const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ef_refresh='))?.slice(11);
    if (raw) await Session.deleteOne({ hash: hash(raw) });
    reply.header('set-cookie', 'ef_refresh=; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });
  app.get('/api/projects', async req => ({ projects: await Project.find({ ownerId: await user(req) }).select('-webhookSecret').sort({ createdAt: -1 }) }));
  app.post('/api/projects', async (req, reply) => {
    const ownerId = await user(req);
    const body = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    const created = await Project.create({ ownerId, name: body.name, webhookSecret: token() });
    return reply.code(201).send({ project: { _id: created.id, name: created.name, webhookUrl: '' } });
  });
  app.get('/api/projects/:projectId/keys', async req => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    return { keys: await ApiKey.find({ projectId: p.id }).select('-hash').sort({ createdAt: -1 }) };
  });
  app.post('/api/projects/:projectId/keys', async (req, reply) => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const raw = `ef_${token()}`;
    const key = await ApiKey.create({ projectId: p.id, name, prefix: raw.slice(0, 10), hash: hash(raw) });
    return reply.code(201).send({ key: { _id: key.id, name, prefix: key.prefix }, secret: raw });
  });
  app.delete('/api/projects/:projectId/keys/:keyId', async req => {
    const { projectId, keyId } = req.params as { projectId: string; keyId: string };
    const p = await project(req, projectId);
    const found = await ApiKey.findOneAndUpdate({ _id: id(keyId), projectId: p.id }, { revokedAt: new Date() });
    if (!found) fail(404, 'Key not found'); return { ok: true };
  });
  app.put('/api/projects/:projectId/webhook', async req => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    const { url } = z.object({ url: z.union([z.literal(''), z.string().url().max(2048)]) }).parse(req.body);
    if (url) { try { await resolveWebhook(url); } catch { fail(422, 'Use a public HTTPS webhook URL on port 443.'); } }
    p.webhookUrl = url; await p.save(); return { url, signingSecret: p.webhookSecret };
  });
  async function ingest(req: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const raw = req.headers['x-api-key'];
    if (typeof raw !== 'string') fail(401, 'API key required');
    const key = await ApiKey.findOne({ hash: hash(raw), revokedAt: { $exists: false } });
    if (!key) fail(401, 'Invalid API key');
    const p = await Project.findById(key.projectId); if (!p) fail(401, 'Invalid project');
    const count = await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, `${queuePrefix}:rate:${p.id}`) as number;
    if (count > Number(process.env.PROJECT_RATE_LIMIT || 100)) fail(429, 'Project rate limit exceeded; retry in one minute');
    const body = eventInput.parse(req.body);
    const header = req.headers['idempotency-key'];
    const ik = header === undefined ? undefined : z.string().min(1).max(200).parse(header);
    const digest = hash(canonical(body));
    try {
      const event = await Event.create({ ...body, projectId: p.id, digest, ...(ik === undefined ? {} : { idempotencyKey: ik }), webhookUrl: p.webhookUrl, webhookSecret: p.webhookSecret });
      return reply.code(202).send({ eventId: event.id, jobId: event.id, status: event.status, duplicate: false });
    } catch (err) {
      if (ik && (err as { code?: number }).code === 11000) {
        const existing = await Event.findOne({ projectId: p.id, idempotencyKey: ik });
        if (existing) { if (existing.digest !== digest) fail(409, 'Idempotency key already used for different content'); return reply.code(200).send({ eventId: existing.id, jobId: existing.id, status: existing.status, duplicate: true }); }
      }
      throw err;
    }
  }
  app.post('/api/events', ingest);
  app.post('/events', ingest);
  app.get('/api/projects/:projectId/jobs', async req => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    const query = z.object({ status: z.enum(['queued','running','retrying','succeeded','dead-letter']).optional(), page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(req.query);
    const filter = { projectId: p.id, ...(query.status ? { status: query.status } : {}) };
    const [jobs, total] = await Promise.all([Event.find(filter).select('-payload -digest').sort({ createdAt: -1 }).skip((query.page - 1) * 25).limit(25), Event.countDocuments(filter)]);
    return { jobs, total, page: query.page };
  });
  app.get('/api/projects/:projectId/jobs/:jobId', async req => {
    const { projectId, jobId } = req.params as { projectId: string; jobId: string };
    const p = await project(req, projectId);
    const job = await Event.findOne({ _id: id(jobId), projectId: p.id }).select('-digest');
    if (!job) fail(404, 'Job not found'); return { job };
  });
  app.post('/api/projects/:projectId/jobs/:jobId/retry', async req => {
    const { projectId, jobId } = req.params as { projectId: string; jobId: string };
    const p = await project(req, projectId);
    const job = await Event.findOneAndUpdate({ _id: id(jobId), projectId: p.id, status: 'dead-letter', deadPending: false }, { $set: { status: 'queued', dispatched: false, runAttempts: 0 }, $unset: { completedAt: 1, error: 1 }, $inc: { generation: 1 } }, { new: true });
    if (!job) fail(409, 'Only archived, permanently failed jobs can be retried. Refresh and try again.'); return { jobId: job.id, status: job.status };
  });
  app.get('/api/projects/:projectId/deliveries', async req => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    return { deliveries: await Delivery.find({ projectId: p.id }).select('-body').sort({ createdAt: -1 }).limit(100) };
  });
  app.get('/api/projects/:projectId/metrics', async req => {
    const p = await project(req, (req.params as { projectId: string }).projectId);
    const since = new Date(Date.now() - 86400000);
    const [rows, hourly] = await Promise.all([
      Event.aggregate([{ $match: { projectId: p.id, createdAt: { $gte: since } } }, { $group: { _id: '$status', count: { $sum: 1 }, avgDurationMs: { $avg: '$durationMs' }, avgLatencyMs: { $avg: '$latencyMs' }, retried: { $sum: { $cond: [{ $gt: ['$attempts', 1] }, 1, 0] } } } }]),
      Event.aggregate([{ $match: { projectId: p.id, createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%dT%H:00:00Z', date: '$createdAt' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    ]);
    return { collectedAt: new Date(), since, rows, hourly };
  });
  app.post('/api/projects/:projectId/jobs/:jobId/explain', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const { projectId, jobId } = req.params as { projectId: string; jobId: string };
    const p = await project(req, projectId);
    const job = await Event.findOne({ _id: id(jobId), projectId: p.id }); if (!job) fail(404, 'Job not found');
    if (!job.error) fail(409, 'This job has no recorded failure');
    if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) fail(503, 'AI is not configured. Core processing remains available.');
    // No payloads, free-form logs, event names, URLs, user IDs or credentials leave this service.
    const safe = { code: job.error.code === 'SIMULATED_FAILURE' ? 'SIMULATED_FAILURE' : 'PROCESSING_ERROR', attempts: job.attempts, maxAttempts: job.maxAttempts, status: job.status };
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL)}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Suggest concise debugging checks from structured job metadata. State uncertainty; never assert a root cause.' }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify(safe) }] }], generationConfig: { maxOutputTokens: 500 } }) });
    if (!response.ok) fail(502, 'AI provider unavailable');
    const body = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { label: 'Suggestion—not root cause', sentMetadata: safe, explanation: body.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'No suggestion returned.' };
  });
  return app;
}
