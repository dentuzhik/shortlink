# HA migration capacity inventory: November 14, 2026

[Migration plan](../ha-migration.md) · [Project overview](../../README.md)

**Completed:** read-only inventory and a proposed capacity budget. **Not done:**
VM resizing, profile/cluster creation, backup/restore rehearsal, replication,
failover or traffic migration. The proposed destination capacity is not a
validated performance result or a reservation of physical Mac resources.

The migration plan was checkpointed as `a7e3d85` before this exercise. kind remains
the local platform; K3s is deferred to the later hardware migration.

## Collection and scope

Five snapshots were collected from **14:34:29 to 14:35:29 UTC**, 16:34:29 to
16:35:29 in Tallinn. Prometheus one-hour queries were collected around 14:34 UTC;
pool and scrape-health queries were completed around 14:37 UTC. There was no
injected traffic. The maximum sampled 30-second redirect rate in that historical
hour was zero, so these are idle measurements, not evidence of migration or
failover capacity at 1,000 redirects/s.

The collector read host `sysctl`, `vm_stat`, memory pressure and filesystem
statistics; Colima configuration and guest `/proc` counters; Docker usage;
Kubernetes pod resource declarations and kubelet statistics; Postgres size,
connection and replication settings; and Prometheus history. No Secret objects
or kubeconfig contents were collected. Database reads included one exact
`count(*)` on the small links table.

Local evidence, ignored by Git, is under:

```text
.kind/capacity-planning/2026-11-14T14-34-26Z/
```

It contains `host-inventory.json`, `nodes.json`, `pod-inventory.json`, `pvcs.json`,
`storage.json`, `postgres.json`, `prometheus-1h.json`, `samples.json`,
`declared-resources.json`, `summary.json`, `deployment-health.json`, and the
one-off `collect.py` used to gather the inventory. This report preserves the
material measurements if those local files are unavailable. The collector is
specific to the current source cluster; it is not multi-cluster deployment tooling.

## Measured host and VM resources

| Measurement | Observed value |
| :---------- | :------------- |
| Mac | ARM64, model `Mac16,11` |
| Physical/logical CPU cores | 12 / 12: 8 performance, 4 efficiency |
| Unified memory | 24 GiB |
| APFS data volume available | About 213 GiB |
| macOS memory pressure indicator | `1` (normal) throughout the sample |
| macOS compressed-memory physical footprint | About 5.46–5.48 GiB |
| macOS swap used | About 3.40 GiB, unchanged during sampling |
| New swap-out / swap-in during sample | 0 MiB / 0.125 MiB |
| Current Colima profile | `default`, running, ARM64, Docker, Virtualization.Framework |
| Colima version | 0.10.3 |
| Current VM allocation | 4 CPUs / 4 GiB / 100 GiB data disk |
| Guest-usable memory | About 3.81 GiB |
| Guest `MemAvailable` during sample | About 1.90–1.91 GiB |
| Guest memory not available at busiest sample | About 1.91 GiB; not the same as pod working sets |
| Guest average CPU non-idle, excluding I/O wait | About 4.9% of four CPUs, or 0.20 cores |
| Previous-hour minimum / maximum VM available memory | About 1.88 / 2.02 GiB |
| Previous-hour peak 30-second CPU non-idle | About 11.8% of four CPUs; includes I/O wait in this PromQL calculation |
| Previous-hour peak 30-second memory / I/O full PSI | About 0.17% / 2.01% |

Normal pressure and stable swap are encouraging, but the Mac already has a
substantial compressed-memory footprint. Existing swap use does not prove
current thrashing; the zero swap-out delta is more useful for this short window.
Neither normal pressure nor a reported memory-free percentage means all
unallocated host RAM is available for another VM.

## Current Kubernetes, application and storage inventory

One kind node runs Kubernetes v1.37.0. There are 19 running pods: eight in
`kube-system`, one storage provisioner, and ten in `shortlink`. The completed
migration Job is excluded from active resource totals.

| Workload group | Measured pod working-set memory |
| :------------- | :------------------------------ |
| All running pods | About 1,269–1,273 MiB |
| `shortlink` namespace | About 693–697 MiB |
| `kube-system` | About 557–559 MiB |
| Storage provisioner | About 18 MiB |

At the final snapshot, Grafana used about 295 MiB, Prometheus 67 MiB, the two
Fastify pods 130 MiB combined, Next.js 85 MiB, Postgres 44 MiB, Traefik 38 MiB,
and Redis 8 MiB. The Kubernetes API server used about 323 MiB. These are working
sets, not requested or maximum memory. They exclude some runtime/VM overhead and
must not be added to VM memory use as if they were separate allocations.

Scheduled Running/Pending regular-container requests total **1.495 CPU cores
and 1,130 MiB memory**. The `shortlink` namespace accounts for 0.545 cores and
840 MiB. Its configured memory limits total 2,912 MiB. Some infrastructure
containers have no memory limit, and no running container has a CPU limit.
These totals exclude init-container scheduling rules and pod overhead; they are
not a precise effective scheduler reservation or a guaranteed upper bound.

| Database/storage measurement | Observed value |
| :--------------------------- | :------------- |
| Postgres version | 18.6 |
| Links | 7,764 |
| Database logical size | 9,410,239 bytes, about 8.97 MiB |
| Links table plus indexes | 1,409,024 bytes, about 1.34 MiB |
| Postgres directory on disk | 65,772 KiB, about 64.2 MiB |
| Database connections | 11 total backends; three client connections including inventory |
| Configured `max_connections` | 100 |
| Last-hour sampled API pool total / waiting | At most two open connections / zero waiters |
| Current `wal_level` | `replica`; logical replication needs `logical` and a restart |
| WAL sender / replication-slot capacity | 10 / 10 |
| `max_slot_wal_keep_size` | `-1`: retained WAL from slots is not bounded by this setting |
| PVC requests | Postgres, Prometheus, Grafana: 1 GiB each |
| Actual VM data filesystem | About 98 GiB total, 36 GiB used, 58 GiB available |
| Docker image / build-cache accounting | 21.43 GB images / 11.91 GB build cache |

Use the data filesystem as the disk baseline. Docker accounting categories can
overlap through shared layers and are not additive. No images, caches or volumes
were deleted. Node-local PVC requests do not by themselves enforce a per-volume
disk quota or reserve independent physical storage.

## Proposed first-phase topology and budget

**Recommendation:** start with worker/pod/database-instance failover, keeping one
control-plane node in each destination cluster. Full control-plane HA remains a
separate sizing and learning increment. Every database instance still shares its
profile's VM, so this does not survive database-VM or Mac failure.

| Profile | Proposed CPU | Proposed RAM | Virtual data disk | Workloads at peak overlap |
| :------ | -----------: | -----------: | ----------------: | :------------------------ |
| Existing application profile `default` | 6 | 6 GiB | Retain 100 GiB | Existing one-node cluster plus replacement cluster with one control plane and three workers; entrypoint and monitoring. |
| New dedicated database profile, name TBD | 4 | 6 GiB | 40 GiB | One control plane and three workers; three Postgres instances, one per worker, operator and collectors. |
| Total proposed allocations | 10 | 12 GiB | 140 GiB virtual capacity | Nine kind nodes during overlap, eight after the source cluster is retired. |

This increases the application VM from 4/4 to 6/6 during the allowed maintenance
window. The database profile can first be created while the existing service
continues running, subject to host pressure. Profile creation does not consume
the downtime allowance by itself. Do not resize or replace existing resources
as part of this inventory.

The 10 vCPUs share 12 physical cores with macOS and desktop applications; they
are not ten dedicated cores. The 12 GiB allocation leaves 12 GiB nominally
outside guest allocations, not 12 GiB of measured free RAM. Treat both figures
as resource budgets rather than workload guarantees.

### How the memory estimates were formed

| Application VM allowance | GiB |
| :----------------------- | --: |
| Existing full VM baseline, rounded up from measured 1.91 GiB | 2.00 |
| Extra control plane and three workers, including their runtimes | 1.75 |
| New application replicas, Redis and additional scrape/discovery overhead | 1.00 |
| Remaining margin for growth, startup and rollout | 1.25 |
| Proposed total | 6.00 |

The extra infrastructure and workload allowances are **estimates**, not measured
new-node costs. The one-GiB workload allowance assumes ordinary working sets;
it is not the sum of simultaneous container memory limits. Existing monitoring
is counted in the measured baseline. Budget for any temporary replacement
monitoring before stopping the source cluster rather than assuming it is free.

| Database VM allowance | GiB |
| :-------------------- | --: |
| Control plane and three workers, including their runtimes | 1.75 |
| Three Postgres instances, planning allowance 512 MiB each | 1.50 |
| Operator and collectors | 0.25 |
| Guest OS and unaccounted overhead | 0.50 |
| Remaining margin for replication, recovery and startup | 2.00 |
| Proposed total | 6.00 |

The Postgres allowance is provisional, not a selected operator's default or a
final memory limit. Validate supported resource settings, shared buffers and
recovery behavior before adopting them. The two-GiB database margin also leaves
room to avoid a later whole-VM resize after it becomes authoritative. That is
an allowance, not proof that all future workloads will fit.

For the replacement application, budget two Fastify, two Next.js and two Traefik
replicas plus one disposable Redis. Spread replicas across workers and leave
placement options for a replacement pod after one worker fails. Three database
workers give three separate database-node placements. On worker loss, two
instances can remain while replacement may wait for that worker to return;
rebuilding the third replica on a fourth worker is not included in this budget.

Adding two more control-plane nodes to each destination would take peak overlap
from nine to thirteen nodes. Their CPU, memory, disk and recovery costs have not
been measured, so full control-plane HA is not included in this recommendation.

### Disk and connection budgets

Keep the application disk at 100 GiB; current 58 GiB available gives room for
additional node filesystems and application images. Provision a separate 40 GiB
database data disk, with a proposed five-GiB data/WAL envelope per database
instance. Three instances would consume up to 15 GiB of that envelope, leaving
25 GiB nominally for node images, infrastructure, logs and spare capacity.
Confirm actual formatted capacity and filesystem use after provisioning; the
40 GiB disk and five-GiB envelopes are not automatic per-volume quotas.

Both virtual disks share APFS. With about 213 GiB currently free, the proposed
additional data disk appears feasible, but OS disks, snapshots, backups and
application-disk growth also consume host storage. Do not assume a database
backup on the same Mac is independent disaster recovery. Bound and monitor WAL
retention: an offline replication subscriber must not fill the source disk.
A retention limit can invalidate a lagging slot and require reseeding; choose
that policy explicitly rather than silently discarding replication progress.

Two Fastify replicas per application generation, with five pool connections each,
give a steady pool ceiling of **20 connections** during overlap. One additional
surge pod in each cluster raises that simple allowance to **30**. Terminating
pods can retain pools until shutdown, so the actual rollout allowance must
include their overlap too. Reserve connections for probes, administration,
migration and operator activity; size replication workers/WAL senders separately.
The current ceiling of 100 does not imply a need to increase it now or prove
that 100 concurrently active queries meet the latency target.

## Validation gates before data or traffic cutover

The proposed numbers are a starting budget for a small lab. These are proposed
operating guardrails, not measured throughput ceilings or revised product SLOs:

1. Start with disposable workloads, stagger node creation and use CI-published
   images. Avoid concurrent local builds, database copies and high-rate tests.
2. Observe normal host memory pressure without sustained new swap-out activity.
   Existing compressed memory and stable historical swap are not automatic
   failures; increasing pressure and ongoing swap-out mean pause expansion.
3. Retain roughly 20% guest available memory in each VM through bootstrap,
   initial replication, rolling replacement and a single-worker failure drill.
   Compare PSI and client behavior with baseline; a reassuring average is not
   enough to hide a concentrated failure window.
4. Track actual disk growth and retain at least 20% free data-disk space, with
   explicit WAL limits and early alerts. Observe APFS free space separately.
5. Requalify correctness and latency through the cross-VM database endpoint.
   Begin at low load, then run the existing 1,000 redirects/s plus 10 creations/s
   target. Include immediate redirects of newly created codes. Redis-timeout
   and unexpected-primary-failure trials remain separate experiments.
6. Confirm single-writer safety, connection recovery and the agreed replication
   durability policy. Passing an idle inventory does not establish any of these.

If projected or measured use cannot preserve the margins, revise the topology
or budget before cutover. Do not spend the single maintenance window until
backup/restore, source settings, image/tool compatibility and the restart plan
have been reviewed. Do not rely on another disruptive resize after migration.

At collection completion all nine source Deployments had their desired available
replicas, including both Fastify pods. API `/healthz`, `/readyz` and the UI root
returned `200` through the existing Gateway. All five current Prometheus targets
were up. These are smoke checks after inventory, not a load-test result.

## Next checkpoint

Review the proposed worker-failure scope and the 6/6 application plus 4/6 database
budget. Then prepare and verify backup/restore, investigate the selected database
operator with disposable data, and finalize source replication settings and
cross-VM connectivity before scheduling the one maintenance interruption.
