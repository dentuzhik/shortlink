# Guarded source → HA database cutover

[Migration plan](ha-migration.md) · [Runtime pools](database-pool-switching.md) · [Runtime roles](database-application-roles.md)

**Prepared November 16, 2026. Live execution has not been run.** Fastify continues
serving source. See [recorded preparation checks](experiments/cutover-preparation.md).
The coordinator's policy and SQL guards have tests; its successful disposable
end-to-end rehearsal has also passed. See the [results](experiments/cutover-success.md).
Deliberate interruption simulations are excluded from this learning checkpoint.

The agreed learning scope permits a controlled cutover at the reduced workload.
The 1,000 redirects/s plus ten creations/s performance target remains unqualified;
passing this procedure will establish data/authority correctness, not that target.

## What the operator commands do

```sh
# Read-only against both clusters/databases; creates local evidence files only.
pnpm db:cutover plan
pnpm db:cutover status "$PLAN"
```

`plan` pins namespace, Deployment, Pod and Cluster UIDs; source and HA PostgreSQL
system identifiers; database/table/publication/subscription identities; schema,
image/configuration hashes; credential Secret versions; and the current runtime
control. It checks both runtime roles, both prepared candidates, HA health,
replication, bounded data comparisons on primary/standbys and existing VM
headroom. It also hashes the operator source files. A changed environment or
operator implementation requires a fresh plan **before starting**. Plans contain
no passwords, connection URLs or private keys.

Plans are written under `.kind/db-cluster/live-cutovers/<UTC>/plan.json`.
A plan is not an execution approval or a reservation of database state. Execution
rechecks it and requires separate explicit arguments. No guessed defaults are
provided for the stop deadline or acceptable backup age.

The following commands are for a later, explicitly authorized execution:

```sh
pnpm db:cutover execute "$PLAN" \
  --stop-after-ms "$STOP_AFTER_MS" \
  --backup-report "$BACKUP_RESULT" \
  --max-backup-age-hours "$MAX_BACKUP_AGE_HOURS"
```

`BACKUP_RESULT` must name a passed HA backup/restore qualification under
`.kind/ha-backups/`. Its archived dump checksum is revalidated, and its source
primary UID must match the plan. Decide the acceptable age and stop deadline
before invoking execution. A plan does not create a fresh backup.

## Authority and write admission

A single `database-cutover` ConfigMap is the durable journal and coordination
record. Creation and later updates use Kubernetes create/resource-version
checks. The journal records each operation's **intent before issuing it** and
its observed result afterward. It is mirrored to a private local `journal.json`.
A lost response therefore does not imply the operation failed or can be undone.
A competing coordinator is refused. Recovery requires the same plan and host,
a dead previous local coordinator PID, no remaining tagged database operation,
and compare-and-swap ownership of the journal. There is no automatic lease expiry
or force takeover. Keep the journal and source databases intact after failure.

Ordinary maintenance commands refuse mutations while the journal is active.
API image changes are also blocked during recovery. After completion, API release
and rollback commands require HA-capable code and dedicated credential wiring;
a historical administrator-bearing Pod template is rejected. Web releases are
unaffected. Raw kubectl/SQL access and the broad `k8s:up` bootstrap are outside
this protocol: freeze deployments, migrations, scaling and administrative writes
for the operation, and do not mix those commands with the coordinator.

## Execution phases

1. **Close creations and drain.** Change the runtime ConfigMap with a new
   revision and require both pinned pods to acknowledge rejection and zero
   in-flight creations. Redirects retain their current database path.
2. **Fence source.** An identity-checked transaction takes table locks, revokes
   runtime INSERT and identity-sequence USAGE, checks that no other grant still
   permits writing, and commits one marker link. SELECT and administrator/owner
   accounts are retained. The marker uses a random eight-character code and an
   `example.invalid` destination containing the run ID; it is an intentional
   operator test record. No new source table or publication is needed.
3. **Prove final catch-up.** Require the marker and replication-origin progress
   beyond the recorded source WAL position, with local durability requested.
   Compare complete frozen link/history contents, including both HA standbys.
   Record the final source sequence positions separately from row maxima.
4. **Prepare target generators.** Create administrator-only metadata in
   `shortlink_cutover.control` on HA. Prepare both generators above copied IDs
   and source reserved ranges, retaining any higher target progress. Current
   support is increasing, noncycling sequences with increment one and HA cache
   one. The metadata is not an application table or part of logical replication.
5. **Disable the subscriber and seal preparation.** Persist DISABLE, wait for
   its worker to stop, and retain the subscription and publisher slot. The HA
   control row seals sequence preparation in the same transaction: delayed
   commands cannot rewind generators or reopen preparation after the switch.
   The source watcher changes to allow an inactive retained slot while continuing
   to check invalidation and retained-WAL limits. Slot retirement is a separate
   operator step; retained slots still consume disk and must be monitored.
6. **Switch while closed.** Publish HA selection and require both pods to
   acknowledge HA, the same revision and closed creation admission. Verify marker
   redirects and readiness through both pod listeners. Source remains fenced.
7. **Open HA and audit.** Record opening intent, advance HA metadata to admitted,
   reopen creations, and require both acknowledgements. Issue one tagged creation
   through the API, verify it exists only in HA and redirects through both pods.
   Record completion. Existing test records remain available; no source volume,
   subscription, slot or backup is automatically deleted.

The source fence and marker commit atomically. Repeating a fence after an unknown
acknowledgement updates the same marker rather than creating a second link. That
update produces a fresh published transaction so the new WAL boundary is usable.
Sequence changes have different transaction semantics: their effects are not
undone by rollback. The HA control row is locked and checked before each setval;
sealing prevents delayed writes after admission, and preparation never decreases
an allocation. [PostgreSQL sequence semantics](https://www.postgresql.org/docs/18/functions-sequence.html).

## Failure and recovery rules

| Last attempted operation                     | What may be true                                                                              | Supported recovery                                                                                    |
| :------------------------------------------- | :-------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Planning only                                | Source is unchanged; no journal exists.                                                       | Fix preflight issues and create a fresh plan.                                                         |
| Closing admission, before any fence intent   | Some pods may have closed admission; source write privileges remain.                          | Inspect status, then explicitly abort to source or continue.                                          |
| Fence or later, before opening HA            | Source may already be fenced even if its command returned an error.                           | Keep creations closed; repair and resume toward HA. No automated source unfence.                      |
| Opening HA or later                          | HA may have accepted writes, even if acknowledgement was lost. Admission may already be open. | Inspect actual state and continue on HA. Never silently select source.                                |
| Canary POST attempted                        | The creation may have committed despite a lost HTTP response.                                 | Query by its unique run URL. Never send that POST again automatically.                                |
| Identity, Pod, topology or credential change | The original plan's assumptions no longer hold.                                               | Stop for manual recovery review. Do not hand-edit identities or remove the journal to force progress. |

Before any fence attempt, this explicit recovery is available:

```sh
pnpm db:cutover abort-source "$PLAN" --stop-after-ms "$STOP_AFTER_MS"
```

It verifies the original source/runtime bindings and privileges, requires source
selection and a still-enabled subscriber, removes HA preparation while closed,
then reopens source and records `aborted`. An interrupted abort must finish via
`abort-source`; it cannot resume the forward migration. An aborted journal is
retained for review before any new run is prepared.

After fence intent, use validated continuation:

```sh
pnpm db:cutover status "$PLAN"
pnpm db:cutover resume "$PLAN" \
  --stop-after-ms "$STOP_AFTER_MS" \
  --backup-report "$BACKUP_RESULT" \
  --max-backup-age-hours "$MAX_BACKUP_AGE_HOURS"
```

Resume rechecks bindings, actual runtime control, the source fence and frozen
source contents, target sequences and subscriber state. A new stop allowance is
explicitly recorded. Read-only verification can repeat; potentially ambiguous
canary creation is inspected instead of retried. Zero or multiple matching
canaries require manual assessment; the tool does not invent an exactly-once
creation guarantee. A promoted/replaced primary, changed pod set or unavailable
original coordinator host also requires manual recovery review.

The stop deadline is a **stop-progress threshold**, not a guaranteed maximum
write outage. It is checked between operations and during acknowledgement polls;
an in-progress bounded SQL/Kubernetes request can finish after it. On failure the
tool never automatically rolls back, unfences source or reopens admission.
If opening was already attempted, it reports that HA writes may have been
admitted; it cannot claim the gate stayed closed. Repairs may take longer than
the chosen threshold. After HA accepts writes, returning to source requires a
separate synchronization/fencing exercise, not a configuration reversal.

## Verification and scope

```sh
pnpm test:release
pnpm test:cutover:sql
```

Policy tests cover failures at every phase, ambiguous opening/canary outcomes,
stop deadlines, changed plans, interrupted aborts and maintenance/release guards.
The SQL suite uses two labelled, disposable 128-MiB Postgres containers with
local-only published ports and synthetic data. It verifies wrong-target refusal,
atomic fencing despite an inherited PUBLIC grant, an existing session losing
INSERT, replayed marker catch-up, monotonic sequence preparation, retained slots
and sealed-phase rejection of delayed commands. Fixture trust authentication is
limited to those disposable databases; live TLS/authentication tests are recorded
in the runtime-role qualification.

The SQL fixture tests are wired into the GitHub Actions integration job in the
pending workflow change. The successful coordinator path subsequently passed
against disposable PostgreSQL databases and two real Fastify pods:

```sh
pnpm test:cutover:success
```

This runs the same phase engine and adapter with fixture-scoped Kubernetes,
PostgreSQL and HTTP operations. All ten phases execute under 25 redirects/s and
two creation attempts/s, without injecting interruptions. The destination is a
single disposable PostgreSQL server; this does not qualify CNPG promotion,
cross-VM performance, primary/host failure or recovery after fencing. Deliberate
interruption simulations are excluded at the user's request and are not a gate
for this learning cutover. See the [measured results](experiments/cutover-success.md).
Live execute has not run; choose explicit stop/backup-age limits and generate a
fresh plan/preflight before any live cutover. Earlier plans are stale after the
watcher repair rollout.

References: [ALTER SUBSCRIPTION](https://www.postgresql.org/docs/18/sql-altersubscription.html),
[replication progress](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-REPLICATION),
[logical replication restrictions](https://www.postgresql.org/docs/18/logical-replication-restrictions.html).
