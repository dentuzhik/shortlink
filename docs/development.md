# Local development

[Project overview](../README.md) · Run commands from the repository root.

## Learning workflow

This project is built in small, reviewable increments. Commit the reviewed
baseline before the next change. Release images need a committed source SHA;
review those changes using the recorded commit range in the delivery guide.

## Run the whole stack in Docker

With Colima running and Docker Compose and Buildx installed:

```sh
pnpm stack:up
```

Open [Shortlink](http://127.0.0.1:3101). The containerized Fastify server is on
`127.0.0.1:3100`, so the existing host dev servers can keep using ports 3000
and 3001. Compose starts Postgres, waits for the migration container to finish,
then starts Fastify and Next.js. A first run copies `.env.example` to `.env`
if needed. `pnpm stack:down` stops the stack and keeps the Postgres volume.

Inside the Docker network, Fastify reaches `postgres:5432` and Next.js
forwards `/graphql` to `redirect-service:3000`. The browser sees host ports;
containers talk to each other by service name. The same internal service names
are used in Kubernetes. The Kubernetes build sets a different public short-link
address for the browser bundle.

The Compose stack gives Fastify a Redis cache at `redis://redis:6379`.
Successful redirect lookups are cached for 60 seconds. When a Redis read misses
or fails, Fastify falls back to Postgres. Concurrent fallbacks for the same code
share a lookup within each Fastify process. The request that starts the lookup
also fills the cache if its Redis read confirmed a miss.
Set `REDIS_CACHE_HEADER=1` when running `pnpm stack:up` to see `X-Cache: HIT`
on a Redis hit or `X-Cache: COALESCED` on a redirect that waited for another
request's lookup. Set `REDIS_URL` to an empty value to disable caching in Compose.

Each Fastify process opens its Redis read circuit after five consecutive read
errors or timeouts. For one second, requests go directly to the coalesced
Postgres fallback. After the cooldown, one request probes Redis while concurrent
requests continue through the fallback. A successful reply, including a cache
miss, closes the circuit. A failed probe starts another one-second cooldown.
Open and closed transitions are logged. Replies from earlier attempts can
complete their own requests while recovery proceeds independently.

Redirects that need Postgres return `503` when the pool has 128 waiting
checkouts or when acquiring a connection takes 50 ms. Configure these per-process
limits with `REDIRECT_DB_MAX_WAITERS` and `REDIRECT_DB_CHECKOUT_TIMEOUT_MS`.
Cache hits and requests sharing an existing lookup bypass checkout. Link
creation uses the same pool and its normal checkout path.

After a redirect's checkout deadline expires, pg can retain its waiter until a
connection arrives or pg's own timeout fires. The waiter counts toward the queue
cap. A late connection is released immediately so the expired request performs
no query.

## Run the services on the host for development

Prerequisites: Node.js 26.13.0, pnpm 12.18.0, Colima, Docker CLI, and Docker Compose.

```sh
colima start
test -f .env || cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm dev
```

The server listens on `127.0.0.1:3000`. Start `pnpm dev:web` in another terminal
for the browser UI; see the [API guide](api.md#create-a-link). To inspect the backend:

```sh
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz

docker compose exec postgres psql -U shortener -d shortener -c 'SELECT 1 AS connected;'
```

If you already have a `.env` from increment 1, add `DATABASE_URL` from
`.env.example` and adjust it if you changed the local database credentials.
Fastify and Drizzle Kit read the root `.env` locally. An exported `DATABASE_URL`
takes precedence, so check which database it points to before applying migrations.

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
- `packages/db` owns the schema, migrations, and the typed link queries. Its
  `createLinkStore` wraps the pool owned by Fastify.
- Dependencies use exact versions; `pnpm-lock.yaml` records transitive dependencies.

## Review a database migration

`packages/db/src/schema.ts` describes the intended table. The generated SQL in
`packages/db/migrations` is what Postgres runs. Read it before applying it: Postgres
generates the internal ID and creation time, requires a destination URL and code,
and rejects duplicate codes with `links_code_unique`.

```sh
pnpm db:migrate
docker compose exec postgres psql -U shortener -d shortener -c '\d links'
```

For the browser UI, run `pnpm db:studio` while Postgres is running and open
[Drizzle Studio](https://local.drizzle.studio). Select `public` → `links`, then
use **Structure** to inspect the table or **Data** to view its rows.

Drizzle records applied migrations in `drizzle.__drizzle_migrations`, so running
`pnpm db:migrate` again skips steps already applied. Fastify does not run migrations
on startup. When changing the schema, run `pnpm db:generate --name=describe_change`,
review the new SQL, and keep it with the generated metadata in Git. Add a new
migration for subsequent changes rather than editing one already applied.

## Check and build

```sh
pnpm test
pnpm test:release
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

The route tests call Fastify's `inject()` with fake link queries, so they
need neither a listening server nor Postgres. They verify the HTTP behavior and
retry policy.

`pnpm test:integration` uses Testcontainers to start fresh Postgres and Redis
containers. It runs `db:migrate`, verifies redirects for codes created via REST
and GraphQL, and checks cache hits, expiry configuration, and Redis timeouts.
It closes Fastify and stops both containers when finished.

On Colima, start the VM and run the same command:

```sh
colima start
pnpm test:integration
```

The command reads the socket from the active Colima Docker context when
`DOCKER_HOST` is unset. An explicitly configured Docker host takes precedence.

`pnpm dev` builds the database workspace package, then uses `tsx` to run the
service and restart on edits. Restart `pnpm dev` after changing the database
package. `pnpm build` builds the DB package, Fastify and Next.js; `pnpm start` runs the service's
compiled JavaScript with Node.
Stop the development server before starting the compiled server on the same port.

## Stop locally

Press Ctrl+C in the server terminal, then:

```sh
pnpm db:down
colima stop
```

`db:down` retains the data volume. `docker compose down --volumes` deletes local
database data and should only be used when intentionally resetting it.

See [upstream references](references.md) for the tools used here.
