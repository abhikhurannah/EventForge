import { describe, expect, it } from 'vitest';
import { z } from 'zod';
describe('event contract', () => { it('rejects invalid event names', () => expect(z.string().regex(/^[a-z][a-z0-9_.-]+$/).safeParse('Invalid Event').success).toBe(false)); it('accepts event-style names', () => expect(z.string().regex(/^[a-z][a-z0-9_.-]+$/).safeParse('order.fulfilled').success).toBe(true)); });
