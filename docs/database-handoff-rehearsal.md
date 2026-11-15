# Disposable database writer handoff rehearsal

[Migration plan](ha-migration.md) · [Runtime pools](database-pool-switching.md)

**Status: passed November 15, 2026 at the reduced 25/2 workload.**
See [measured results and remaining gates](experiments/database-handoff.md).
This exercise creates throwaway databases and Fastify replicas in an owned
namespace on the existing application cluster. The live application keeps
using source; the real HA database, replication subscription and sequences are
not changed.

```sh
pnpm test:db-handoff
```

This is an operator action that creates and removes temporary workloads. It
requires the existing source stack and prepared HA candidates to be healthy,
measured spare guest capacity, Docker context `colima` and the explicitly selected
`kind-shortlink` context in `.kind/kubeconfig`.

## Fixture

The [coordinator](../scripts/rehearse-handoff.mjs) creates a run-labelled
`handoff-<random ID>` namespace containing:

- A source PostgreSQL 18.6 instance, a destination PostgreSQL 18.7 instance and
  a TLS-verified logical subscription between them.
- Two Fastify replicas using the same immutable image as the live deployment,
  separate credentials and the actual ConfigMap watch/pool-switching code.
- Namespace-local runtime RBAC, ConfigMap, Services and short-lived TLS material.
- A k6 Pod targeting both Fastify pod IPs directly, with summaries written to logs.

Both database servers use disposable emptyDir storage. The schema is exported
read-only from source, but all fixture rows are synthetic. The destination is
a single Postgres instance; this exercise does not model CNPG promotion or the
cross-VM network. Redis is disabled so every redirect exercises a database pool.

Native-platform images are exported under unique fixture aliases, imported into
the existing kind node and bound to immutable published references in CRI before
workloads start. Their configuration hashes are verified; Pods use the published
references. Shared image layers/caches may remain after the run. Namespace
cleanup checks its exact run label before deleting it. The fence SQL also checks
a unique startup setting on the fixture source before changing privileges.

## Traffic and stages

k6 schedules 25 existing-link redirects/s and two creation attempts/s for 90
seconds, alternating REST and GraphQL and exercising both pods. Each successful
creation is journaled and immediately redirected through both replicas. Its two
probe reads are additional to the scheduled redirect rate. Expected maintenance
503 responses must contain the precise maintenance code and Retry-After header;
other creation failures fail the test. Redirect correctness and the percentage
within 100 ms are measured; this modest workload does not qualify the agreed
1,000 redirects/s plus ten creations/s operating target.

The first phase exercises an abort **before fencing**:

1. Reject creations and require both replicas to acknowledge draining.
2. Remove only the fixture destination Service's endpoints and terminate its
   existing candidate sessions.
3. Request a pool switch. Both replicas must retain source, report a failed
   configuration, and keep creation admission closed.
4. Restore connectivity, return the desired selection to source, prepare HA
   again, require full acknowledgement and reopen source creations.

The second phase performs the successful handoff:

1. Reject and drain creations across both replicas.
2. Use a separately held old connection to insert one synthetic row directly.
   This demonstrates that the API gate alone does not govern other clients.
3. Fence that source application role while retaining SELECT. Verify the very
   same open connection now receives SQLSTATE 42501 on INSERT and still reads.
4. Apply the final published transaction containing a unique barrier row. Record
   a source WAL position before its commit, then require the destination to
   contain the barrier and its replication origin to have applied that position.
   Compare complete fixture contents after application writes are fenced.
5. Copy the final source sequence positions and prove safe next allocations.
   Disable the subscriber, wait for its worker to stop, drop it and verify its
   publisher slot is removed.
6. Require all transfer gates, switch both Fastify pools while writes stay
   rejected, require matching acknowledgements, then reopen creation.
7. Finish traffic, verify every acknowledged creation on destination, prove
   source contents stayed fixed after fencing, and confirm neither Fastify pod
   was replaced. Compare live source/control/HA state and remove the fixture.

The coordinator records both creation-rejection intervals and the fence, barrier
and pool-switch milestones. A failed gate leaves creation closed within the
fixture and makes the run fail; cleanup removes the disposable environment.
It never automatically switches a live writer or reopens the live gate.

## Fencing scope and a real-source prerequisite

The fixture application login is a separate superuser that owns its application
objects. The [fixture-only fence](../deploy/migration/handoff/fence.sql) uses an
independent administrator to remove elevated attributes, reassign object
ownership, revoke write/schema-creation/sequence rights and retain SELECT.
A table lock serializes this operation with previously admitted database DML.
This protects against ordinary old clients, including an already open connection;
an administrator who can restore permissions is outside that guarantee.

The real source login `shortener` is **the bootstrap superuser (OID 10)**.
PostgreSQL does not permit demoting that account. Therefore this is not yet an
executable fence for the live source. Before using permission-based fencing in
the real cutover, Fastify must move onto a dedicated application role, with its
privileges and existing connection behavior tested. Choosing another fencing
mechanism would require its own qualification. This prerequisite is explicitly
separate from a successful disposable run.

## Evidence and limits

Private results, timeline, traffic logs, creation journal and k6 summary live at
`.kind/db-cluster/handoff-rehearsals/<UTC timestamp>/`. TLS private material is
removed during cleanup. Secrets are sent through Kubernetes stdin and not
written into public manifests or reports. The smaller profile was selected after the user could not free more Mac memory:
four redirect workers, two creation workers, no summary sidecar, two 128-MiB
database limits, two 160-MiB API limits and a 96-MiB k6 limit (672 MiB total
container limits). VM allocations remain unchanged. Admission requires at least
1 GiB guest MemAvailable, guest memory full-stall avg10 no greater than 0.5%, and
a known noncritical host pressure level. Host warning (2) is recorded rather than
interpreted as spare physical memory. These are conservative fixture admission
checks, not a measured capacity ceiling. Live health/headroom are sampled while
workloads run; critical host pressure, insufficient guest headroom or live health
failures stop the rehearsal.
A failed preflight is not a handoff trial.

This first rehearsal does not qualify failures after fencing, unknown commit
outcomes, safe return to source after destination writes, node/VM loss, CNPG
failover, or production throughput. The earlier failed live rollout load trial
also remains unresolved. Live migration requires the source-role prerequisite,
a reviewed maintenance window, passing rehearsal/load gates and final backup/
replication preflight.

References: [ALTER ROLE](https://www.postgresql.org/docs/18/sql-alterrole.html),
[REASSIGN OWNED](https://www.postgresql.org/docs/18/sql-reassign-owned.html),
[replication origins](https://www.postgresql.org/docs/18/view-pg-replication-origin-status.html).
