# EventForge local benchmark — 2026-09-06T19:22:49.649Z

Outcome: **passed**. Only passing runs are eligible for performance claims.

Real HTTP against isolated Docker services; reference handler; 500 unique events per measured round, 3 rounds, client concurrency 10, worker concurrency 5. One 20-event warm-up is excluded.

## Environment

- Commit: 1783a928a091b2635fd480e8c6269e0a5c52aef5
- Dirty working tree: true
- Source/config SHA-256: 03f6d2b1be736a807c5e6bfe09a592363546181ae879602aee206ff03071ffcb
- Host: darwin/arm64; Apple M2; 8 logical CPUs; 8.0 GiB RAM
- Load generator: v24.19.0
- Docker allocation and image identifiers: see report.json.

## Measured rounds

| Round | Accepted / sent | Succeeded | Accepted req/s | Observed completions/s | HTTP p95 ms (202 only) | E2E p95 ms | E2E p99 ms | Processing p95 ms |
|---|---|---|---|---|---|---|---|---|
| Round 1 | 500/500 | 500 | 496.77 | 65.47 | 32.58 | 5363.00 | 5368.00 | 4.00 |
| Round 2 | 500/500 | 500 | 403.80 | 65.33 | 56.71 | 5106.00 | 5120.00 | 6.00 |
| Round 3 | 500/500 | 500 | 711.64 | 71.99 | 31.45 | 5036.00 | 5050.00 | 3.00 |

HTTP latency measures request start through response body receipt. End-to-end latency comes from stored event timestamps; processing timing is the app's successful-attempt timer. Observed completion rate includes drain polling and is not steady-state maximum worker throughput. Nearest-rank percentiles; raw samples and status counts are in report.json.

## Correctness probes

- PASS: Warm-up
- PASS: Round 1
- PASS: Round 2
- PASS: Round 3
- PASS: 20 concurrent identical requests create one event
- PASS: Reused key with changed payload returns 409
- PASS: 5 transient failures succeed on attempt 2
- PASS: 5 permanent failures exhaust 3 attempts and complete archival
- PASS: Manual retry creates generation 1 and preserves cumulative attempts
- PASS: Project quota is shared across two API keys
- PASS: Ingestion without API key returns 401
- PASS: Another account cannot inspect benchmark project

## Limitations

Closed-loop clients slow down when responses slow down (coordinated omission); this is not an arrival-rate stress test. Raised benchmark-only limits (100,000/minute) differ from production defaults. A separate API applies a 2/minute project limit to verify throttling. Logs remain enabled. The load generator and services share a host; Docker CPU/memory allocation, warm caches, polling, networking and background host load affect results. No external webhook delivery, AI, uptime, multi-region, production capacity or exactly-once guarantee is measured. HTTP errors (including timeouts as status 0) and incomplete drains invalidate a round. No retries of load-generator requests.

Do not describe a local result as hosted throughput. Compare multiple passing runs under the same recorded environment; do not select only the fastest run.
