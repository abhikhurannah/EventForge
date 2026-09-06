import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Worker as WorkerType } from 'bullmq';

// Explicit test database and independent queue namespace. Never flush shared Redis.
const enabled = process.env.RUN_INTEGRATION === '1';
const deliveryResponses = vi.hoisted(() => ({ codes: [500, 500, 204] }));
vi.mock('../server/webhooks.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/webhooks.js')>(),
  // Only outbound HTTP is stubbed. Mongo persistence and BullMQ retries are real.
  sendWebhook: vi.fn(async () => deliveryResponses.codes.shift() ?? 204),
}));
describe.skipIf(!enabled)('MongoDB + Redis integration', () => {
  let app: FastifyInstance;
  let db: typeof import('../server/db.js');
  let queues: typeof import('../server/redis.js');
  let processing: typeof import('../server/processing.js');
  let worker: WorkerType;
  let webhookWorker: WorkerType;
  let access: string, other: string, projectId: string, apiKey: string, keyId: string, cookie: string;
  beforeAll(async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/eventforge_test';
    if (!uri.split('?')[0].endsWith('/eventforge_test')) throw new Error('Integration tests require database eventforge_test.');
    process.env.MONGODB_URI = uri;
    process.env.JWT_SECRET = 'test-only-secret-at-least-thirty-two-characters';
    process.env.QUEUE_PREFIX = `eventforge-test-${Date.now()}`;
    process.env.RETRY_DELAY_MS = '50';
    process.env.WEB_ORIGIN = 'http://localhost:5173';
    db = await import('../server/db.js'); await db.connectDb();
    queues = await import('../server/redis.js'); processing = await import('../server/processing.js');
    app = await (await import('../server/app.js')).buildApp(); await app.ready();
    const email = `owner-${Date.now()}@example.com`;
    const a = await app.inject({ method:'POST',url:'/api/auth/register',payload:{email,password:'correct-test-password'} });
    expect(a.statusCode).toBe(201); access = a.json().accessToken;
    cookie = String(a.headers['set-cookie']).split(';')[0];
    const b = await app.inject({ method:'POST',url:'/api/auth/register',payload:{email:`other-${email}`,password:'correct-test-password'} });
    other = b.json().accessToken;
    const p = await app.inject({ method:'POST',url:'/api/projects',headers:{authorization:`Bearer ${access}`},payload:{name:'Integration'} });
    projectId = p.json().project._id;
    const k = await app.inject({method:'POST',url:`/api/projects/${projectId}/keys`,headers:{authorization:`Bearer ${access}`},payload:{name:'Test'}});
    apiKey = k.json().secret; keyId = k.json().key._id;
  }, 30000);
  afterAll(async () => {
    if (worker) await worker.close();
    if (webhookWorker) await webhookWorker.close();
    if (app) await app.close();
    if (queues) { await queues.eventQueue.obliterate({force:true}); await queues.deliveryQueue.obliterate({force:true}); await queues.deadQueue.obliterate({force:true}); await queues.closeQueues(); }
    if (db && projectId) { await db.Event.deleteMany({projectId}); await db.Delivery.deleteMany({projectId}); await db.ApiKey.deleteMany({projectId}); await db.Project.deleteOne({_id:projectId}); }
    if (db) await (await import('mongoose')).default.disconnect();
  });
  const send = (payload: Record<string,unknown>, idem?: string) => app.inject({method:'POST',url:'/events',headers:{'x-api-key':apiKey,...(idem?{'idempotency-key':idem}:{})},payload:{name:'order.created',payload}});
  const auth = () => ({authorization:`Bearer ${access}`});
  async function until(check:()=>Promise<boolean>) { const end=Date.now()+10000; while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out waiting for job state'); }
  it('requires auth and prevents another user reading project data', async()=>{
    expect((await app.inject({url:`/api/projects/${projectId}/jobs`})).statusCode).toBe(401);
    expect((await app.inject({url:`/api/projects/${projectId}/jobs`,headers:{authorization:`Bearer ${other}`}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/events',payload:{name:'order.created'}})).statusCode).toBe(401);
  });
  it('rotates refresh tokens and refuses replay or wrong origin', async()=>{
    const refresh = ()=>app.inject({method:'POST',url:'/api/auth/refresh',headers:{cookie,origin:'http://localhost:5173'}});
    expect((await app.inject({method:'POST',url:'/api/auth/refresh',headers:{cookie,origin:'https://bad.example'}})).statusCode).toBe(403);
    expect((await refresh()).statusCode).toBe(200); expect((await refresh()).statusCode).toBe(401);
  });
  it('deduplicates concurrent identical events and rejects changed content', async()=>{
    const requests = await Promise.all(Array.from({length:8},()=>send({order:1},'concurrent')));
    expect(requests.filter(r=>r.statusCode===202)).toHaveLength(1);
    expect(new Set(requests.map(r=>r.json().jobId)).size).toBe(1);
    expect((await send({order:2},'concurrent')).statusCode).toBe(409);
    expect(await db.Event.countDocuments({projectId,idempotencyKey:'concurrent'})).toBe(1);
  });
  it('allows multiple events without idempotency keys and rejects invalid payloads', async()=>{
    expect((await send({a:1})).statusCode).toBe(202); expect((await send({a:2})).statusCode).toBe(202);
    expect((await app.inject({method:'POST',url:'/events',headers:{'x-api-key':apiKey},payload:{name:'Invalid Name'}})).statusCode).toBe(422);
  });
  it('enforces a shared project rate limit', async()=>{
    process.env.PROJECT_RATE_LIMIT='2'; await queues.redis.del(`${queues.queuePrefix}:rate:${projectId}`);
    expect((await send({})).statusCode).toBe(202); expect((await send({})).statusCode).toBe(202); expect((await send({})).statusCode).toBe(429);
    process.env.PROJECT_RATE_LIMIT='100';
  });
  it('dispatches durable pending events idempotently and uses priority', async()=>{
    await processing.dispatch(); const before=await queues.eventQueue.getWaitingCount(); await processing.dispatch();
    expect(await queues.eventQueue.getWaitingCount()).toBe(before);
    const e=await db.Event.findOne({projectId}); const q=await queues.eventQueue.getJob(`${e!.id}-0`);
    expect(q?.opts.priority).toBe(6); expect(q?.opts.backoff).toEqual({type:'exponential',delay:50});
  });
  it('retries transient failures then succeeds; archives exhausted jobs and scopes manual retries', async()=>{
    const {Worker}=await import('bullmq'); worker=new Worker('eventforge-events',processing.processEvent,{connection:queues.redis,prefix:queues.queuePrefix,concurrency:2});
    const transient=(await send({failUntilAttempt:1})).json().jobId;
    const permanent=(await send({simulateFailure:true})).json().jobId;
    await processing.dispatch();
    await until(async()=> (await db.Event.findById(transient))?.status==='succeeded' && (await db.Event.findById(permanent))?.status==='dead-letter');
    expect((await db.Event.findById(transient))?.attempts).toBe(2);
    expect((await db.Event.findById(permanent))?.attempts).toBe(3);
    await processing.dispatch(); expect(await queues.deadQueue.getJob(`${permanent}-0`)).toBeTruthy();
    expect((await app.inject({method:'POST',url:`/api/projects/${projectId}/jobs/${permanent}/retry`,headers:{authorization:`Bearer ${other}`}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`/api/projects/${projectId}/jobs/${permanent}/retry`,headers:auth()})).statusCode).toBe(200);
    expect((await db.Event.findById(permanent))?.generation).toBe(1);
  });
  it('retries webhook delivery independently without rerunning the event handler', async()=>{
    await db.Project.updateOne({_id:projectId},{webhookUrl:'https://receiver.example/hook'});
    const eventId=(await send({order:'delivery-test'})).json().jobId;
    await processing.dispatch();
    await until(async()=> (await db.Event.findById(eventId))?.status==='succeeded');
    await processing.dispatch();
    const {Worker}=await import('bullmq');
    webhookWorker=new Worker('eventforge-webhooks',processing.processDelivery,{connection:queues.redis,prefix:queues.queuePrefix,concurrency:1});
    await until(async()=> (await db.Delivery.findOne({eventId}))?.status==='delivered');
    const delivery=await db.Delivery.findOne({eventId});
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.logs.map(l=>l.statusCode)).toEqual([500,500,204]);
    expect((await db.Event.findById(eventId))?.attempts).toBe(1);
  });
  it('revokes an API key', async()=>{
    expect((await app.inject({method:'DELETE',url:`/api/projects/${projectId}/keys/${keyId}`,headers:auth()})).statusCode).toBe(200);
    expect((await send({})).statusCode).toBe(401);
  });
});
