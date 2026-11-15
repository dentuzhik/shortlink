# Runtime database pool switching

[Runtime maintenance](runtime-maintenance.md) · [Migration plan](ha-migration.md)

**Status:** committed/published as `cfd1d5f` and deployed on November 15, 2026.
The [staged-image rollout trial](experiments/fastify-runtime-rollout.md) passed at
1,000 redirects/s plus ten creations/s after a preserved cold-pull deadline
failure. The old source is still the sole selected application database. Both replicas
now have a [validated HA candidate](experiments/ha-target-preparation.md); the
associated full load trial failed its client thresholds, including baseline
errors, and does not qualify a clean handoff under load.

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
The command checks all replicas, including terminating pods that may still
serve requests. Prepare
can replace/cancel failed preparation; switch and reopen require full prior
acknowledgement. Beginning/ending maintenance preserves database-selection fields.
An error leaves the requested state for inspection instead of undoing a switch.

## Credentials and deployment boundary

Source uses the existing DATABASE_URL. Production HA configuration is loaded
before startup from HA_DATABASE_URL, HA_DATABASE_CA_FILE and
HA_DATABASE_SERVERNAME. The HA identity is database `shortener`; the expected
role is read from the explicitly configured URL username. The dedicated runtime
login is `shortlink_app`; earlier images hardcoded the owner `shortlink_lab`.
Credentials belong in a Secret; the CA can be mounted from a
Secret and its path supplied through the environment. No credential-bearing URL
is put in the control ConfigMap or status endpoint. Explicit TLS settings reject
competing SSL connection-string parameters that could override verification.

The initial preparatory rollout installed code and runtime ConfigMap/RBAC while keeping
all reads/writes on source. It did not create/copy the live HA application Secret
or point a pool at that tier. The separate target-preparation procedure below
installs those credentials/trust. Once the targets are available, maintenance
and pool selection can change without pod replacement. After the HA tier
accepts application writes, image rollback must retain HA selection and use
runtime-capable code. An older image that ignores the ConfigMap could otherwise
read the stale source; returning to it is not a qualified database rollback.

Startup readiness waits for both initial database configuration and the first
successful ConfigMap watch handshake. Receiving a GET snapshot alone does not
route traffic to a pod whose startup creation gate is still closed. After initial
synchronization, known control failures can leave reads ready while writes close.

## Why both a ConfigMap and a Secret?

The runtime ConfigMap holds controls such as `creationMode`, `activeDatabase`
and `prepareDatabase`. The Secret holds the credential-bearing connection URL
and public CA. Fastify's service account can get/watch only the named runtime
ConfigMap; it has no Secret-read permission through the Kubernetes API. The
kubelet supplies the explicitly referenced Secret values when starting the
container: the URL becomes an environment variable and the CA becomes a file.
The certificate is public; it shares the Secret for convenient target packaging.

The ConfigMap tells Fastify which configured pool to use. It does not teach the
watcher how to load arbitrary connection settings. Changing an environment
variable in Kubernetes does not replace the running process's environment, and
this server reads its CA once at startup. Hot credential rotation would need
separate watcher/file-reload, validation, pool replacement and draining logic.
Secret selection and runtime database selection are separate concerns.

ConfigMaps are intended for nonconfidential values. Secrets support separate
access controls and credential delivery, but base64 encoding is not encryption;
cluster encryption at rest is a separate configuration. See upstream
[ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/) and
[Secrets](https://kubernetes.io/docs/concepts/configuration/secret/).

## Prepare the real HA connection target

The optional [target wiring](../deploy/migration/fastify-ha-target.json) adds only
HA environment references and a public-CA mount to the existing Fastify
Deployment. The [operator command](../scripts/prepare-ha-target.mjs) retains its
image, source credentials/endpoint, runtime control, resource and drain settings.
It uses explicit application/database kubeconfigs and validates the current
source-only state before operating. The base application manifest does not
require a database-lab Secret on fresh installations or in CI.

The following commands describe the original owner-login preparation increment.
Once `runtime-application-roles` exists, the legacy command refuses to run.
Use [dedicated runtime roles](database-application-roles.md) for current staging,
combined credential/image deployment and verification; this preserves the source
selection and removes both owner logins from application pods.

```sh
# Stage the immutable application URL/public CA Secret; no pod change.
pnpm db:ha:target stage
# Replace pods with the same image under the existing 1,000/10 workload,
# then run maintenance:prepare ha and verify both candidates.
pnpm test:ha-target-rollout
# Read-only repeat validation after successful preparation:
pnpm db:ha:target verify
```

The load-test command also performs the staging step if needed. An equivalent
rollout without load is `pnpm db:ha:target rollout`; it changes the Deployment,
waits for old pods to leave, then prepares HA. These commands never call
`maintenance:begin`, `maintenance:switch` or `maintenance:end`.

The application-namespace Secret `fastify-ha-target` contains only the encoded
connection URL for database `shortener` and role `shortlink_lab`, plus `ca.crt`.
The server name is `db-lab-primary.shortlink.svc.cluster.local`; the existing
private cross-VM Service/bridge routes it to CNPG's current primary. Passwords
are URL-escaped, and the URL has no parameters that can override explicit TLS
verification. Only the public certificate is mounted; the CA private key stays
in the database cluster. Secret data travels through Kubernetes stdin, not
shell arguments or evidence files. This exercise uses an immutable Secret;
a changed password or CA stops restaging and requires an explicit rotation
increment rather than changing the trust of running pools.

Credentials and CA are loaded when Fastify starts, so staging requires one
preparatory rolling update. Future candidate preparation and the eventual pool
selection can then use ConfigMap changes without replacing pods. Preparation
keeps `creationMode: accept` and `activeDatabase: source`, adds
`prepareDatabase: ha` and advances the control revision. Every replica must
report source active, HA prepared, candidate ready and that revision fully
applied. Read-only validation checks database/role identity, TLS, primary state,
privileges and the expected schema. It does not insert links or advance identity
sequences. The primary should show one idle TLS candidate session per replica.

Preparing a target is distinct from making it authoritative. Source continues
handling all reads and writes, and its new commits continue replicating into
HA. The [logical recovery qualification](experiments/ha-backup-restore.md) and
[disposable handoff](experiments/database-handoff.md) have passed; the latter
used a 25/2 workload. The dedicated-role deployment and operating-load
qualification are separate gates before real cutover. See the
[preparation trial](experiments/ha-target-preparation.md) for its separate
measured results and remaining boundaries.

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
has now passed with the published image under 1,000 redirects/s plus ten
creations/s; see [both attempts and limits](experiments/fastify-runtime-rollout.md).
That local staged-image result does not qualify real writer cutover or failover.

Local checks on November 15, 2026 passed 51 Fastify unit tests, 21 Postgres/Redis
integration tests and 23 tooling tests. Workspace type checks and lint passed.
`k6 inspect` accepted the prepared 90-second workload without sending traffic;
this is a syntax/options check, not a load-test result.
