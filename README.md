# URL shortener

A backend learning project, built in small, reviewable increments.
Commit the reviewed baseline before each increment, then review the next change as a diff.

## Current checkpoint

Phase 1, increment 2: Fastify owns a Postgres connection pool. `/healthz` checks
that the HTTP service responds; `/readyz` checks that it can query Postgres.

## Run locally

Prerequisites: Node.js 26.13.0, pnpm 12.18.0, Colima, Docker CLI, and Docker Compose.

```sh
colima start
test -f .env || cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm dev
```

The server listens on `127.0.0.1:3000`. In another terminal:

```sh
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz

docker compose exec postgres psql -U shortener -d shortener -c 'SELECT 1 AS connected;'
```

If you already have a `.env` from increment 1, add `DATABASE_URL` from
`.env.example` and adjust it if you changed the local database credentials.
Fastify reads the root `.env` in development and accepts `DATABASE_URL` from the
environment when deployed.

To see the difference between the two probes, run `docker compose stop postgres`
while Fastify is running. `/healthz` stays `200`; `/readyz` returns `503`. Run
`pnpm db:up` to bring Postgres back and check that `/readyz` returns `200` again
without restarting Fastify.

## Review the scaffold

- `apps/redirect-service/src/app.ts` creates the Fastify instance and defines routes.
  It creates one pool shared across requests and closes it in `onClose`, after
  active HTTP requests finish. `/readyz` runs `SELECT 1` through this pool.
- `apps/redirect-service/src/database.ts` validates the database URL and configures
  the pool. Connections open on demand, up to five per app instance. The driver
  limits the wait for a connection and for a query result to 500 ms each. Start with
  these local settings and revisit them when measuring redirect load.
- `apps/redirect-service/src/server.ts` opens the HTTP port and closes the app on
  SIGINT (Ctrl+C) or SIGTERM. Its `.js` import points to the JavaScript file that
  TypeScript emits; `tsx` also resolves it during development.
- `compose.yaml` runs Postgres on the Mac's loopback port 5432. The app runs on the
  Mac, so it will connect to `127.0.0.1:5432`. A container on the same Compose
  network would use `postgres:5432` instead.
- The `postgres_data` Docker volume persists database files when the container is
  replaced. Postgres 18 stores its data beneath `/var/lib/postgresql`.
- `.env` supplies the initialization credentials to Compose and the connection
  URL to Fastify. Git ignores it. Changing the initialization credentials later
  does not change users in an existing volume.
- `pnpm-workspace.yaml` discovers apps and future shared packages. The pool lives
  in the redirect service for now; we can extract shared database code when it
  has another consumer.
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

`SELECT 1` confirms connectivity. It does not verify that the links table exists.
The next increment introduces the schema and its first migration.

References: [Fastify app/server separation](https://fastify.dev/docs/latest/Guides/Testing/),
[node-postgres pooling](https://node-postgres.com/features/pooling),
[Postgres image configuration](https://hub.docker.com/_/postgres).
