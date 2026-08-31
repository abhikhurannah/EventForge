import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { Delivery, JobRecord } from '../../api/src/models.js';

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const deadLetter = new Queue('dead-letter', { connection });

type Data = { projectId: string; eventId: string; eventName: string; payload: Record<string, unknown>; webhookUrl?: string };

// Fix: the worker previously never talked to MongoDB, so JobRecord.status stayed "queued"
// forever no matter what happened -- the dashboard's /jobs endpoint had nothing real to show.
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eventforge');

const worker = new Worker<Data>('events', async job => {
  await JobRecord.findOneAndUpdate({ queueJobId: job.id }, { status: 'running', attempts: job.attemptsMade + 1 });
  const started = Date.now();

  // Domain handlers belong here. This deliberately fails only when a payload asks to simulate failure.
  if (job.data.payload.simulateFailure) throw new Error(`Simulated processing failure for ${job.data.eventName}`);

  if (job.data.webhookUrl) {
    const delivery = await Delivery.create({ projectId: job.data.projectId, jobId: job.data.eventId, url: job.data.webhookUrl, status: 'pending', attempts: 1 });
    try {
      const response = await fetch(job.data.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-eventforge-event': job.data.eventName },
        body: JSON.stringify({ id: job.data.eventId, event: job.data.eventName, payload: job.data.payload })
      });
      delivery.status = response.ok ? 'delivered' : 'failed';
      delivery.responseCode = response.status;
      await delivery.save();
      if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
    } catch (err) {
      delivery.status = 'failed';
      delivery.lastError = (err as Error).message;
      await delivery.save();
      throw err;
    }
  }

  const latencyMs = Date.now() - started;
  await JobRecord.findOneAndUpdate({ queueJobId: job.id }, { status: 'succeeded', latencyMs, completedAt: new Date() });
  return { latencyMs };
}, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 10) });

worker.on('failed', async (job, error) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts || 1);
  await JobRecord.findOneAndUpdate(
    { queueJobId: job.id },
    { status: exhausted ? 'dead-letter' : 'failed', error: { message: error.message, stack: error.stack, sanitizedLog: error.message } }
  );
  if (exhausted) {
    await deadLetter.add('permanently-failed', { ...job.data, failedJobId: job.id, error: error.message }, { removeOnComplete: 500 });
  }
});
worker.on('completed', job => console.log(`completed ${job.id}`));
worker.on('error', error => console.error('worker error', error));
