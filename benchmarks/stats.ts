export function summary(values: number[]) {
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid measurement');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

export function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return value;
}

export async function pool<T>(count: number, concurrency: number, task: (index: number) => Promise<T>) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid pool size');
  const results: T[] = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) { const i = next++; results[i] = await task(i); }
  }));
  return results;
}
