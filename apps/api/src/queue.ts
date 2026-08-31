import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
const url = process.env.REDIS_URL || 'redis://localhost:6379';
export const connection = new Redis(url, { maxRetriesPerRequest: null });
export const eventsQueue = new Queue('events', { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: false } });
export type EventJobData = { projectId: string; eventId: string; eventName: string; payload: Record<string, unknown>; webhookUrl?: string };
