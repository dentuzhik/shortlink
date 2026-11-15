# Source maintenance: November 15, 2026

[Runbook](../source-maintenance.md) · [Migration plan](../ha-migration.md)

**Result:** source maintenance completed in one controlled entrypoint interruption.
The application VM is now six CPUs/six GiB; the independent database VM remains
four CPUs/four GiB. The source supports logical WAL, TLS and a dedicated
replication login. All 7,764 existing links and migration-history contents match
their pre-window hashes. No live publication, slot or subscription was created,
and Fastify still uses the source database.

Replication preparation was committed as `ea53531` before the bundle was built.
The maintenance implementation and results remain a separate reviewable increment.

## Preparation and rehearsal

A fresh source backup/restore rehearsal passed at 14:19:55 UTC. Its 158,312-byte
archive has SHA-256
`99d7015ff3d56eabc5b9021374d272450afb97a085d759ad124d01ab9b19cd86`.
The archive, verification manifest and application checks remain privately under
`.kind/backups/2026-11-15T14-19-55-897Z/` outside the VM being restarted.

The source data filesystem had about 52 GiB available. Its one-GiB PVC request
is not a quota on this kind host-path storage. Host memory pressure was normal.
The old six-GiB database-VM proposal was not applied; that VM stayed at four GiB.

The complete Pod patch was rehearsed in a disposable Kubernetes Pod, using an
empty data directory, real schema and fixture rows. All three CNPG instances
connected through the reverse Service/VM bridge/NodePort path with verified TLS
and the dedicated nonsuperuser login. Plaintext, wrong hostname, untrusted CA
and incorrect password attempts were rejected. CNPG-generated password files
had mode 0600; the resolved source TLS key had root ownership, group 999 and
mode 0440. Fixture Pod and Secret cleanup completed.

Two checkpoint-prefaced samples, each about five seconds and 50 fixture writes,
produced 67,400 and 34,248 WAL bytes. The higher rate was approximately 13.4 kB/s.
Thirty minutes at four times that rate needs approximately 92.3 MiB, below the
initial 128 MiB slot limit. This supports the chosen initial planning allowance,
not a guaranteed retention window or a bound on every WAL-producing activity.
The native logical-replication regression rehearsal also passed at 14:36:20 UTC.

An initial reverse-path rehearsal failed because a merge patch retained the
old disabled Service-selector key. Replacing the complete selector fixed it.
That failed rehearsal is preserved separately and caused no live interruption.

## Controlled window

All times below are UTC on November 15; Tallinn local time is UTC+2.

| Event                                                                  | UTC          |
| :--------------------------------------------------------------------- | :----------- |
| Public bridge close requested                                          | 14:37:33.767 |
| Application VM stop requested                                          | 14:37:38.969 |
| Application VM start at 6/6 requested                                  | 14:37:51.708 |
| Coordinator stopped on an early API check                              | 14:38:08.663 |
| Same gated window resumed; no second VM restart                        | 14:39:16.180 |
| Logical-WAL/TLS/HBA Pod patch applied                                  | 14:39:16.926 |
| Data, reverse path and 20 per-pod redirects verified; reopen requested | 14:39:22.182 |
| First recorded recovered API/UI HTTP samples                           | 14:39:23.190 |

The interval between bridge-close and bridge-open requests was **108.415 seconds**.
It includes closing/startup overhead and is not a precise TCP-unavailability
measurement. Both the API and UI had 36 failed sampled requests out of 46
observations across the run. First failed samples were at 14:37:39.6; the last
were at 14:39:22.2.

The original coordinator checked Kubernetes before its API listener was ready
and returned immediately instead of retrying. The public bridge remained stopped
with restart disabled. We resumed after the API recovered without repeating the
VM restart or reopening traffic between phases. Startup-readiness retry and
explicit same-window resume handling were added. Original failed state and
observations are retained as separate files; the final controller result is not
represented as an uninterrupted first-attempt success.

The client monitor stopped with that coordinator and resumed with it, leaving
an **approximately 68.5-second observation gap**. Missing samples are not counted
as successes. Bridge control/state confirms the planned gate remained closed,
but this trace cannot establish continuous client latency/availability or an
error budget during the gap.

## Final verification

- Source: `wal_level=logical`, TLS on, slot-retention limit 128 MB, ten slots and
  ten WAL senders available. Zero live slots/publications; no real-data stream.
- New login: `shortlink_migrator`, REPLICATION and SELECT, no superuser or INSERT.
  Trust/password material is available on all three CNPG instances through its
  native external-cluster manager, without copying CA/server private keys.
- Source data: 7,764 links, with identical full-row link and migration-history
  hashes before and after the complete window, including the resumed phase.
- Application: both Fastify pods verified ten existing codes each with correct
  `302`, `Location` and `no-store`; public API readiness and UI recovered.
- Independent tier: all three instances remained ready during the VM restart.
  Post-maintenance `db:lab:check` passed TLS, synchronous replay and resource gates.
- Cross-VM application-to-new-tier test passed again with temporary cleanup.
  Source preparation now reports `readyForLiveReplication: true`; that means
  configuration is ready, not that real-data replication has started.
- macOS memory pressure stayed normal at sampled gates. Swap usage increased;
  six/six is an allocation budget, not qualified peak-overlap capacity.

Evidence root:
`.kind/db-cluster/source-maintenance/2026-11-15T14-30-25-375Z/`.
It includes preparation/rehearsal, original Deployment, source content manifest,
original failed maintenance state, final state, HTTP observations and a timing
summary exposing the monitoring gap. The readiness report is under
`.kind/db-cluster/replication-preparation/2026-11-15T14-42-15-497Z/`.

The single planned source interruption is now **used**. The next increment is
schema/data replication with lag/WAL monitoring while the original source stays
the only application writer. Database authority and application traffic migration
remain future checkpoints.
