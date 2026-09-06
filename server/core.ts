import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const scrypt = promisify(crypto.scrypt);
export const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const token = () => crypto.randomBytes(32).toString('base64url');
export async function passwordHash(password: string) {
  const salt = token();
  return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const eventInput = z.object({
  name: z.string().min(2).max(100).regex(/^[a-z][a-z0-9_.-]+$/),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().int().min(1).max(10).default(5),
}).strict();
export const errorInfo = (error: unknown) => {
  const code = error instanceof Error && error.message === 'SIMULATED_FAILURE' ? 'SIMULATED_FAILURE' : 'PROCESSING_ERROR';
  return { code, message: code === 'SIMULATED_FAILURE' ? 'The event requested a simulated failure.' : 'Processing failed. Review server diagnostics.', category: 'processing' };
};
export const terminal = (attempt: number, maxAttempts: number) => attempt >= maxAttempts;
export const signature = (secret: string, timestamp: string, body: string) => crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
