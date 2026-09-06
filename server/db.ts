import mongoose, { Schema } from 'mongoose';
const opts = { timestamps: true } as const;
export const User = mongoose.model('User', new Schema({ email: { type: String, required: true, unique: true }, password: { type: String, required: true } }, opts));
export const Session = mongoose.model('Session', new Schema({ hash: { type: String, unique: true, required: true }, userId: { type: String, required: true }, expiresAt: { type: Date, required: true, expires: 0 } }, opts));
export const Project = mongoose.model('Project', new Schema({ ownerId: { type: String, required: true, index: true }, name: { type: String, required: true }, webhookUrl: { type: String, default: '' }, webhookSecret: { type: String, required: true } }, opts));
export const ApiKey = mongoose.model('ApiKey', new Schema({ projectId: { type: String, required: true, index: true }, name: { type: String, required: true }, prefix: String, hash: { type: String, required: true, unique: true }, revokedAt: Date }, opts));
const eventSchema = new Schema({
  projectId: { type: String, required: true, index: true }, name: { type: String, required: true }, payload: { type: Schema.Types.Mixed, required: true },
  priority: { type: Number, required: true }, idempotencyKey: String, digest: { type: String, required: true },
  status: { type: String, default: 'queued', enum: ['queued', 'running', 'retrying', 'succeeded', 'dead-letter'] },
  generation: { type: Number, default: 0 }, dispatched: { type: Boolean, default: false, index: true }, deadPending: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 }, runAttempts: { type: Number, default: 0 }, maxAttempts: { type: Number, default: 3 },
  startedAt: Date, completedAt: Date, durationMs: Number, latencyMs: Number, error: Schema.Types.Mixed,
  webhookUrl: { type: String, default: '' }, webhookSecret: { type: String, default: '', select: false },
  deliveryPending: { type: Boolean, default: false },
}, opts);
eventSchema.index({ projectId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
eventSchema.index({ projectId: 1, createdAt: -1 });
export const Event = mongoose.model('Event', eventSchema);
const deliverySchema = new Schema({
  eventId: { type: String, required: true }, generation: { type: Number, required: true }, projectId: { type: String, required: true, index: true },
  url: { type: String, required: true }, secret: { type: String, required: true, select: false }, body: { type: String, required: true },
  status: { type: String, default: 'queued' }, dispatched: { type: Boolean, default: false }, attempts: { type: Number, default: 0 },
  logs: [{ attempt: Number, at: Date, statusCode: Number, code: String }],
}, opts);
deliverySchema.index({ eventId: 1, generation: 1 }, { unique: true });
export const Delivery = mongoose.model('Delivery', deliverySchema);
export async function connectDb() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/eventforge');
  await Promise.all([User.init(), Session.init(), Project.init(), ApiKey.init(), Event.init(), Delivery.init()]);
}
