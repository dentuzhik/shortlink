# Disposable writer handoff — November 15, 2026

[Procedure](../database-handoff-rehearsal.md) · [Migration plan](../ha-migration.md)

**Result: passed at 25 redirects/s plus two creation attempts/s.** Two temporary
Fastify replicas transferred their pools between disposable databases while
redirects continued. The deliberate pre-fence connection failure and subsequent
successful handoff both behaved as expected. The live application remained on
its original source database throughout; the real HA tier was not switched.

## Environment

- Reviewed starting checkpoint: `ec5f147`, the HA backup/restore commit. New
  rehearsal tooling was an uncommitted diff on top of it.
- Namespace: `handoff-7ee93ee3a2aff9d8`, run label of the same suffix, on the
  existing `kind-shortlink` node. All namespaced resources were removed.
- Source: PostgreSQL 18.6, published reference
  `postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42`.
- Destination: PostgreSQL 18.7, same CNPG PostgreSQL image as the real HA tier,
  `ghcr.io/cloudnative-pg/postgresql:18.7-system-trixie@sha256:5a5dfbde88d5909fd4938189c141f53fb153f53c519f14907dce9e7c04baa153`.
  This was a standalone fixture, not a three-instance CNPG group.
- Two Fastify pods used the unchanged published `cfd1d5f` image, actual runtime
  ConfigMap watcher, TLS candidate validation and pool-generation implementation.
- k6 2.3.0, pinned published digest
  `sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8`.
- Redis disabled: all redirects reached a database pool. k6 targeted both API pod
  IPs directly, bypassing Gateway and Service balancing for the HTTP workload.
- The source role was a non-bootstrap superuser owning its application objects.
  The destination application role was nonsuperuser `shortlink_lab` over verified
  TLS. All passwords/certificates belonged only to the fixture.

## Resource adaptation

The Mac initially reported warning memory pressure and the user could not free
more memory. Guest inspection nevertheless showed roughly 3.85 GiB available
and no memory full-stall pressure within the already running application VM.
The fixture was reduced before provisioning: four redirect VUs, two creation VUs,
no summary sidecar, two 128-MiB database limits, two 160-MiB API limits and a
96-MiB k6 limit. Total container memory limits were 672 MiB. VM CPU/memory
allocations were unchanged; no live service was stopped to make room.

Admission required at least 1 GiB guest MemAvailable, memory full-stall avg10 no
more than 0.5%, and known noncritical host pressure. The thresholds are fixture
headroom guards, not a derived production capacity limit. Host warning level 2
was allowed to be recorded under this reduced profile rather than treated as
proof of free physical memory. In the passing run, all 30 recorded host-pressure
samples were normal (1), minimum sampled guest availability was **3,597.49 MiB**,
and maximum memory full-stall avg10 was **0**. Source health observations passed.

## Traffic and outcomes

The full coordinator ran 21:21:01–21:23:08 Europe/Tallinn (UTC+2), including
image staging, bootstrap, a **90.002-second k6 trial**, audit and cleanup.
The coordinator first observed the traffic baseline at 21:21:23.580.

| Observation                                       |                Result |
| :------------------------------------------------ | --------------------: |
| Scheduled existing-link redirect iterations       |                 2,251 |
| Immediate cross-replica redirect probes           |                   342 |
| Total redirects / correct / within 100 ms         | 2,593 / 2,593 / 2,593 |
| Redirect p99 / maximum                            |          2 ms / 20 ms |
| Creation attempts                                 |                   180 |
| Successful creations / verified on destination    |             171 / 171 |
| Expected maintenance rejections                   |                     9 |
| Unexpected creation outcomes                      |                     0 |
| Dropped starts                                    |                     0 |
| All HTTP requests, including expected maintenance |                 2,773 |
| k6 exit / coordinator / cleanup                   |       0 / PASS / PASS |

Each creation alternated REST/GraphQL; successful responses were journaled and
immediately redirected through both replicas. Maintenance responses required
HTTP 503, the precise MAINTENANCE code and Retry-After. Four rejections were REST
and five GraphQL. These intentional rejections are partial creation
unavailability, not zero-downtime creation service. No write queue or automatic
creation retry was introduced.

## Deliberate failure before fencing

At 21:21:33.582 the coordinator requested creation rejection and waited for both
replicas to drain. It removed destination Service endpoints and terminated the
existing candidate connections. The requested pool switch failed on both
replicas: actual active source retained, desired HA reported as unapplied,
configuration error visible, and creation admission remained closed.

Connectivity was restored, desired selection returned to source, HA candidates
were prepared again, and full acknowledgement preceded reopening. This
**3.670-second** coordinator maintenance interval ended at 21:21:37.252 and
contained **seven** observed creation rejections. No source fencing or
destination application writing occurred during this aborted attempt.

## Successful handoff

At 21:21:42.254 creation rejection was requested and both API replicas drained.
A separately held source connection then inserted `rogueA01`, ID **1032**,
proving that an API gate alone does not govern another database client.

The guarded source transaction removed that role's elevated privileges,
reassigned its application objects to an independent administrator, revoked
write/schema-creation/sequence privileges, retained SELECT and committed a
published barrier row. Fence command duration was **62 ms**. The **same backend
PID 146** subsequently received SQLSTATE **42501** on INSERT and successfully
read 34 links. Its effective rights were SELECT only: no superuser, INSERT,
UPDATE, DELETE or TRUNCATE authority.

The target received the barrier and its replication origin passed the recorded
source WAL position; observed catch-up after fencing was **65 ms**. Complete
fixture contents matched at that boundary. Target identity generators, initially
`1, false`, were prepared from the final source values: links **1032, true** and
migration history **2000, true**. The history generator was preserved ahead of
its maximum row ID 7. Both next allocations were verified safe.

The subscriber was disabled, its worker stopped, it was dropped and the source
slot disappeared. Both Fastify pools then switched while creations remained
closed. Pool acknowledgement completed **844 ms after fencing**. Full reopen
acknowledgement was observed at 21:21:43.428: a **1.174-second** coordinator
maintenance interval containing **two** expected creation rejections.

Every acknowledged creation was found on destination. A conservative cohort
starting one second after reopen contained **138** further creations. Source
contents stayed fixed at 34 rows after fencing, and both original Fastify pod
UIDs remained unchanged. This was a configuration/pool handoff, not a pod rollout.
The measured windows include coordinator/API observations; they are not a
production maintenance-window guarantee.

## Live-state verification and remaining prerequisite

Before/after checks retained the real runtime revision **4**, source active,
creation accepted and the real HA candidate ready in both live Fastify pods.
Their pod identities, Deployment spec, source Postgres spec and CNPG spec were
unchanged. Real HA identity generators stayed **1, false**. Independent live
replication verification after cleanup matched **10,817** links plus migration
history/schema on source, the HA primary and both standbys. No handoff namespace
remained. Shared image-layer caches were retained.

One important difference prevents applying this exact fence to the live source:
its application login `shortener` is PostgreSQL's **bootstrap superuser, OID 10**.
PostgreSQL does not permit demoting that role. The fixture proves permission
fencing for a separate application account, including an existing connection.
Before this fencing strategy can be used live, move Fastify onto a dedicated
application role and qualify its privileges/credentials. The live role was not
modified by this exercise.

This run does not qualify failures after fencing, safe return after destination
writes, ambiguous commit handling, CNPG promotion, cross-VM handoff performance,
node/VM loss or the agreed 1,000/10 operating target. The earlier failed load
qualification remains failed. Real cutover requires the source-role preparation,
a reviewed maintenance window and the remaining load/final-preflight gates.

## Development failures retained

These attempts were kept as failures and cleaned up before the passing repeat:

| UTC artifact timestamp | Stopping point                                                                    | Correction                                                                           |
| :--------------------- | :-------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| 19-10-16-905Z          | kind docker-image import requested absent platform content                        | Native-platform archive export/import.                                               |
| 19-12-16-150Z          | Source fixture alias was not recognized by kubelet despite CRI metadata           | Bind and verify immutable published references in CRI; use those references in Pods. |
| 19-16-48-220Z          | Subscriber creation raced initial publisher Service connectivity                  | Verify the real TLS publisher path before creating the subscription.                 |
| 19-19-07-067Z          | Empty EndpointSlice used null instead of an endpoint array during fault injection | Accept the empty representation in the coordinator.                                  |

The first three attempts stopped before traffic; the fourth stopped during the
pre-fence failure phase. None transferred live writer authority. A focused test
also validates that the k6 summary JSON survives its stdout/log protocol.

## Evidence

Private Git-ignored paths relative to the repository:

- `.kind/db-cluster/handoff-rehearsals/2026-11-15T19-21-01-544Z/`: passing
  result, control timeline, k6 summary/log, acknowledged creations, per-workload
  logs, resource/health observations and maintenance-response observations.
  `harness/` retains the exact qualified scripts and SHA-256 values. The final
  summary formatter was subsequently normalized to an equivalent newline
  literal; its protocol test passed after that formatting change.
- Earlier failed attempts use the corresponding timestamps in the table above
  under `.kind/db-cluster/handoff-rehearsals/2026-11-15T<timestamp>/`.
- `.kind/db-cluster/live-replication-verify/2026-11-15T19-24-04-412Z/`:
  independent source/HA-primary/both-standby data comparison after cleanup.

The TLS private files were removed and the fixture Secrets disappeared with
namespace deletion. No live credentials or data were copied into fixture rows.
