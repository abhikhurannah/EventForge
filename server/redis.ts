import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
export const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
export const queuePrefix = process.env.QUEUE_PREFIX || 'eventforge';
export const eventQueue = new Queue('eventforge-events', { connection: redis, prefix: queuePrefix });
export const deliveryQueue = new Queue('eventforge-webhooks', { connection: redis, prefix: queuePrefix });
export const deadQueue = new Queue('eventforge-dead', { connection: redis, prefix: queuePrefix });
export const retryOptions = () => ({ attempts: 3, backoff: { type: 'exponential', delay: Number(process.env.RETRY_DELAY_MS || 1000) } });
export async function closeQueues() { await Promise.all([eventQueue.close(), deliveryQueue.close(), deadQueue.close()]); await redis.quit(); }
