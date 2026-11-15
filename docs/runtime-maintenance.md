# Runtime creation maintenance

[Migration plan](ha-migration.md) · [Live replication](database-replication-live.md)

**Status:** implemented and tested for review. The live Fastify Deployment has
not been changed. This increment controls creation admission only; it does not
switch pools, fence database writers, or perform a cutover.

## Configuration and behavior

In Kubernetes, Fastify reads the named `shortlink-runtime` ConfigMap and watches
changes through the Kubernetes API. Its namespaced ServiceAccount can get/watch
that single ConfigMap, with a name field selector on the watch. It cannot change
configuration, list arbitrary ConfigMaps, read Secrets through the API, or manage
pods. Projected service-account credentials are reread on each connection.

The ConfigMap contains one `control.json` value:

```json
{ "revision": 1, "creationMode": "accept" }
```

Only positive safe-integer revisions and `accept`/`reject` modes are supported.
Unknown fields are rejected, including database-selection fields: pool switching
is deliberately absent from this increment. Changing a mode requires a larger
revision. Reusing a revision with different contents or delivering an older
revision closes creation admission until valid current configuration is read.

The shared creation function performs a synchronous admission check and counts
accepted operations before awaiting database work. This covers REST and GraphQL,
URL validation, all collision retries, and success/failure cleanup. Already
admitted work continues when maintenance begins. New creations receive HTTP 503
and `MAINTENANCE`, with `Cache-Control: no-store` and `Retry-After: 1`. The latter
is a retry hint, not an estimate of the maintenance window or a creation SLO.
GraphQL queries such as `{ status }` remain available.

Configured pods start with creation admission closed. A fresh read plus an opened
watch is needed to enable it. Missing/malformed configuration, API errors,
expired watch history or a deleted ConfigMap close admission. The watcher retries
from a fresh GET; normal server watch expiration also refreshes configuration.
An API error never automatically restores `accept` from a local default.

A live connection and matching observed revision are evidence of application,
not an instantaneous cluster-wide broadcast. Network failure detection takes
time; these controls do not replace database writer fencing. Standalone host,
Compose and existing ordinary integration runs without `MAINTENANCE_CONFIGMAP`
retain static local behavior (revision 0, creation enabled). The Kubernetes
manifest explicitly enables runtime control and supplies `POD_NAMESPACE`.

[Admission state](../apps/redirect-service/src/runtime-maintenance.ts) ·
[GET/watch transport](../apps/redirect-service/src/maintenance-watch.ts) ·
[Shared creation logic](../apps/redirect-service/src/link-creation.ts).

## Readiness and internal status

`/readyz` requires an initially loaded configuration and a successful query on
the existing active pool. Maintenance itself leaves readiness healthy so the
Service continues routing redirects. If control fails after a valid initial
load, reads can remain ready while creation fails closed. `/healthz` continues
to indicate HTTP process liveness.

The existing internal metrics listener on port 9090 also serves read-only
`GET /internal/maintenance`, with no-store. It reports:

- Observed revision and configured creation mode.
- Whether configuration has loaded and the control connection is current.
- Whether creation is currently admitted.
- Number of admitted creation operations still running.
- `drained`: current reject configuration and zero active creation operations.

That endpoint is absent from the public application listener and Gateway path.
There is no HTTP endpoint for mutating the gate. Operators change the ConfigMap
using Kubernetes authorization.

**Drained is an application observation, not proof of database quiescence.** A
creation that fails or times out can have an ambiguous commit outcome. A later
writer-handoff procedure must fence all source writers, inspect outstanding
transactions and prove final replication catch-up independently. Maintenance
also does not block direct SQL, migration Jobs or old software without the gate.

## One-time preparation and operation

A preparatory rollout must install the new code, ConfigMap, ServiceAccount/RBAC
and pod environment wiring before these commands can be used. This increment
has not performed that rollout against the live app.

Fresh local Kubernetes startup applies
[runtime permissions](../deploy/k8s/runtime-maintenance.yaml) and creates the
[initial ConfigMap](../deploy/k8s/runtime-control.yaml) only if absent. Startup
never reapplies its initial `accept` value over an existing maintenance window.
Do not manually apply that initial object to reset an existing control revision.
The isolated CI Kubernetes stack installs the same wiring.

After preparing the deployment:

```sh
pnpm maintenance:status
pnpm maintenance:begin
pnpm maintenance:status
pnpm maintenance:end
```

The [operator script](../scripts/runtime-maintenance.mjs) targets the existing
`kind-shortlink` context, `.kind/kubeconfig`, namespace `shortlink`. It inspects
every observed Fastify pod, including terminating pods that may still serve through the Kubernetes pod proxy to the internal
listener. It does not query status through the load-balanced application Service.

Before changing modes it requires the current configuration to be acknowledged.
It updates the JSON value with a larger revision and a resourceVersion precondition
against concurrent edits. Begin waits for all observed replicas to acknowledge
reject and reach zero admitted creations. End waits for accept acknowledgements.
The script checks membership again before reporting success and requires at
least the Deployment's desired replica count. New pods load the same authoritative
configuration before accepting creations.

Commands have a 30-second convergence limit; failures leave the desired state in
place and never automatically reopen creation. That limit is an operator-command
bound, not a maximum maintenance interval. Use a single operator; concurrent
configuration changes abort waiting rather than coordinating a database handoff.
`maintenance:end` currently only reopens creation against the same database.
It must not be treated as evidence that a database cutover is safe.

## Tests and limits

```sh
pnpm --filter @url-shortener/redirect-service test
pnpm test:integration
pnpm test:maintenance:k8s
```

The operator command tests exercise delayed per-pod acknowledgements, still-serving
terminating pods, repeated begin/status calls, resourceVersion preconditions and
concurrent edits. They run in the existing CI release-tooling test step.

Unit tests cover startup, invalid/stale/conflicting revisions, configuration loss,
whole-operation drain accounting through collisions/errors, split UTF8 watch
frames and recovery from expired watch history.

The Postgres integration suite uses two production-built Fastify instances and
an HTTPS ConfigMap API fixture. It blocks admitted INSERTs with a disposable
database lock, verifies REST/GraphQL 503s without extra inserts, serves redirects
and readiness during maintenance, drains admitted writes, restarts an instance
inside maintenance, reopens creation and verifies API outage/recovery and token
rotation. No real link data is used. These tests run in the existing CI jobs.

The Kubernetes-specific test creates a unique temporary namespace, applies the
actual ConfigMap and RBAC, and runs three independent controller states against
the real local API using its restricted ServiceAccount token. It verifies get/watch,
reject/reopen propagation, startup during maintenance, denied reads of unrelated
ConfigMaps and denied mutation permissions. It removes the namespace and local
credential files afterward and records results under
`.kind/db-cluster/runtime-maintenance-tests/`. It does not deploy application pods
or modify the live Deployment/databases. Forced termination may leave a namespace
named `maintenance-test-*`; inspect its ownership before cleanup.

Pool switching, destination connection preparation, database fencing, idempotency,
creation latency policy and a live traffic rehearsal remain separate checkpoints.

Recorded local verification on November 15, 2026: 41 Fastify unit tests and 15
Postgres/Redis integration tests passed, as did the real Kubernetes watch/RBAC
exercise. Its evidence is
`.kind/db-cluster/runtime-maintenance-tests/2026-11-15T16-10-30-227Z/result.json`.
That exercise confirmed the live Fastify Deployment specification was unchanged
and sampled healthy API/UI responses before and after.
