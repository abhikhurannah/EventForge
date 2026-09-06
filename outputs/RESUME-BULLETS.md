# EventForge resume wording

Use precise engineering terms that match a target role. ATS matching depends on the job description and resume formatting; a numeric ATS score cannot be promised.

## Supported by the implementation

- Built a multi-tenant event-processing platform with React, TypeScript, Fastify, MongoDB, Redis, and BullMQ; implemented project-scoped API keys, idempotent ingestion, priority queues, exponential retries, and dead-letter recovery.
- Implemented rotating HTTP-only refresh sessions, owner-scoped authorization, shared project rate limits, and HMAC-signed webhook delivery with independent retries; deployed the frontend on Vercel and backend on Render.
- Built a job dashboard for processing states, retry/failure rates, and intake-to-completion latency, with Docker Compose environments and GitHub Actions test/build automation.

Choose two or three bullets; do not cram every technology into each sentence. The deployment is a demo, not an audited production service. The webhook code is implemented; external delivery success must be tested separately before describing it as verified.

## Measured local benchmark result

Evidence: [passing report](../benchmarks/published/2026-09-07-local-m2/report.md), 7 September 2026. Three 500-event bursts on a local Apple M2 Docker stack, client concurrency 10 and worker concurrency 5. All 1,500 measured events succeeded; eight correctness probes passed. This does not include a verified result for the separate integration suite.

Suggested measured bullet:

> Load-tested a TypeScript/BullMQ reference event processor with 1,500 events across three local Docker bursts at 10 concurrent requests; measured 404–712 accepted requests/s and 31–57 ms p95 ingestion latency, with all measured events completing successfully.

Optional reliability-focused bullet:

> Verified concurrent idempotency (20 duplicate requests → one stored event), exponential retry and dead-letter archival, shared API-key quotas, and tenant isolation through eight automated HTTP correctness probes against MongoDB and Redis.

Keep the local/reference-handler qualifier. If discussing worker performance, report **65–72 observed completions/s** and **5.04–5.36 s p95 intake-to-success latency** alongside the ingestion numbers. These short tests do not establish sustained throughput, production capacity, uptime, or exactly-once processing.

## Wording for future runs

After running `npm run benchmark`, derive a bullet using this structure (replace every bracketed field with evidence from the retained report):

> Load-tested the reference event handler across [rounds] local Docker runs of [events] events at [client concurrency] concurrent requests, observing [range] accepted requests/s and [range] p95 intake-to-completion latency; verified duplicate suppression, retry exhaustion, and project isolation with automated probes.

Use the range across all passing repetitions, distinguish accepted HTTP throughput from completed-job throughput, and retain the local/reference-handler qualifier. Include expected injected failures separately from unexpected errors. Omit any probe that failed.

Evidence to retain: report.md, report.json, integration-test output, commit/source hash, worker concurrency, rate-limit overrides, and hardware/Docker resource allocation.
