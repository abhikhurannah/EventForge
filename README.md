# EventForge

A React/TypeScript dashboard, Fastify API, MongoDB durable event store, and Redis/BullMQ worker for project-isolated event processing.

## Start locally

With Docker Desktop running, from this directory:

```sh
docker compose up --build
```

Open **http://localhost:5173**, create an account (password: 12+ characters), create a project, and create an API key. The secret is shown once. Use **Send event** or the curl example below. The dashboard polls every 10 seconds.

Local database connection strings, for tools running on your Mac:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/eventforge
REDIS_URL=redis://127.0.0.1:6379
```

Inside Docker Compose, the service hostnames are `mongo` and `redis`; the compose file already sets those URLs. No Atlas/Redis-provider account is needed locally. Local ports are bound to loopback; volumes persist across `docker compose down`. Do not add `-v` unless intentionally deleting local database data.

For development without containerizing the application:

```sh
docker compose up -d mongo redis
cp .env.example .env
npm install
npm run dev
```

Use Node 22.12 or newer. API and worker scripts load `.env` if it exists. Vite proxies `/api` to the local API. The API also accepts the requested `POST /events` path directly on port 3001.

## First event

```sh
curl http://localhost:3001/events \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_PROJECT_API_KEY' \
  -H 'idempotency-key: order-123' \
  -d '{"name":"order.created","payload":{"orderId":"123"},"priority":8}'
```

An accepted event returns `202` with a stable event/job ID. Same project, same idempotency key and same normalized content returns `200` with that ID. Changed content returns `409`. Keys are optional; requests without one create independent events. Concurrent duplicate requests are protected by a MongoDB partial unique index.

The reference processor accepts validated events; add domain-specific handlers in `server/processing.ts`. To demonstrate retries, send `{"failUntilAttempt":1}` as the payload: attempt two succeeds. `{"simulateFailure":true}` exhausts all three attempts. Retrying a permanently failing payload will fail again; manual retry is intended for failures whose underlying cause has been fixed.

## Reliability model

- The event document is also the durable dispatch record. API acceptance requires a successful MongoDB insert. A worker dispatcher enqueues pending records; Redis outages leave them available for later dispatch.
- Stable BullMQ IDs prevent duplicate dispatch. Queue entries are retained; removal/retention must preserve idempotency records before being introduced.
- Priority 10 is highest; all priorities map to BullMQ's positive-priority range.
- Jobs receive three processing attempts with exponential backoff (1s then 2s by default). Exponential delay is configurable with `RETRY_DELAY_MS` for tests.
- Exhausted records are marked `dead-letter`, then archived into a separate BullMQ queue. A durable pending flag retries archival after a crash.
- Manual retries require ownership and terminal state. They create a new generation under the same event ID. Historical dead-letter queue entries remain available.
- Successful event processing and webhook delivery are separate. A failed webhook does not rerun the event processor. A durable delivery flag closes the handoff gap.
- Webhook requests are signed, time-bounded and retried three times. Delivery history records attempt, HTTP status and a sanitized error code. Response bodies are deliberately not stored.
- Public IPv4 HTTPS destinations on port 443 only. DNS results are checked and the chosen address pinned for the TLS request; redirects are not followed.
- At-least-once processing/delivery: consumer side effects must be idempotent. The receiver should deduplicate `x-eventforge-id`, verify HMAC-SHA256 over `timestamp + "." + rawBody`, and reject stale timestamps. A crash after delivery but before acknowledgment may deliver twice.
- Redis uses AOF and `noeviction` locally. Loss of Redis data after dispatch still requires operational recovery; this is not an exactly-once system. No retention automation or multi-region failover is claimed.

## Authentication and tenant boundaries

Passwords use salted scrypt. Access JWTs expire after 15 minutes and remain in browser memory. Refresh tokens are random, hashed in MongoDB, rotated atomically on use, and transported in an HTTP-only, SameSite=Strict cookie. Production adds Secure. Refresh/logout require the configured Origin. API keys are hashed, shown once and revocable. Project ownership is checked for reads, retry actions, keys, metrics and AI suggestions.

Use a long random `JWT_SECRET` for production. The compose default is only for local development. All API paths other than auth, health and ingest require a user access token. Ingest requires an active project API key. The project limit defaults to 100 events/minute and is shared across its keys through Redis.

## Metrics

The overview uses events received in the last 24 hours. Counts, hourly intake, retry counts, successful-attempt processing duration and permanent failure rate are computed from MongoDB records. Latency is elapsed time from intake through success, including queue wait and backoff; processing duration covers the successful processing attempt. Empty datasets display zero counts and undefined rates/durations as `—`. Job listings cover all time and support paging/status filtering.

There are no seeded metrics or benchmark claims. The processor is a reference handler; production throughput depends on the domain handler, services and hardware.

## Optional AI

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the API's environment to enable the explicit failure explanation button. Choose a model enabled in your Google AI Studio account. Only allowlisted error codes, state and numeric attempt counts are sent. Raw logs, payloads, event names, URLs and identifiers are excluded. Output is labeled **Suggestion—not root cause**. AI is not required for processing.

## Checks

```sh
npm run lint
npm test
npm run build
docker compose up -d mongo redis
npm run test:integration
```

`lint` currently performs strict TypeScript checking. Unit tests cover request contracts, password hashing, sanitization, webhook destination checks and signatures. Integration tests require real MongoDB/Redis and cover auth/isolation, refresh replay, concurrent idempotency, unkeyed events, project rate limits, dispatch, retries, dead-letter behavior and key revocation. They use the database `eventforge_test` and a unique Redis queue prefix; they never flush a shared Redis instance.

CI runs unit and integration tests, type checking and the production web build. CI and Docker use `npm ci` with the included lockfile. The lockfile includes cached optional native-package manifests for other platforms; a clean online install should be verified on the deployment host.

## Deployment

Frontend: Vercel, build `npm run build`, output `dist`. API and worker: separate Render or Railway services from this repository; commands `npm run start:api` and `npm run start:worker`. Both require the same `MONGODB_URI` and `REDIS_URL`. Only the API needs `JWT_SECRET`, `WEB_ORIGIN`, and optional Gemini credentials.

Provision MongoDB Atlas and a Redis provider; copy their connection strings into the hosting services' secret/environment settings. Use TLS URLs and provider network controls. Never commit real credentials. The local URLs above do not work for remote hosting.

For browser authentication, route `/api/*` through the frontend origin to the API, or use same-site custom domains. Do not set VITE_API_URL to an unrelated Railway/Render domain and expect SameSite=Strict refresh cookies to work. `deploy/vercel.example.json` shows a same-origin proxy; replace its placeholder with the deployed backend origin and save it as `vercel.json` before deploying. Set `WEB_ORIGIN` to the exact frontend HTTPS origin. Keep VITE_API_URL empty for this configuration.

No cloud services have been provisioned, no secrets are included, and no public deployment is claimed.

## Source map

| File | Purpose |
|---|---|
| `server/app.ts` | Authentication, projects, API keys, ingest, inspection, retry and metrics routes |
| `server/db.ts` | MongoDB schemas and indexes |
| `server/core.ts` | Validation, canonical request hashing, password hashing, safe error metadata |
| `server/processing.ts` | Durable dispatch and processing/delivery handlers |
| `server/worker.ts` | BullMQ consumers, polling and shutdown |
| `server/webhooks.ts` | Destination validation, pinned HTTPS delivery and signing |
| `web/main.tsx` | Live dashboard and account flows |
| `web/api.ts` | In-memory access tokens and refresh retry |
| `tests/` | Unit and opt-in integration suites |

See `outputs/DEMO.md` for a four-minute recording script. A video has not been recorded yet.
