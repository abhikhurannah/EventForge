import mongoose, { Schema } from 'mongoose';

const projectSchema = new Schema({ name: { type: String, required: true }, slug: { type: String, unique: true }, ownerId: { type: Schema.Types.ObjectId, ref: 'User' }, apiKeyHash: String, webhookUrl: String }, { timestamps: true });
const eventSchema = new Schema({ projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true }, name: String, payload: Schema.Types.Mixed, idempotencyKey: { type: String, index: true }, queueJobId: String }, { timestamps: true });
eventSchema.index({ projectId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
const jobSchema = new Schema({ projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true }, eventId: { type: Schema.Types.ObjectId, ref: 'Event' }, queueJobId: { type: String, unique: true }, status: { type: String, enum: ['queued','running','succeeded','failed','dead-letter'], default: 'queued' }, attempts: { type: Number, default: 0 }, latencyMs: Number, error: { message: String, stack: String, sanitizedLog: String }, completedAt: Date }, { timestamps: true });
const deliverySchema = new Schema({ projectId: Schema.Types.ObjectId, jobId: Schema.Types.ObjectId, url: String, status: { type: String, enum: ['pending','delivered','failed'], default: 'pending' }, attempts: { type: Number, default: 0 }, responseCode: Number, lastError: String }, { timestamps: true });
export const Project = mongoose.model('Project', projectSchema);
export const Event = mongoose.model('Event', eventSchema);
export const JobRecord = mongoose.model('JobRecord', jobSchema);
export const Delivery = mongoose.model('Delivery', deliverySchema);
