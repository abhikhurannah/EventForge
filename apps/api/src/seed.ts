import mongoose from 'mongoose'; import { Project } from './models.js'; import crypto from 'node:crypto';
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eventforge');
const key = 'ef_demo_acme_key'; await Project.findOneAndUpdate({ slug: 'acme-commerce' }, { name: 'Acme Commerce', slug: 'acme-commerce', apiKeyHash: hash(key), webhookUrl: 'https://webhook.site/example' }, { upsert: true }); console.log(`Demo project ready. API key: ${key}`); await mongoose.disconnect();
