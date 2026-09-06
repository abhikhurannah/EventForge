import { describe, it, expect } from 'vitest';
import { summary, boundedInteger, pool } from '../benchmarks/stats';

describe('benchmark measurement helpers', () => {
  it('computes nearest-rank percentiles without mutating samples', () => {
    const samples = [100, ...Array.from({length: 99}, (_, i) => i + 1)];
    expect(summary(samples)).toEqual({count:100, mean:50.5, p50:50, p95:95, p99:99, max:100});
    expect(samples[0]).toBe(100);
  });
  it('does not manufacture latency values for missing samples', () => {
    expect(summary([])).toEqual({count:0,mean:null,p50:null,p95:null,p99:null,max:null});
    expect(summary([7]).p99).toBe(7);
  });
  it('rejects invalid timing data', () => {
    for (const n of [NaN, Infinity, -1]) expect(() => summary([n])).toThrow();
  });
  it('bounds workload settings', () => {
    expect(boundedInteger(undefined,500,1,5000)).toBe(500);
    for(const n of ['0','5001','2.5','oops','']) expect(()=>boundedInteger(n,500,1,5000)).toThrow();
  });
  it('executes each input once with bounded concurrency and ordered output', async () => {
    let active=0, peak=0;
    const results=await pool(11,3,async i=>{
      active++;peak=Math.max(peak,active);
      await new Promise(r=>setTimeout(r,2));active--;return i*2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual(Array.from({length:11},(_,i)=>i*2));
  });
  it('rejects invalid pool configuration', async () => {
    await expect(pool(0,1,async()=>0)).rejects.toThrow();
  });
});
