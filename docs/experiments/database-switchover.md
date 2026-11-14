# Planned database switchover: November 14, 2026

[Procedure and acceptance criteria](../database-ha-lab.md#planned-primary-switchover)
· [Migration plan](../ha-migration.md)

**Result:** the corrected trial passed its data-integrity and client-recovery
checks. It did **not** provide uninterrupted database access: the probe observed
failed operations and multi-second gaps. The source application still used its
original database and its sampled health checks stayed successful.

The lab was committed as `7fd90e2` before this increment. The test harness is a
new reviewable diff on that checkpoint. No operator timing, replication policy,
Fastify behavior or source infrastructure was changed to obtain the result.

## Environment and workload

- Database profile: four CPUs / four GiB; one control plane, three workers.
- CloudNativePG 1.30.1 and Postgres 18.7, using the existing pinned images.
- Three instances, one required synchronous standby, `synchronous_commit=on`.
- Existing defaults retained: `switchoverDelay=3600`, `smartShutdownTimeout=180`,
  and separate `failoverQuorum=false`.
- A temporary in-cluster Node client used the real primary Service with verified
  TLS and the nonsuperuser application role. It reused the source API's pinned
  image as a runtime, overriding the application entrypoint.
- Two retained connections: one writer and one reader. Each loop paced attempts
  at roughly 100 ms, with at least ten seconds of healthy baseline. The probe
  ran for 60 seconds; stalls reduced the number of attempts.
- Connection establishment timeout one second; server statement timeout two
  seconds; query response timeout 2.5 seconds. No automatic write retry.

This was a direct SQL recovery exercise, not k6, an HTTP benchmark or a test of
Fastify connection-pool recovery. The application 1,000/10 workload and 100 ms
redirect budget were not exercised here.

## Initial trial: aborted instrumentation run

At **17:09:42 UTC**, the CLI requested `shortlink-lab-1` to
`shortlink-lab-2`. The promotion completed, but the test coordinator stopped
before the probe's full window finished. Its generic 30-second process timeout
was shorter than the declared 80-second `kubectl wait` deadline.

Two further measurement defects were found: an EndpointSlice's `endpoints` could
be null during the transition, and SQL `inet_server_addr()::text` included a
`/32` suffix while metric comparison expected a plain pod address. The observer
missed six samples through the null-field error. These issues were corrected;
no database policy was tuned, and the original trial remains failed/incomplete.

A separate post-hoc check found all 335 logged acknowledged writes present,
with 336 total persisted trial rows. The trace had no `finished` event, so the
extra row cannot be classified from a complete client ledger. This diagnostic
is not a passing full-trial result. The 150 source health requests that were
actually sampled returned `200`; missing observations are not treated as healthy.

Evidence: `.kind/db-cluster/switchovers/2026-11-14T17-09-07-216Z/`, including the
unchanged failed `result.json` and separate `partial-ledger-diagnostic.json`.

## Corrected trial

Run: `.kind/db-cluster/switchovers/2026-11-14T17-11-32-513Z/`.
Promotion requested at **17:12:06.185 UTC**, from `shortlink-lab-2` to
`shortlink-lab-1`. Current roles were detected afresh after the first run; the
second run did not assume instance 1 was still primary.

| Measurement                                             |               Result |
| :------------------------------------------------------ | -------------------: |
| Write attempts                                          |                  528 |
| Acknowledged writes                                     |                  517 |
| Acknowledged writes missing afterward                   |                **0** |
| Writes not sent because connection establishment failed |                   11 |
| Ambiguous write responses in this trial                 |                    0 |
| Persisted trial rows                                    |                  517 |
| Read attempts / successes / failures                    |       544 / 532 / 12 |
| Largest interval between successful writes              |           **8.34 s** |
| Largest interval between successful reads               |           **6.73 s** |
| Successful writes / reads on the promoted instance      |            406 / 421 |
| Client connections established, writer / reader         |                2 / 2 |
| Idle-connection error events, writer / reader           |                1 / 1 |
| Source HTTP smoke requests / failures                   |              216 / 0 |
| Timeline observation errors                             |                    0 |
| Host memory-pressure level                              | 1 throughout samples |
| Probe Pod and ConfigMap cleanup                         |               Passed |

All 11 failed write attempts failed before an INSERT was sent: five
`ECONNREFUSED` and six generic connection errors. The 12 failed read attempts
included six `ECONNREFUSED` and six generic errors; this trace does not separately
label their connect/query stage. These failures were not hidden by retries. No write in this
trial happened to have an ambiguous response, so the ambiguous-token accounting
path was not demonstrated with a committed-but-unacknowledged transaction.

Client gaps use a monotonic clock within the probe. They include normal pacing,
connection attempts and reconnection; do not interpret them as precise server
outage duration or derive a guaranteed recovery objective from one trial.

Selected controller-side observations, rounded to seconds:

| UTC observation | Recorded state                                                        |
| :-------------- | :-------------------------------------------------------------------- |
| 17:12:08        | Switchover in progress, no ready primary-Service endpoint             |
| 17:12:11        | Instance 1 reported as current primary; Service endpoint still absent |
| 17:12:13        | Primary Service had a ready endpoint for instance 1                   |
| 17:12:18        | Cluster healthy with all three instances ready                        |

These are sampled transitions, not exact event timestamps. Role queries are not
simultaneous across servers; no sample reported more than one primary. The final
primary was instance 1, with instances 2 and 3 in recovery/read-only mode. No
unexpected-worker-failure or partition safety claim follows from this test.

## Post-test state and interpretation

The test client successfully reconnected using the same Service hostname. The
former primary rejoined as a standby, all three database instances were ready,
and all 517 acknowledged tokens were present on the promoted primary. A further
`pnpm db:lab:check` passed at 17:14:41 UTC, verifying TLS, current synchronous
settings and fresh probe replay on both standbys.

The source application and its data were not moved, its VM was not restarted,
and the maintenance interruption remains unused. Successful source smoke checks
do not establish its throughput or latency SLO during the exercise. Test rows
and both trials' evidence remain in the disposable lab/local ignored artifacts.

The learning outcome is that **data durability, stable endpoint naming and
connection continuity are separate properties**. This controlled handoff
preserved acknowledged data and recovered, while client access was interrupted.
The [recovery-gap investigation](database-switchover-recovery.md) correlates the
client trace with operator and Postgres logs. Before migrating real application
traffic, qualify client recovery requirements. Unexpected primary-worker failure, bounded
application waiting/retries and public creation idempotency remain separate
checkpoints.
