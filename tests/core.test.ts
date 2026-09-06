import { describe, it, expect } from 'vitest';
import { canonical, errorInfo, eventInput, hash, passwordHash, passwordMatches, signature, terminal } from '../server/core.js';
import { publicIPv4 } from '../server/webhooks.js';

describe('event request contract', () => {
  it('normalizes omitted defaults and object key order for idempotency', () => {
    const a = eventInput.parse({ name: 'order.created', payload: { b: 2, a: 1 } });
    const b = eventInput.parse({ payload: { a: 1, b: 2 }, priority: 5, name: 'order.created' });
    expect(hash(canonical(a))).toBe(hash(canonical(b)));
    expect(hash(canonical(a))).not.toBe(hash(canonical({ ...b, priority: 10 })));
  });
  it.each([{}, { name: 'Bad Name' }, { name: 'order.created', priority: 0 }, { name: 'order.created', priority: 11 }, { name: 'order.created', payload: [] }, { name: 'order.created', arbitrary: true }])('rejects invalid input %#', value => expect(eventInput.safeParse(value).success).toBe(false));
});
describe('passwords and error privacy', () => {
  it('salts identical passwords differently and rejects wrong passwords', async () => {
    const password = 'correct-horse-battery-123';
    const first = await passwordHash(password), second = await passwordHash(password);
    expect(first).not.toBe(second);
    expect(await passwordMatches(password, first)).toBe(true);
    expect(await passwordMatches('wrong-password', first)).toBe(false);
  });
  it('does not retain free-form errors or secrets as AI-visible logs', () => {
    const value = JSON.stringify(errorInfo(new Error('Authorization: Bearer SECRET email alice@example.com')));
    expect(value).not.toMatch(/SECRET|alice|Bearer/);
    expect(errorInfo(new Error('SIMULATED_FAILURE')).code).toBe('SIMULATED_FAILURE');
  });
});
describe('webhook destination safety and signatures', () => {
  it.each(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1'])('rejects non-public address %s', address => expect(publicIPv4(address)).toBe(false));
  it('allows public IPv4', () => expect(publicIPv4('8.8.8.8')).toBe(true));
  it('binds signatures to both timestamp and exact payload', () => {
    const value = signature('test-secret','100','{"a":1}');
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toBe(signature('test-secret','101','{"a":1}'));
    expect(value).not.toBe(signature('test-secret','100','{"a":2}'));
  });
  it('only treats an exhausted retry budget as terminal', () => {
    expect(terminal(1,3)).toBe(false); expect(terminal(2,3)).toBe(false); expect(terminal(3,3)).toBe(true);
  });
});
