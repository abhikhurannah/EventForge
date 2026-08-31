# EventForge

EventForge is a multi-tenant event-processing and job-queue API with priority queues, idempotency, retries, dead-letter handling, webhook delivery, and AI-assisted failure explanations for developers.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Features](#features)
- [How it works](#how-it-works)
  - [Event ingestion](#event-ingestion)
  - [Idempotency](#idempotency)
  - [Priority queue](#priority-queue)
  - [Worker processing & retries](#worker-processing--retries)
  - [Dead-letter queue](#dead-letter-queue)
  - [Webhook delivery](#webhook-delivery)
  - [Rate limiting](#rate-limiting)
  - [AI failure explanation](#ai-failure-explanation)
- [Project structure](#project-structure)
- [API reference](#api-reference)
- [Data model](#data-model)
- [Setup](#setup)
  - [Run with Docker Compose](#run-with-docker-compose)
  - [Run manually](#run-manually)
  - [Environment variables](#environment-variables)
  - [Seeding a demo project](#seeding-a-demo-project)
- [Testing](#testing)
- [CI](#ci)
- [Deployment notes](#deployment-notes)
- [Current status & known gaps](#current-status--known-gaps)
- [Roadmap](#roadmap)

---

## Architecture

```
                    ┌─────────────┐
  HTTP clients ───▶ │   API (Fastify)  │──┐
  (curl, SDKs)      │  apps/api        │  │  writes Event + JobRecord
                    └─────────────┘  │
                            │             │
                     enqueue job          ▼
                            │        ┌───────────┐
                            ▼        │  MongoDB   │
                    ┌─────────────┐  │ (Atlas /   │
                    │    Redis     │  │  local)    │
                    │  (BullMQ)    │  └───────────┘
                    │ "events"     │        ▲
                    │  queue       │        │ status/latency/error
                    └─────────────┘        │ updates per job
                            │               │
                            ▼               │
                    ┌─────────────┐        │
                    │   Worker     │────────┘
                    │ apps/worker  │
                    └─────────────┘
                            │
                    on final failure
                            ▼
                    ┌─────────────┐
                    │ "dead-letter"│
                    │    queue     │
                    └─────────────┘

                    ┌─────────────┐
                    │  Web (React) │──▶ API (dashboard, job list, send-event UI)
                    │  apps/web    │
                    └─────────────┘
```

Three deployable units share one repo as an npm workspaces monorepo:

- **`apps/api`** — Fastify HTTP API. Validates and authenticates incoming events, persists `Event`/`JobRecord` documents, enqueues jobs onto a BullMQ queue, and serves the dashboard's read endpoints (`/jobs`, `/metrics/:projectId`, `/jobs/:jobId/explain`).
- **`apps/worker`** — A standalone BullMQ `Worker` process. Pulls jobs off the `events` queue, executes the job's side effects (currently: an optional webhook delivery, or a simulated failure for demo purposes), and writes the outcome back to MongoDB. On the final failed attempt, it copies the job onto a `dead-letter` queue.
- **`apps/web`** — A React + TypeScript + Tailwind-flavored dashboard for viewing jobs, metrics, and sending test events.

API and worker are independent processes so the queue keeps draining even if the API restarts, and so you can scale ingestion and processing separately.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind config present, `lucide-react` icons |
| API | Node.js + TypeScript + Fastify 5 |
| Database | MongoDB (Mongoose ODM) |
| Queue / cache | Redis + BullMQ |
| Auth | `@fastify/jwt` (access + refresh token pattern), SHA-256-hashed per-project API keys |
| DevOps | Docker Compose for local dev, GitHub Actions for CI |
| Deployment target | Vercel (frontend) + Render/Railway (API + worker) + MongoDB Atlas + a managed Redis provider |
| Testing | Vitest + Supertest |
| AI | Google Gemini API (`generateContent`), used only for failure-log summarization |

## Features

Status reflects what's actually implemented and working today, not the target design.

| # | Feature | Status |
|---|---|---|
| 1 | Projects, API keys | ✅ Create a project, get a one-time API key back (SHA-256 hashed at rest) |
| 1 | User auth (login/registration, JWT-protected routes) | ⚠️ Stubbed — `/auth/demo` issues tokens for a hardcoded user; no route currently requires a valid token |
| 2 | `POST /events` with validation | ✅ Zod schema validates `name`, `payload`, `priority` |
| 3 | Idempotency keys | ✅ Unique per-project index + race-safe duplicate handling on concurrent requests |
| 4 | Redis-backed priority queue | ✅ BullMQ `events` queue, priority 1–10 mapped to BullMQ priority |
| 5 | Worker processing with exponential retry | ✅ 3 attempts, exponential backoff, status written back to MongoDB |
| 6 | Dead-letter queue | ✅ Permanently-failed jobs land on a separate `dead-letter` queue and are marked `dead-letter` in `JobRecord` |
| 7 | Rate limiting per project/API key | ⚠️ Partial — one global rate limiter keyed by `x-api-key` or IP, not per-project configurable |
| 8 | Job dashboard (queued/running/succeeded/failed, latency, retries) | ⚠️ UI exists but currently renders static placeholder data — not yet wired to `/jobs` and `/metrics` |
| 9 | Webhook delivery with delivery logs and retry status | ✅ Delivery attempts are logged to a `Delivery` collection with status/response code/error |
| 10 | AI failure explanation, labeled "suggestion — not root cause" | ✅ Calls Gemini on sanitized logs; falls back to a clear "not configured" message with no key |
| 11 | Docker Compose | ✅ MongoDB, Redis, API, worker, web all start with `docker compose up` |
| 12 | Tests (auth, idempotency, retry, rate limit, failed-job) | ⚠️ Minimal — one schema-validation test exists; the listed behaviors aren't covered yet |
| 13 | GitHub Actions (lint, test, build) | ✅ Runs on push/PR |
| 14 | Demo video | ⏳ Not yet recorded — see [Demo outline](#deployment-notes) |

## How it works

### Event ingestion

`POST /events` requires an `x-api-key` header. The key is hashed with SHA-256 and matched against the project's stored `apiKeyHash` — raw keys are never stored. The request body is validated with Zod:

```ts
{
  name: string,        // lowercase, e.g. "order.fulfilled" — must match /^[a-z][a-z0-9_.-]+$/
  payload: object,      // arbitrary JSON, defaults to {}
  priority: number       // 1–10, defaults to 5
}
```

A valid request creates an `Event` document, enqueues a BullMQ job, and creates a `JobRecord` document (status `queued`) that the dashboard/API reads from thereafter. The response returns `202` with the event id, job id, and status.

### Idempotency

Pass an `idempotency-key` header to make retried client requests safe. The flow:

1. Look up an existing `Event` for this project + idempotency key. If found, return the original job id with `duplicate: true` and a `200` (not `202`).
2. Otherwise, try to create a new `Event`. A unique, sparse Mongo index on `(projectId, idempotencyKey)` guarantees at most one event per key per project.
3. If two requests race and both pass step 1 before either finishes step 2, the second `create()` fails with Mongo duplicate-key error `11000`. That's caught, and the handler falls back to looking up and returning the winning event — so concurrent duplicate sends never create two jobs and never 500.

### Priority queue

BullMQ priority is inverted from the API's priority field (`11 - priority`), so a caller-supplied priority of `10` (highest) becomes BullMQ priority `1` (processed first). Priority only affects ordering among currently-queued jobs, not preemption of jobs already running.

### Worker processing & retries

The worker process (`apps/worker`) is a separate BullMQ `Worker` listening on the same `events` queue, with its own MongoDB connection so it can update job state directly. For each job it:

1. Marks the `JobRecord` `running` and records the attempt number.
2. Runs the job's side effect — currently: deliver a webhook if the project has one configured, or throw if `payload.simulateFailure` is set (for demos).
3. On success, marks the record `succeeded` with `latencyMs` and `completedAt`.
4. On failure, BullMQ automatically retries with exponential backoff (3 attempts total, defined in `apps/api/src/queue.ts`'s `defaultJobOptions`). Each failed attempt updates the `JobRecord` to `failed` with the sanitized error message and stack.

### Dead-letter queue

When the worker's `failed` event fires and `attemptsMade` has reached the job's configured `attempts` limit, the job is:

- Marked `dead-letter` (not `failed`) in `JobRecord`, so `GET /jobs?status=dead-letter` returns exactly the permanently-failed jobs.
- Copied onto a separate BullMQ `dead-letter` queue, preserving the original payload plus the failing error message, so it can be inspected or manually replayed independently of the live `events` queue.

### Webhook delivery

If a project has a `webhookUrl`, the worker POSTs the event (id, name, payload) to it with an `x-eventforge-event` header on every successful queue attempt. Each attempt writes a `Delivery` document (`url`, `status: pending|delivered|failed`, `attempts`, `responseCode`, `lastError`) so delivery history is queryable independently of the job's own retry count. A non-2xx response or network error marks the delivery `failed` and re-throws, which feeds back into BullMQ's normal retry/backoff behavior for the job.

### Rate limiting

`@fastify/rate-limit` is registered globally: 100 requests/minute, keyed by `x-api-key` when present, otherwise by IP. This protects the API as a whole today; it is not yet scoped to per-project configurable limits (see [Known gaps](#current-status--known-gaps)).

### AI failure explanation

`POST /jobs/:jobId/explain` reads the job's stored error, runs it through `sanitizeLog()` (strips bearer tokens, API keys, passwords, and email addresses, and truncates to 6,000 characters) before it goes anywhere near a third-party API, then sends it to Gemini (`generateContent`) with a system instruction that explicitly tells the model to give hypotheses only, never claim a root cause, and treat the log as untrusted data rather than instructions. The response is always returned with `"label": "Suggestion—not root cause"`. If `GEMINI_API_KEY` isn't set, the endpoint returns a clear "not configured" message instead of failing.

## Project structure

```
eventforge/
├── apps/
│   ├── api/                 # Fastify HTTP API
│   │   └── src/
│   │       ├── server.ts    # routes: /projects, /events, /jobs, /jobs/:id/retry, /jobs/:id/explain, /metrics/:id
│   │       ├── models.ts    # Mongoose schemas: Project, Event, JobRecord, Delivery
│   │       ├── queue.ts     # BullMQ queue + Redis connection
│   │       └── seed.ts      # seeds a demo project + API key
│   ├── worker/               # BullMQ worker process
│   │   └── src/worker.ts
│   └── web/                  # React dashboard
│       └── src/main.tsx
├── docker-compose.yml
├── .github/workflows/ci.yml
├── eslint.config.js
├── tsconfig.base.json
└── .env.example
```

## API reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Liveness check |
| `POST` | `/auth/demo` | none | Issues a demo JWT + refresh token |
| `POST` | `/projects` | none | Creates a project, returns the one-time raw API key |
| `POST` | `/events` | `x-api-key` | Ingests an event, enqueues a job |
| `GET` | `/jobs` | — | Lists jobs; filter with `?projectId=&status=` |
| `POST` | `/jobs/:jobId/retry` | — | Re-queues one specific failed job |
| `POST` | `/jobs/:jobId/explain` | — | Gemini-generated debugging suggestion for a failed job |
| `GET` | `/metrics/:projectId` | — | Aggregate job counts and average latency by status |

Example event submission:

```bash
curl -X POST http://localhost:3001/events \
  -H 'x-api-key: ef_your_key' \
  -H 'idempotency-key: checkout-123' \
  -H 'content-type: application/json' \
  -d '{"name":"order.fulfilled","payload":{"orderId":"ord_9281"},"priority":8}'
```

## Data model

| Collection | Purpose |
|---|---|
| `Project` | Tenant record: name, slug, hashed API key, webhook URL |
| `Event` | One per accepted `POST /events` call; unique on `(projectId, idempotencyKey)` |
| `JobRecord` | Tracks a job's lifecycle: `queued → running → succeeded / failed / dead-letter`, attempts, latency, error |
| `Delivery` | One row per webhook delivery attempt: url, status, response code, last error |

## Setup

### Run with Docker Compose

```bash
cp .env.example .env
docker compose up
```

- API: `http://localhost:3001`
- Web dashboard: `http://localhost:5173`
- MongoDB and Redis run as containers with persisted volumes.

Each service (`api`, `worker`, `web`) runs `npm install` on its own anonymous `node_modules` volume layered over the shared source bind-mount, so the three containers don't race each other writing into a single shared `node_modules`.

### Run manually

Requires Node 22+, a local or remote MongoDB, and a local or remote Redis.

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, REDIS_URL, JWT_SECRET, GEMINI_API_KEY

npm run dev             # starts web + api + worker together via concurrently
# or run one at a time:
npm run dev -w @eventforge/api
npm run dev -w @eventforge/worker
npm run dev -w @eventforge/web
```

### Environment variables

| Variable | Used by | Description |
|---|---|---|
| `MONGODB_URI` | api, worker | MongoDB connection string |
| `REDIS_URL` | api, worker | Redis connection string |
| `JWT_SECRET` | api | Signing secret for access/refresh tokens |
| `WEB_ORIGIN` | api | Allowed CORS origin for the dashboard |
| `GEMINI_API_KEY` | api | Enables `/jobs/:jobId/explain`; omit to disable AI explanations cleanly |
| `GEMINI_MODEL` | api | Defaults to `gemini-2.0-flash` |
| `PORT` | api | Defaults to `3001` |
| `WORKER_CONCURRENCY` | worker | Concurrent jobs per worker process, defaults to `10` |

**Never commit a real value for `GEMINI_API_KEY` (or any secret) into `.env.example` or any tracked file.** `.env.example` should only ever contain placeholders; real values belong in an untracked `.env`.

### Seeding a demo project

```bash
npm run seed -w @eventforge/api
```

Creates (or updates) a demo project `Acme Commerce` with a fixed API key (`ef_demo_acme_key`) so you can hit `/events` immediately without going through `POST /projects` first.

## Testing

```bash
npm test               # runs vitest across all workspaces
npm test -w @eventforge/api
```

Current coverage is limited to event-name schema validation. Auth, idempotency-under-concurrency, retry targeting, rate limiting, and dead-letter behavior are not yet covered by automated tests — see [Roadmap](#roadmap).

## CI

`.github/workflows/ci.yml` runs on every push and pull request: `npm ci` → `npm run lint` → `npm test` → `npm run build`. `eslint.config.js` (flat config, ESLint 9) is required for the lint step to run at all.

## Deployment notes

- Use a strong, unique `JWT_SECRET` in production.
- API keys are already hashed at rest (SHA-256) — the raw key is shown to the user exactly once, at project creation.
- Set `WEB_ORIGIN` to your deployed frontend's origin.
- Host MongoDB and Redis as managed services (MongoDB Atlas, a managed Redis provider) rather than the Docker Compose containers.
- Webhook payloads are not yet HMAC-signed — treat this as a prerequisite before sending webhooks to third parties in production.
- AI log explanation is already gated behind an explicit endpoint, sanitizes logs before sending them out, and labels every response as a suggestion, not a root cause — keep that framing if you extend the feature.

### Demo outline (3–5 minutes)

1. Create a project and copy the generated API key.
2. Publish an `order.fulfilled` event and show it enter the Jobs view.
3. Re-send it with the same idempotency key to show no duplicate is made.
4. Publish an event with `simulateFailure: true`, point out the retry attempts, then show the resulting dead-letter job.
5. Show throughput, latency, retry, and failure metrics — pulled live from `/metrics/:projectId`, not hardcoded.

## Current status & known gaps

Be upfront about these if you're presenting this project — they're the difference between "prototype" and "production-ready":

- **Auth is not enforced.** `@fastify/jwt` is registered but no route currently checks for a valid token; `/projects` and other endpoints are open to anyone who can reach the API.
- **No real user accounts.** `Project.ownerId` references a `User` model that doesn't exist yet — there's no registration, login, or password handling.
- **Dashboard isn't wired to live data yet.** The React UI currently renders fixed placeholder numbers and a static job list; "Send event" shows a toast without calling the API. `GET /jobs` and `GET /metrics/:projectId` are functional and ready to be consumed.
- **Rate limiting is global, not per-project.** There's no per-project limit configuration or storage.
- **No webhook signing.** Webhook deliveries aren't HMAC-signed, so receivers can't verify authenticity.
- **Test coverage is thin.** Only event-name validation is tested; the behaviors called out in the spec (auth, idempotency under concurrency, retry, rate limiting, dead-letter) need dedicated Vitest + Supertest suites against `buildApp()`.

## Roadmap

1. Enforce JWT auth on project-management routes; add real user registration/login.
2. Wire the dashboard to `GET /jobs`, `GET /metrics/:projectId`, and a real `POST /events` call from the "Send event" modal.
3. Per-project rate-limit configuration, stored on the `Project` document.
4. HMAC-sign webhook payloads; add a webhook secret rotation endpoint.
5. Test suite: auth, idempotency race, targeted retry, rate limiting, dead-letter transition — all against the real `buildApp()` + an in-memory or test Mongo/Redis instance.
6. Record the 3–5 minute demo video once the dashboard is live-wired.