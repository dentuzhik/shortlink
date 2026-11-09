# URL shortener

A backend learning project, built in small, reviewable increments.

## Current checkpoint

Phase 1, increment 1: Fastify and Postgres run independently. The service exposes
`GET /healthz` and writes structured JSON logs using Fastify's built-in Pino logger.
There is no database connection in the service yet.

## Run locally

Prerequisites: Node.js 26.13.0, pnpm 12.18.0, Colima, Docker CLI, and Docker Compose.

```sh
colima start
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm dev
```

The server listens on `127.0.0.1:3000`. In another terminal:

```sh
curl http://127.0.0.1:3000/healthz
# {"status":"ok"}

docker compose exec postgres psql -U shortener -d shortener -c 'SELECT 1 AS connected;'
```

The SQL command checks Postgres directly. `/healthz` only confirms that the HTTP
service responds; it does not check Postgres. Database readiness will be a separate
endpoint once the service owns a database connection pool.

## Review the scaffold

- `apps/redirect-service/src/app.ts` creates the Fastify instance and defines routes.
  Calling `buildApp()` does not open a network port.
- `apps/redirect-service/src/server.ts` opens the HTTP port and closes the app on
  SIGINT (Ctrl+C) or SIGTERM. Its `.js` import points to the JavaScript file that
  TypeScript emits; `tsx` also resolves it during development.
- `compose.yaml` runs Postgres on the Mac's loopback port 5432. The app runs on the
  Mac, so it will connect to `127.0.0.1:5432`. A container on the same Compose
  network would use `postgres:5432` instead.
- The `postgres_data` Docker volume persists database files when the container is
  replaced. Postgres 18 stores its data beneath `/var/lib/postgresql`.
- `.env` supplies local database initialization credentials to Compose and is
  ignored by Git. Changing them later does not change users in an existing volume.
- `pnpm-workspace.yaml` discovers apps and future shared packages. We will add
  `packages/db` when we introduce the connection pool and schema.
- Dependencies use exact versions; `pnpm-lock.yaml` records transitive dependencies.

## Check and build

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

`pnpm dev` uses `tsx` to run TypeScript and restart on edits. `pnpm build` uses
`tsc` to emit JavaScript into `dist/`; `pnpm start` runs that output with Node.
Stop the development server before starting the compiled server on the same port.

## Stop locally

Press Ctrl+C in the server terminal, then:

```sh
pnpm db:down
colima stop
```

`db:down` retains the data volume. `docker compose down --volumes` deletes local
database data and should only be used when intentionally resetting it.

## Next review checkpoint

Before wiring Fastify to Postgres, discuss connection pooling: one bounded pool per
app instance, shared across requests, with startup verification and cleanup when
Fastify closes. After that review, add the database package and `/readyz`, then
introduce the schema, migrations, and link endpoints in later increments.

References: [Fastify app/server separation](https://fastify.dev/docs/latest/Guides/Testing/),
[Postgres image configuration](https://hub.docker.com/_/postgres).
