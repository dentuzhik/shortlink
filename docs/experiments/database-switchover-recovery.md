# Where the switchover recovery gap was spent

[Original trial](database-switchover.md) · [Lab procedure](../database-ha-lab.md)

**Finding:** the 8.34-second interval between acknowledged writes spans primary
handoff, delayed Service publication, client reconnection and a final write
acknowledgement wait. PostgreSQL itself reported connection readiness about
2.51 seconds after the last successful write. The biggest observed interval was
between that readiness and the operator publishing the primary label.

This is a read-only investigation of the corrected November 14, 2026 trial,
`2026-11-14T17-11-32-513Z`, switching instance 2 to instance 1. No new switchover
was run and no timings, replication policy or application behavior were changed.
The original result and client trace remain unchanged.

## Measured sequence

All times below are UTC on November 14, 2026. Durations are rounded. The
8,339.91 ms total comes from the client's monotonic clock; the cross-process
breakdown uses wall clocks from the probe, operator and instance logs. It is
an explanatory partition, not a distributed trace with exact causal spans.

| Interval            | Duration | Evidence                                                                                                                 |
| :------------------ | -------: | :----------------------------------------------------------------------------------------------------------------------- |
| 17:12:07.060–07.305 |   0.24 s | Last acknowledged write, then old Postgres fully shut down.                                                              |
| 17:12:07.305–09.074 |   1.77 s | Candidate acquired the primary lease after the old instance released it.                                                 |
| 17:12:09.074–09.574 |   0.50 s | Candidate promoted; Postgres reported ready to accept connections.                                                       |
| 17:12:09.574–13.169 |   3.60 s | Postgres ready, but the operator had not yet published the primary label used by the Service.                            |
| 17:12:13.169–13.696 |   0.53 s | Label publication through successful writer connection; includes routing convergence and an outstanding connect attempt. |
| 17:12:13.696–15.400 |   1.70 s | Writer connected, then its first INSERT received a successful response.                                                  |

The CLI was invoked at 17:12:06.185; the target-primary status timestamp was
17:12:06.953. That command/startup interval precedes the measured gap: the old
primary was still acknowledging writes until 17:12:07.060.

## Shutdown and ownership handoff

The old primary's explicit pre-shutdown CHECKPOINT took about 30 ms. Fast
shutdown started at 17:12:07.104, and Postgres was stopped at 17:12:07.305.
It did not spend seconds draining clients: both retained client connections
received `57P01` administrative-shutdown errors almost immediately.

The old manager logged lease release at 17:12:07.315; the candidate logged
acquisition at 17:12:09.074. This is consistent with the default two-second
lease acquisition polling interval. A clean release avoids waiting for the full
15-second lease expiry. These are separate controls in the
[versioned CloudNativePG lease documentation](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/failover.md#safe-primary-election).
Neither the 3,600-second shutdown ceiling nor the 180-second smart-shutdown
ceiling was exhausted in this trial.

## The largest interval: publishing the Service target

Postgres reported connection readiness at 17:12:09.574. The operator logged
setting instance 1's primary label only at 17:12:13.169. The read-write Service
selects `cnpg.io/instanceRole=primary`; the Cluster resource saying which instance
is primary does not itself make that pod a Service target.

The promoted pod's current Ready condition last transitioned at 17:09:57,
before this trial. The retained observations therefore do not support blaming
this interval on a fresh ten-second Kubernetes readiness-probe cycle. The
Service's ClusterIP stayed the same; clients did not need a new DNS address.

There is a concrete lead in the operator implementation. It collects instance
status before reconciling pod role labels, and it collects statuses sequentially.
The former primary's status endpoint returned HTTP 500 while its local database
was stopped. The operator logged failed extraction at 17:12:11.454 and
17:12:13.151; the latter reconciliation then set the primary label.
See the versioned [controller ordering](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_controller.go)
and [status client](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/webserver/client/remote/instance.go).

Code inspection also found a likely upstream defect: the status request returns
`*StatusError`, but the retry predicate tries to match a `StatusError` value.
The intended HTTP-error fast exit consequently does not match that pointer,
allowing five attempts. Its backoff sleeps total about 1.56–1.72 seconds before
request overhead, consistent with the roughly 1.7-second extraction cadence.
This is a source-based explanation to verify with request-level tracing, not
proof that retries account for every millisecond of the 3.60 seconds. The
retained info-level logs do not separate retries, reconciliation conflicts,
queueing, API/cache propagation and scheduling. No operator patch was made.

The primary-label log is emitted before the API patch completes. EndpointSlices
were sampled afterward, not watched with event timestamps. The following
0.53-second interval therefore cannot be attributed entirely to kube-proxy.

## Reconnection and the extra write wait

Eleven writes failed before sending SQL: five connections were refused quickly;
six generic connection failures each took about one second, totaling 6.01 seconds.
These attempts overlap the shutdown, promotion and Service intervals above.
**Do not add six seconds of timeouts to the 8.34-second gap.**

The writer's last failed attempt ended at 17:12:13.685. It connected at
17:12:13.696; the reader connected at 17:12:13.782 and completed a read at
17:12:13.784. Reads therefore recovered after 6.73 seconds. The writer had
already connected, but its INSERT response arrived at 17:12:15.400, about
1.70 seconds later.

The strongest explanation for that final wait is synchronous commit. The policy
required one standby, with `synchronous_commit=on`. Instance 3 first appeared as
a synchronous candidate at 17:12:14.781, moved to the new timeline at
17:12:15.131 and restarted WAL streaming on that timeline at 17:12:15.363.
The write acknowledgement followed about 37 ms later. This fits waiting for a
standby to durably receive the commit; a `SyncRep` wait-event sample was not
recorded, so the precise SQL-versus-commit division remains inferred.
[Required synchronous replication](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/replication.md#required-data-durability)
intentionally pauses write acknowledgements when no eligible standby can confirm them.

Standby recovery also has retry timing. Instance 3 failed a streaming connection
at 17:12:09.824 and next connected at 17:12:14.780. The observed
`wal_retrieve_retry_interval` is five seconds, matching this cadence. The former
primary separately waited about five seconds before rechecking primary
availability, consistent with CloudNativePG's
[server-availability backoff](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/instance.go).
These waits overlap Service publication and the final write wait; they are not
additional sequential outages. The PostgreSQL setting is documented under
[standby replication settings](https://www.postgresql.org/docs/18/runtime-config-replication.html#RUNTIME-CONFIG-REPLICATION-STANDBY).

## Evidence and next checkpoint

Retained private evidence is under the original trial's `investigation/` folder:
filtered operator logs; current logs from all three instances; previous-container
logs including instance 2's shutdown; Kubernetes Events; a read-only configuration
snapshot; the inspected upstream source; and `breakdown.json`. Original client
and timeline evidence remains one directory above. Kubernetes Events did not
provide exact Service-routing transition times.

The lab still has instance 1 as primary and all three instances ready. The live
application continues using its original database. This investigation gives no
new capacity result or recovery guarantee.

The next useful measurement would timestamp status-request attempts, pod label
and EndpointSlice watch events, client connect/query stages, and the first
writer's `pg_stat_activity.wait_event`. That would test the retry hypothesis and
confirm the synchronous-commit wait before choosing any tuning. Changing the
lease interval, standby retry interval or durability policy now would combine
different causes and obscure what improved.
