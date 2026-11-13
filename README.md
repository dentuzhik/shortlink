# Shortlink

[![CI](https://github.com/dentuzhik/shortlink/actions/workflows/ci.yaml/badge.svg)](https://github.com/dentuzhik/shortlink/actions/workflows/ci.yaml)

A URL shortener built iteratively to learn backend development and operations.
Next.js creates links through Fastify's GraphQL API; REST creation is also
available. Postgres stores links, and Redis caches redirect destinations.

## Quick start

Prerequisites: Node and pnpm versions from `.node-version` and `package.json`,
Colima, Docker with Compose/Buildx, kind, and kubectl. The validated local VM
allocation is **4 CPUs / 4 GiB**.

```sh
pnpm install --frozen-lockfile
colima start --cpus 4 --memory 4
pnpm k8s:up
```

| Open              | URL                             |
| :---------------- | :------------------------------ |
| Create links      | <http://app.localhost:8080>     |
| Short links / API | <http://go.localhost:8080>      |
| Grafana           | <http://grafana.localhost:8080> |

`k8s:up` bootstraps the local stack, migrations, Gateway and monitoring. For
updates to an existing versioned release, use the [delivery guide](docs/delivery.md).
For a Compose-only setup, run `pnpm stack:up` and open <http://127.0.0.1:3101>.

## System design patterns covered

- Shared application logic behind REST and GraphQL.
- Connection pooling and bounded database admission with load shedding.
- Cache-aside with TTL, positive caching and database fallback.
- Per-process request coalescing and a Redis read circuit breaker.
- Database-enforced uniqueness with bounded collision retries.
- Stateless HTTP replicas, shared storage and Gateway/service routing.
- Liveness/readiness probes, graceful draining and rolling updates.
- Commit-versioned artifacts, verified rollback and per-pod observability.

The [system design guide](docs/system-design.md) explains each pattern, its code
and its limits. The app currently uses one Postgres instance and one Redis
instance in a single-node local cluster.

## Documentation

| Guide                                  | Contents                                                               |
| :------------------------------------- | :--------------------------------------------------------------------- |
| [System design](docs/system-design.md) | Request flow, implemented patterns, state boundaries and planned work. |
| [Development](docs/development.md)     | Compose/host setup, schema migrations, tests and shutdown.             |
| [API](docs/api.md)                     | UI, REST and GraphQL creation, redirects and health endpoints.         |
| [Kubernetes](docs/kubernetes.md)       | Services, Traefik, networking, replicas and local access.              |
| [Observability](docs/observability.md) | Metrics, Grafana, credentials, CPU/memory allocation and pressure.     |
| [Delivery](docs/delivery.md)           | GitHub Actions, commit-tagged images, rollouts and rollback.           |
| [Performance](docs/performance.md)     | Targets, test commands and links to recorded experiments.              |
| [References](docs/references.md)       | Upstream documentation for the tools used here.                        |

Changes are developed in small reviewable increments. Review a diff before
moving to the next concept; release images identify committed source by Git SHA.
