import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { connectDb } from './db.js';
import { closeQueues, redis, queuePrefix } from './redis.js';
import { dispatch, processDelivery, processEvent } from './processing.js';
await connectDb();
const workers = [new Worker('eventforge-events', processEvent, { connection: redis, prefix: queuePrefix, concurrency: Number(process.env.WORKER_CONCURRENCY || 5) }), new Worker('eventforge-webhooks', processDelivery, { connection: redis, prefix: queuePrefix, concurrency: 5 })];
workers.forEach(w => w.on('error', () => console.error('Queue connection error; awaiting reconnect.')));
let stopping = false;
let current: Promise<void> = Promise.resolve();
async function tick() {
  if (stopping) return;
  current = dispatch().catch(() => { console.error('Dispatch deferred; will retry.'); });
  await current;
  if (!stopping) timer = setTimeout(tick, 1000);
}
let timer = setTimeout(tick, 0);
async function stop() { stopping = true; clearTimeout(timer); await current; await Promise.all(workers.map(w => w.close())); await closeQueues(); await mongoose.disconnect(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
