import type { Job } from 'bullmq';
import { Event, Delivery } from './db.js';
import { deadQueue, deliveryQueue, eventQueue, retryOptions } from './redis.js';
import { errorInfo, terminal } from './core.js';
import { sendWebhook } from './webhooks.js';

type Ref = { eventId: string; generation: number };
export async function dispatch() {
  for (const e of await Event.find({ dispatched: false, status: 'queued' }).limit(100)) {
    await eventQueue.add(e.name, { eventId: e.id, generation: e.generation }, { ...retryOptions(), jobId: `${e.id}-${e.generation}`, priority: 11 - e.priority });
    await Event.updateOne({ _id: e.id, generation: e.generation }, { dispatched: true });
  }
  for (const e of await Event.find({ deadPending: true }).limit(100)) {
    await deadQueue.add('exhausted', { eventId: e.id, projectId: e.projectId, generation: e.generation, error: e.error }, { jobId: `${e.id}-${e.generation}` });
    await Event.updateOne({ _id: e.id, generation: e.generation }, { deadPending: false });
  }
  for (const e of await Event.find({ deliveryPending: true }).select('+webhookSecret').limit(100)) {
    await Delivery.updateOne({ eventId: e.id, generation: e.generation }, { $setOnInsert: {
      projectId: e.projectId, url: e.webhookUrl, secret: e.webhookSecret,
      body: JSON.stringify({ id: e.id, event: e.name, payload: e.payload, createdAt: e.createdAt }),
    } }, { upsert: true });
    await Event.updateOne({ _id: e.id, generation: e.generation }, { deliveryPending: false });
  }
  for (const d of await Delivery.find({ dispatched: false }).limit(100)) {
    await deliveryQueue.add('deliver', { deliveryId: d.id }, { ...retryOptions(), jobId: d.id });
    await Delivery.updateOne({ _id: d.id }, { dispatched: true });
  }
  // Repair Mongo state if BullMQ exhausted a stalled job after a worker crash.
  for (const e of await Event.find({ dispatched: true, status: { $in: ['queued','running','retrying'] } }).limit(1000)) {
    const queued = await eventQueue.getJob(`${e.id}-${e.generation}`);
    if (queued && await queued.getState() === 'failed') await Event.updateOne({ _id: e.id, generation: e.generation, status: { $ne: 'succeeded' } }, { status: 'dead-letter', deadPending: true, completedAt: new Date(), error: { code: 'PROCESSING_ERROR', message: 'Worker exhausted processing attempts or stalled.' } });
  }
}
export async function processEvent(job: Job<Ref>) {
  const { eventId, generation } = job.data;
  const e = await Event.findOne({ _id: eventId, generation });
  if (!e || ['succeeded','dead-letter'].includes(e.status)) return;
  const started = Date.now();
  await Event.updateOne({ _id: e.id, generation }, { $set: { status: 'running', startedAt: new Date(), runAttempts: job.attemptsMade + 1 }, $inc: { attempts: 1 } });
  try {
    // This reference handler validates/accepts an event. Add domain handlers here.
    if (e.payload.simulateFailure === true || Number(e.payload.failUntilAttempt || 0) >= job.attemptsMade + 1) throw new Error('SIMULATED_FAILURE');
    await Event.updateOne({ _id: e.id, generation }, { $set: { status: 'succeeded', completedAt: new Date(), durationMs: Date.now() - started, latencyMs: Date.now() - e.createdAt.getTime(), deliveryPending: Boolean(e.webhookUrl) }, $unset: { error: 1 } });
  } catch (err) {
    const exhausted = terminal(job.attemptsMade + 1, e.maxAttempts);
    await Event.updateOne({ _id: e.id, generation }, { status: exhausted ? 'dead-letter' : 'retrying', deadPending: exhausted, error: errorInfo(err), ...(exhausted ? { completedAt: new Date() } : {}) });
    throw new Error(errorInfo(err).code);
  }
}
export async function processDelivery(job: Job<{ deliveryId: string }>) {
  const d = await Delivery.findById(job.data.deliveryId).select('+secret');
  if (!d || d.status === 'delivered') return;
  const attempt = job.attemptsMade + 1;
  let statusCode = 0;
  try {
    statusCode = await sendWebhook(d.url, d.secret, d.body, d.id);
    if (statusCode < 200 || statusCode >= 300) throw new Error('HTTP_FAILURE');
    await Delivery.updateOne({ _id: d.id }, { $set: { status: 'delivered', attempts: attempt }, $push: { logs: { attempt, at: new Date(), statusCode, code: 'OK' } } });
  } catch {
    await Delivery.updateOne({ _id: d.id }, { $set: { status: terminal(attempt, 3) ? 'failed' : 'retrying', attempts: attempt }, $push: { logs: { attempt, at: new Date(), statusCode, code: statusCode ? 'HTTP_FAILURE' : 'NETWORK_OR_DESTINATION_ERROR' } } });
    throw new Error('WEBHOOK_DELIVERY_FAILED');
  }
}
