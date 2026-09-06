# EventForge benchmark guide

This is a local-only, reproducible load and correctness test—not a seed script that bypasses the API. It sends real HTTP requests and waits for actual MongoDB/BullMQ job outcomes. It does not target the Vercel/Render deployment.

## Run in the VS Code terminal

Start Docker Desktop first. From the repository root:

```sh
npm ci
npm run lint
npm test
docker compose -f compose.benchmark.yaml up -d --build --wait
docker compose -f compose.benchmark.yaml --profile verification run --rm integration
```

Stop if the integration suite fails; do not claim correctness from a load run alone. The `--wait` option starts the stack but the API may still be initializing. Check both endpoints before starting the benchmark:

```sh
curl --fail http://127.0.0.1:3011/api/health
curl --fail http://127.0.0.1:3012/api/health
npm run benchmark
```

Both health responses must be `{"ok":true}`. If either is unavailable, inspect startup rather than testing the main application:

```sh
docker compose -f compose.benchmark.yaml logs --tail=60 api rate-api worker
```

Allow several minutes on a laptop. The runner prints progress and an output directory such as `benchmarks/results/<UTC-timestamp>/`. Open **report.md** for the summary and **report.json** for raw measurements and environment details. Failed runs also produce diagnostic reports and exit nonzero. They are not publishable performance results.

The maintainer completed a passing local run on 7 September 2026: see the [retained report](published/2026-09-07-local-m2/report.md) and [raw samples](published/2026-09-07-local-m2/report.json). All three 500-event rounds and eight correctness probes passed; raw latency percentiles were checked independently. The agent session itself remains unable to access Docker/local listeners. The benchmark report does not include the separate integration suite's output, and a passing local burst run is not a claim of hosted capacity.

## Isolation and bounds

- Standalone Compose project: `eventforge-benchmark`; do not combine it with `compose.yaml`.
- MongoDB database: `eventforge_benchmark`; integration tests use `eventforge_test`.
- Redis namespace: `eventforge-benchmark`; dedicated Redis container, not the hosted provider.
- API ports: loopback-only 3011 and 3012. Database ports are not published.
- Synthetic accounts use `benchmark.invalid`, random passwords, new projects, and API keys held only in memory. No production `.env` is loaded.
- No webhook endpoint is configured, and no AI call is made. The existing integration suite stubs outbound webhook HTTP.
- Defaults: 500 events × 3 rounds, 10 concurrent HTTP requests, 20 excluded warm-up events, 5 event workers, 1-second initial retry delay.
- Hard bounds: 20–2,000 events/round, 1–5 rounds, 1–50 client concurrency, 10–600 seconds drain timeout per round. Requests time out after 15 seconds and are not automatically retried by the client.
- Load and drain polling have finite limits. Do not change the hardcoded endpoints to a public service without a separate scoped test plan.

The regular API defaults remain **120 requests/minute** and **100 events/project/minute**. The benchmark overrides both to 100,000/minute so they do not mask processing behavior. A second API instance uses a **2-event project quota** to exercise throttling across two keys. Never copy benchmark limits or its fixed test JWT secret into production.

An optional comparison run, after the default one passes:

```sh
BENCHMARK_EVENTS=1000 BENCHMARK_CONCURRENCY=20 BENCHMARK_REPEATS=3 npm run benchmark
```

This is a higher offered load, not a claim that the platform can sustain it. Keep all passing and failing reports when comparing settings. Restart the isolated stack between independent cold-environment comparisons; otherwise report that caches and data from previous runs remain.

## What is measured

| Result | Interpretation |
|---|---|
| Accepted requests/second | HTTP 202 count divided by elapsed submission time |
| Observed completions/second | Succeeded count divided by time from first submission through observed drain, including polling |
| HTTP percentiles | Client start through full response receipt; accepted-only and all-response distributions are separate |
| End-to-end percentiles | Stored intake-to-success latency from job records |
| Processing percentiles | Stored successful-attempt application timer, not isolated CPU time |
| Status counts | HTTP response codes; status 0 denotes a network error/timeout |
| Unique accepted IDs | Duplicate-detection check for the unique-event workload |
| Environment | Git commit, dirty state, source/config hash, host CPU/RAM/architecture, Node, Docker allocation and image identifiers when available |

Percentiles use the nearest-rank method. The report preserves numeric raw samples without credentials, cookies, payloads, or API keys. Throughput rounds require all requests accepted, all unique IDs, all jobs succeeded, and complete timing samples. Otherwise the run fails rather than hiding errors from its success rate.

## Correctness probes

After throughput rounds, the runner checks:

1. Twenty concurrent identical requests yield exactly one newly accepted event and nineteen duplicate responses, with one stored event.
2. Different content using the same key returns 409.
3. Five transient failures succeed with exactly two attempts each.
4. Five permanent failures exhaust three attempts and finish dead-letter archival.
5. A manual retry increments generation and records six cumulative attempts for a still-permanently-failing fixture.
6. Two API keys share the same project quota: 202, 202, then 429.
7. Missing API-key authentication returns 401.
8. Another account cannot read an owned project (404).

This does not test crash recovery, Redis data loss, priority fairness under sustained load, real receiver delivery, or AI behavior. Use separate fault-injection and external integration tests before claiming those outcomes.

## Interpreting results honestly

The workload is **closed-loop**: each client sends another request after its previous response. It can underrepresent an overloaded system's latency because arrivals slow down as responses slow down (coordinated omission). It is not a fixed arrival-rate stress test or an estimate of maximum capacity.

The reference processor performs very little domain work. Load generation, Docker services, logs, and polling share laptop resources. Host RAM is not the same as Docker's assigned RAM. Warm-up excludes initial startup; free-tier cold starts and cloud network latency are not represented. Later rounds also run against a growing dataset and retained queue history.

Report all repetitions and their configuration. Never turn the fastest round into a universal requests-per-second claim. Do not equate a short zero-error test with uptime, exactly-once processing, or production reliability.

## Publish to README and resume

Only publish a report with `outcome: passed`, all measured rounds passing, and all correctness checks passing. Review the separate integration output too. Keep the run size, concurrency, environment, and reference-handler qualifier beside the metrics.

Raw result directories are gitignored intentionally. To preserve one reviewed run, explicitly force-add only its two reports:

```sh
git add -f benchmarks/results/YOUR-RUN-TIMESTAMP/report.md benchmarks/results/YOUR-RUN-TIMESTAMP/report.json
```

Replace the timestamp first. Link that report from the README's load-test section and replace its pending status with the actual table. Share the report with the project maintainer/assistant to derive precise resume bullets; do not paste API keys or container secrets.

See [resume wording guidance](../outputs/RESUME-BULLETS.md). Keyword relevance helps explain the work, but no ATS score or recruiting outcome can be guaranteed.

## Stop and clean up

```sh
docker compose -f compose.benchmark.yaml down
```

This stops/removes only the benchmark stack's containers and network. The setup has no named data volumes; anonymous image volumes can remain on disk. To intentionally remove the benchmark stack's attached anonymous database volumes as well, use `docker compose -f compose.benchmark.yaml down -v` while removing that stack. This permanently deletes those benchmark fixtures, not your separately named application stack. Keep reports before removing containers if logs are needed.
