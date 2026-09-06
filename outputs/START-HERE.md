# Run EventForge

Open Terminal:

```sh
cd /Users/abhaykumar/Documents/Codex/2026-08-31/eventforge-build-a-multi-tenant-event
docker compose up --build
```

Open http://localhost:5173. Register, create a project, generate an API key, then send an event. The dashboard uses real database records only.

## Your local connection strings

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/eventforge
REDIS_URL=redis://127.0.0.1:6379
```

Docker Compose already supplies the corresponding internal service URLs. You do not need cloud accounts for local development.

To run application code directly on your Mac instead:

```sh
docker compose up -d mongo redis
cp .env.example .env
npm install
npm run dev
```

## Verification

```sh
npm run lint
npm test
npm run build
npm run test:integration
```

Integration tests require MongoDB/Redis running. They select an isolated test database and queue namespace.

## Hosted connection strings later

- MongoDB Atlas: create a cluster and database user, configure network access, then use Connect → Drivers to copy the URI. Replace its password placeholder and select the application database.
- Your Redis provider: create a Redis database and copy its Redis/TLS connection URL. BullMQ needs a Redis protocol URL such as `rediss://...`, not an HTTP REST endpoint.

Enter those values in your API/worker hosting environment. Keep them out of Git and chat. See the main README for frontend proxy/cookie configuration.
