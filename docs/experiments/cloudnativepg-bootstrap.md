# CloudNativePG bootstrap: November 14, 2026

[Lab commands and architecture](../database-ha-lab.md) · [Migration plan](../ha-migration.md)

**Completed:** dedicated database VM, a four-node kind cluster, CloudNativePG,
three disposable Postgres instances, verified TLS and healthy synchronous
replication. Existing application traffic and data remain on the original
cluster. Operator and worker failover tests have not been run.

The prior recovery increment was committed as `b608680`. This implementation is
a new reviewable diff on that checkpoint. The user selected CloudNativePG and
one required synchronous standby, then approved reducing the new VM to four GiB
when measured host pressure did not meet the six-GiB planning guardrail.

## Provisioned topology

| Component          | Observed configuration                                      |
| :----------------- | :---------------------------------------------------------- |
| Source profile     | `default`: 4 CPUs / 4 GiB / 100 GiB, unchanged              |
| Database profile   | `shortlink-db`: 4 CPUs / 4 GiB / 40 GiB                     |
| New Kubernetes     | v1.36.4, one control plane plus three workers, ARM64        |
| Operator           | CloudNativePG 1.30.1, running on the control-plane node     |
| Database           | Postgres 18.7: primary `shortlink-lab-1`, two standbys      |
| Placement          | Primary on worker2; standbys on worker3 and worker          |
| Persistent storage | Three distinct five-GiB local PVCs                          |
| Commit policy      | `synchronous_commit=on`, `ANY 1`, `dataDurability=required` |

Registry image digests and the operator-manifest checksum are recorded in
[`versions.json`](../../deploy/db-lab/versions.json). The new cluster uses a
supported Kubernetes version; the existing application cluster remains v1.37.0.

## Capacity result: six GiB did not pass the host gate

The initial 4-CPU / 6-GiB database profile booted successfully. During node/image
startup macOS memory pressure moved from normal (`1`) to warning (`2`) and
remained there after all three database instances became ready. Host swap used
increased from about 3,100 MiB early in bootstrap to a peak above 3,500 MiB in
observations, despite more than four GiB available inside the database guest.
A healthy guest was not sufficient to establish host headroom.

Further expansion was paused. The bootstrap observer was briefly paused after
the Postgres resource had already been submitted; the operator continued its
existing reconciliation and finished bringing up the three instances. This did
not suspend the controller. The final bootstrap command now checks host pressure
before installing the operator and before submitting the Postgres resource.

With user approval, only the disposable database profile was stopped and
restarted at 4 CPUs / 4 GiB, preserving its cluster and PVCs. The source profile
was not stopped. Database pods each showed one expected restart after this VM
resize, and all three returned ready. This is not a database failover test: all
its nodes shared the restarted VM, and no real application depended on it.

At four GiB, host pressure returned to normal. A further three-snapshot window
from **16:47:44 to 16:48:15 UTC** recorded:

| Measurement                             |                         Result |
| :-------------------------------------- | -----------------------------: |
| Host pressure level                     |            1 in every snapshot |
| New swap-out / swap-in during window    |                      0 / 0 MiB |
| Host swap used                          |        About 3,457 MiB, stable |
| Database guest available memory         |            About 2.29–2.30 GiB |
| Source guest available memory           |            About 1.97–1.98 GiB |
| Database-cluster total pod working sets |                About 1,618 MiB |
| Operator working set                    |                   About 64 MiB |
| Postgres working sets                   | About 118–121 MiB per instance |

Working-set and guest-available counters have different definitions; do not add
them or sum the capacity advertised by kind nodes. The two VMs currently have
**eight GiB allocated in total**. The later proposed application resize to six
GiB and replacement-cluster overlap are not validated by this result. Revisit
host capacity before using the source maintenance interruption or adding that
application cluster. The historical six-GiB estimate is preserved in the
[capacity report](ha-capacity-planning.md).

## Functional checks

`pnpm db:lab:check` passed at **16:44:49 UTC**. After an idempotent
`pnpm db:lab:up` repeat and additional verifier checks, it passed again at
**16:46:11 UTC**. Existing database PVCs were retained on the bootstrap repeat.

The second check verified:

- Four ARM64 nodes at the pinned Kubernetes version and the pinned operator image.
- Three ready database instances on separate workers and separate bound volumes.
- A CA- and hostname-verified TLS connection through a temporary Mac port-forward.
- Application role `shortlink_lab`, with `superuser=false`, connected to the primary.
- A successful probe insert with synchronous commit enabled; about 2.8 ms for
  this single SQL operation, not an application latency or throughput measurement.
- Both standbys in streaming/quorum state, in recovery, with the inserted row
  visible and WAL replay at or beyond barrier `0/7006DE8`.
- Normal host pressure and about 60% guest available memory at that check.

The two verifier runs retained two disposable probe rows. This is physical
replication inside the new tier, not a replication stream from the existing
application database. The separate automatic-failover quorum option remains at
its observed default `false`; promotion safety and interrupted client requests
remain unqualified.

Across the bootstrap observation window **16:32:25–16:47:28 UTC**, all **540
sampled source HTTP requests** returned `200`: API liveness, API readiness and
UI root. Nine more checks passed during the final resource window. Sparse smoke
requests do not prove uninterrupted availability between samples or the agreed
1,000/10 performance target. The old source database and its existing links
were not used for test writes or migrated. The source-service maintenance
interruption remains unused; only the disposable database VM was restarted.

## Evidence and remaining work

Local, ignored evidence is in `.kind/db-cluster/`:

- `bootstrap-observations.ndjson`: source health and host pressure observations.
- `resource-trials/6g-*`: failed six-GiB host gate and healthy guest/cluster state.
- `resource-trials/4g-*`: profile allocation, guest/host samples and per-node pod usage.
- `checks/2026-11-14T16-44-49-580Z/result.json`: first healthy-path verification.
- `checks/2026-11-14T16-46-11-605Z/result.json`: repeated verification with version checks.
- `vendor/`: checksum-pinned upstream manifest and locally patched objects.

Private kubeconfigs and generated credentials are not committed. The active
Docker context remains `colima`; the global Kubernetes context remains unset.
No permanent Postgres port or cross-VM application connection has been added.

Next: explain and test a planned primary switchover with disposable data, then
separately investigate an unexpected primary-worker failure. Do not combine
those tests with real-data migration. Cross-VM routing, continuous backups,
source replication, final writer handoff and gradual traffic migration are
still later checkpoints.
