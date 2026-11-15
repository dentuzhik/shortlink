# Runtime database pool switching

[Runtime maintenance](runtime-maintenance.md) · [Migration plan](ha-migration.md)

**Status:** implemented and tested for review; not deployed to live Fastify.
The maintenance checkpoint is committed as `3b725db`. The pool changes remain a
new reviewable diff. The old source is still the sole live application database.

## Pool generations and preparation

The [pool manager](../apps/redirect-service/src/database-pools.ts) owns an active
pool, at most one prepared candidate and any old pools still draining operations.
An operation takes a reference to its generation before awaiting database work.
Changing the active reference directs subsequent operations to the new pool;
already admitted reads finish on the old one. The old pool closes only after its
tracked operations finish. Shutdown also waits for ongoing configuration work
and closes active, prepared and retiring pools.

The shared store delegates each insert/lookup to the selected generation. The
creation gate spans the entire creation including collision retries, so database
selection cannot change between insert attempts. Readiness probes use the active
pool, and existing pool gauges sample that pool. Candidate/retiring pools remain
visible in internal runtime status, not added to the active-pool gauge.

Validation opens a real connection and checks database/user identity, primary
status, session read-only state, INSERT/identity-sequence privileges, migration-history presence
and readable link columns. Configured HA requires verified TLS and a nonsuperuser
role. Validation makes no link writes and does not prove replication catch-up,
sequence safety, source fencing or backup readiness.

A validated pool retains at least one idle connection while healthy; its maximum
remains DB_POOL_MAX (default five). Budget for the source, candidate and retiring
connections across all Fastify replicas. Activation validates the candidate again
because a previously healthy connection can become stale. Failed preparation or
activation retains the active pool and reports a generic error without exposing
credentials. There is no automatic fallback to an old writer.

## Configuration and acknowledgements

The original two-field ConfigMap remains accepted and selects `source`. The
extended form supports:

```json
{
  "revision": 4,
  "creationMode": "reject",
  "activeDatabase": "source",
  "prepareDatabase": "ha"
}
```

Only `source` and `ha` are predefined aliases. `prepareDatabase: null` cancels
preparation. Changing the active alias requires reject mode in a previous
revision, no admitted creations, reject in the new revision, and an already
prepared candidate on that replica. A fresh process can start directly with its
authoritative selected database, including HA in accept mode, after validation;
it does not connect to the old source first.

The watch applies revisions serially. Shutdown and superseded revisions prevent
late asynchronous validation from activating an obsolete selection. Known
control failures still close creation admission. A failed candidate preparation
can leave healthy source traffic running while the new revision remains
unacknowledged. Creations cannot reopen on a database different from the desired
selection after failed activation.

`GET /internal/maintenance` now distinguishes received configuration from fully
applied configuration. `observedRevision` records the received gate revision;
`database.appliedRevision` records successful database configuration.
`configurationApplied` requires a current control connection, matching revisions,
no configuration error and any requested candidate ready. Database status reports
actual active/prepared aliases and retiring operations. Operators must check this
full acknowledgement, not just that a ConfigMap update succeeded.

```sh
pnpm maintenance:status
pnpm maintenance:prepare ha
pnpm maintenance:begin
# FUTURE DATABASE HANDOFF: fence source writes, prove final catch-up,
# correct sequences and stop the migration subscriber before proceeding.
pnpm maintenance:switch ha
pnpm maintenance:status
pnpm maintenance:end
```

These are capabilities, not permission to skip the commented database steps.
The current live target has not been provisioned in Fastify. The command checks
all replicas, including terminating pods that may still serve requests. Prepare
can replace/cancel failed preparation; switch and reopen require full prior
acknowledgement. Beginning/ending maintenance preserves database-selection fields.
An error leaves the requested state for inspection instead of undoing a switch.

## Credentials and deployment boundary

Source uses the existing DATABASE_URL. Production HA configuration is loaded
before startup from HA_DATABASE_URL, HA_DATABASE_CA_FILE and
HA_DATABASE_SERVERNAME. The HA identity is database `shortener`, role
`shortlink_lab`. Credentials belong in a Secret; the CA can be mounted from a
Secret and its path supplied through the environment. No credential-bearing URL
is put in the control ConfigMap or status endpoint. Explicit TLS settings reject
competing SSL connection-string parameters that could override verification.

This increment does not create/copy the live HA application Secret or point any
live pool at that tier. One preparatory rollout will install code and runtime
ConfigMap/RBAC while keeping all reads/writes on source. After that, maintenance
and pool-selection changes can happen without pod replacement. After the HA tier
accepts application writes, image rollback must retain HA selection and use
runtime-capable code. An older image that ignores the ConfigMap could otherwise
read the stale source; returning to it is not a qualified database rollback.

Startup readiness waits for both initial database configuration and the first
successful ConfigMap watch handshake. Receiving a GET snapshot alone does not
route traffic to a pod whose startup creation gate is still closed. After initial
synchronization, known control failures can leave reads ready while writes close.

## Redis and old operations

Positive Redis entries remain usable because existing link destinations are
immutable and both databases must contain identical finalized source links
before the real handoff. Negative results are not cached. Pending coalesced
lookups are keyed by pool generation as well as code. A request after activation
must not join an old source lookup that could report a missing newly created
link. Followers already admitted before the switch can finish with their old
operation.

## Verification

Unit tests cover preparation without changing traffic, ongoing read pinning,
retirement, missing candidates, failed activation revalidation, startup directly
on HA, unsafe transitions, shutdown during validation and superseded changes.

Integration tests use two disposable databases, Redis, production-built Fastify
and the HTTPS ConfigMap fixture. They verify that both REST and GraphQL write
only to the selected destination, readiness/metrics follow the active pool, a
new cache miss avoids old coalesced work, an old read drains, and restart retains
the selected database. Wrong database/user, missing required TLS, an impermissible
superuser and an unreachable target all leave the source serving. Fixture TLS
requirements are explicit; these databases are not the real CNPG subscriber.

The [preparatory rollout test](performance.md#test-a-versioned-fastify-rollout)
is prepared for 1,000 redirects/s plus ten creations/s. It has not yet run against
the new image. No service latency, real writer-cutover or failover guarantee is
claimed from these fixture tests.

Local checks on November 15, 2026 passed 51 Fastify unit tests, 21 Postgres/Redis
integration tests and 23 tooling tests. Workspace type checks and lint passed.
`k6 inspect` accepted the prepared 90-second workload without sending traffic;
this is a syntax/options check, not a load-test result.
