import { connectDb } from './db.js';
import { buildApp } from './app.js';
import { closeQueues } from './redis.js';
import mongoose from 'mongoose';
await connectDb();
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3001) });
async function stop() { await app.close(); await closeQueues(); await mongoose.disconnect(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
