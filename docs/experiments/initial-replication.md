# Initial real-data copy and change stream — November 15, 2026

[Procedure](../database-replication-live.md) · [Migration plan](../ha-migration.md)

**Result: passed.** The old application remains authoritative. The destination
contains verified real data and continues receiving changes; no application
pool or public routing change was made.

## Environment and database choice

The application profile is six CPUs/six GiB; the database profile is four/four.
Source Postgres is 18.6, destination 18.7, both ARM64. The target has three CNPG
instances on separate kind workers, with one required synchronous standby.
All workers in each profile still share their VM and physical host.

The old `shortener` locale is UTF8/libc/en_US.utf8, collation version 2.41. The
existing disposable `shortlink_lab` database uses C. The user chose a separate
`shortener` database matching the source; existing lab probes were preserved.
The destination owner is nonsuperuser `shortlink_lab`.

## Observations

Live start ran from **15:10:25.021 to 15:10:34.737 UTC**. That is coordinator
elapsed time, not a measured service interruption or pure copy duration.

| Check                                       | Observed result                                        |
| :------------------------------------------ | :----------------------------------------------------- |
| Original links                              | 7,764 retained                                         |
| Labelled migration links                    | Eight: two before, four during sync, two after         |
| Verified link rows / migration-history rows | 7,772 / 1                                              |
| Schema definitions                          | Columns, constraints and indexes matched               |
| Both physical standbys                      | Matched the same complete-row digests and counts       |
| Table synchronization                       | Both published tables reached ready state `r`          |
| Logical stream                              | Active pgoutput slot, TLS sender, running apply worker |
| Apply/sync error counters                   | Zero / zero                                            |
| Fastify Deployment specification            | Unchanged; two replicas remained ready                 |
| Destination application writes              | Not enabled                                            |

The destination-only SHARE lock made the overlap observable: links was in state
`d` while four source creations were acknowledged through REST/GraphQL. The lock
was released at 15:10:31.885 UTC. All eight links immediately returned the correct
302, Location and no-store headers through the old service and appeared in the
new database. These links remain as labelled evidence.

The link digest through ID 7772 was
`b492edf36de87ef8e8ef1da6bd5d0ef2bc4e09a08ffdf767ebb058ee5efa83b8`.
Migration history through ID 1 matched
`7a363205ae498e3e4343a12ee656e740f54b58782c26be78ad1e7cf90cc59724`.
A later independent comparison through ID 7764 also matched the pre-maintenance
source hash on both databases, confirming preservation of the original cohort.
The prefix check tolerates new higher-ID appends; it does not fence later commits.

Both destination sequences remained at last value 1 with is_called=false,
despite copied row IDs. This is expected and prevents treating the copy as
write-ready without the planned sequence handoff.

Four coordinator samples recorded healthy API/UI responses and no monitoring
errors. The main slot's largest sampled retained WAL was 14,288 bytes; the final
sample had zero unconfirmed bytes. These are sparse low-load observations, not
peak WAL generation, a time-lag bound, or proof of the client latency SLO.

## Checks performed

- Disposable replication rehearsal, including the new held-copy overlap, commit,
  rollback, update/delete, pause/resume and sequence tests: passed.
- Live schema, content, cohort and both-standby verification: passed.
- Persistent monitor positive test: healthy slot produced a successful Job.
- Persistent monitor negative test: fabricated missing slot produced a failed
  Job; isolated test resources were removed and the real slot was unchanged.
- Read-only source maintenance check, stream status, CNPG health check and
  private cross-VM connectivity verification: passed after the copy.

At 15:16:19 UTC the stream was still active, both tables ready and error counters
zero, with 56 retained bytes and zero unconfirmed bytes. This is a point-in-time
status check, not a final cutover barrier.

## Private evidence

Paths relative to the repository, intentionally ignored by Git:

- `.kind/db-cluster/live-replication-start/2026-11-15T15-10-25-016Z/`:
  result, timeline, schema dump, cohort and legacy-prefix-verification.json.
- `.kind/db-cluster/live-replication-verify/2026-11-15T15-11-49-422Z/`.
- `.kind/db-cluster/live-replication-status/2026-11-15T15-16-19-767Z/`.
- `.kind/db-cluster/replication-rehearsals/2026-11-15T15-06-36-380Z/`.
- `.kind/db-cluster/replication-watch-tests/2026-11-15T15-13-17-084Z/`.
- `.kind/db-cluster/checks/2026-11-15T15-16-20-074Z/`.
- `.kind/db-cluster/connectivity-checks/2026-11-15T15-16-20-909Z/`.

## Limits and next step

No live writer fencing, pool migration, idempotency or destination sequence
correction was performed. There was no sustained k6 traffic or subscriber
failover test during this copy. Source availability samples are not a zero-error
or latency-budget qualification. No additional planned outage was introduced;
the single source maintenance allowance was already used earlier that day.

The next increment should rehearse writer handoff on disposable data, measuring
creation waiting time and preservation of acknowledged writes under steady
traffic. A successful rehearsal informs the missing application coordination
and creation latency policy; it does not itself authorize live cutover.
