# API and link creation

[Project overview](../README.md) · Run commands from the repository root.

## Application interface

The Next.js page creates links through a GraphQL mutation on Fastify. The REST
creation route and GraphQL mutation share URL validation and code allocation.
`GET /:code` looks up the destination and redirects to it.

The commands below use host-development ports. For Kubernetes, the UI is
`http://app.localhost:8080` and the API is `http://go.localhost:8080`; Compose uses
ports 3101 and 3100, respectively. See [local development](development.md).

## Create a link

Keep the Fastify server running and start Next.js in a second terminal:

```sh
pnpm dev:web
```

Open [Shortlink](http://127.0.0.1:3001), paste a destination URL, and click
**Create link**. The page lets you open or copy the result.

The browser sends a GraphQL mutation to `/graphql` on the Next.js origin.
`apps/web/next.config.ts` forwards it to Fastify on port 3000. The resolver
calls the same link creator as the REST handler and uses the existing pool.
The redirect itself still goes to Fastify.

The web app defaults to `http://127.0.0.1:3000` for both the Fastify upstream
and generated short links. Override them separately with `REDIRECT_SERVICE_ORIGIN`
and `SHORT_LINK_ORIGIN`. The public origin is read at request time by the server
page and passed into the form. In production builds, the GraphQL upstream in the
rewrite is fixed during `next build`; public-origin changes only require restarting
the web process with the new environment value.

With `pnpm dev` running after `pnpm db:migrate`:

```sh
curl -i http://127.0.0.1:3000/links \
  -H 'Content-Type: application/json' \
  -d '{"targetUrl":"https://example.com/guide"}'
```

A valid request returns `201 Created` with `code`, `targetUrl`, and `createdAt`.
See the saved row in `pnpm db:studio`. The request must contain an absolute HTTP
or HTTPS URL without credentials, up to 2,048 characters.

Fastify validates the request before touching the database. Drizzle uses the
existing pool to try an `INSERT … ON CONFLICT (code) DO NOTHING RETURNING …`.
If an eight-character random code is already taken, the insert returns no row,
so Fastify tries another candidate. It makes at most three insert attempts and
returns `503` if all three collide. An unrelated database failure ends the request
immediately.

## Visit a short link

Replace `YOUR_CODE` with the code returned by `POST /links`:

```sh
curl -i http://127.0.0.1:3000/YOUR_CODE
```

The response is `302 Found` with the destination in `Location`. Both the
redirect and a missing code's `404` carry `Cache-Control: no-store`. With Redis enabled, the service checks its cache first. A miss or unavailable
cache falls back to Postgres, with same-code fallbacks coalesced per process.
A confirmed missing link returns `404`; temporary database-checkout rejection
returns `503`. Browser caching remains disabled independently of Redis.

## GraphQL mutation

The UI calls this mutation through Next.js's same-origin `/graphql` rewrite:

```graphql
mutation CreateLink($input: CreateLinkInput!) {
  createLink(input: $input) {
    code
    targetUrl
    createdAt
  }
}
```

Variables: `{"input":{"targetUrl":"https://example.com/guide"}}`.
The resolver delegates to the same creator as REST. GraphQL errors use extension
codes `BAD_USER_INPUT`, `CODES_EXHAUSTED`, or `INTERNAL_SERVER_ERROR`; inspect the
GraphQL response body as well as HTTP status. See the [schema and resolvers](../apps/redirect-service/src/graphql.ts).

## Health endpoints

`GET /healthz` checks the HTTP service; `GET /readyz` checks Postgres with
`SELECT 1`. Redis is an optional performance dependency and does not determine
readiness. Metrics use a separate internal listener on port 9090; see
[observability](observability.md).
