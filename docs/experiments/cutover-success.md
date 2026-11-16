# Successful coordinator rehearsal and watcher repair — November 16, 2026

[Cutover procedure](../database-cutover.md) · [Fixture](../database-handoff-rehearsal.md)

**Result: successful coordinator flow passed; live Fastify still serves source.**
No deliberate interruption simulation ran. The current coordinator changes remain
available for review; the necessary watcher repair was committed and published
separately as `0a7dc89b233ea77ddf55f0405fa1803dfff33d27`.

## Successful flow

`pnpm test:cutover:success` runs the actual ten-phase engine and adapter with
scoped fixture dependencies: two temporary PostgreSQL instances, two Fastify
replicas, real ConfigMap acknowledgement and logical replication. The fixture
uses restricted runtime roles, separate credentials and synthetic data. It does
not mutate the live writer, live subscriber or HA sequences.

The passing 90-second run scheduled 25 redirects/s and two creation attempts/s.
Each acknowledged creation added immediate redirect probes through both pods.

| Measurement                                    | Result        |
| ---------------------------------------------- | ------------- |
| Correct redirects within 100 ms                | 2,563 / 2,563 |
| Redirect p99 / maximum                         | 6 ms / 10 ms  |
| Acknowledged creations present on destination  | 156 / 156     |
| Expected maintenance rejections                | 24            |
| Unexpected creation responses / dropped starts | 0 / 0         |
| Gate intent to acknowledged reopening          | 13.159 s      |
| Complete coordinator duration                  | 18.763 s      |
| Fastify pod replacement during handoff         | None          |

All ten phases completed. The canary returned 201 and existed only on the
destination. Source remained readable and fenced; its contents stayed fixed.
The subscription was disabled, its worker stopped and its publisher slot was
retained. Live-state comparisons passed and the owned fixture namespace and
temporary TLS material were removed.

The destination is one disposable PostgreSQL instance. These results qualify the
successful control flow at reduced traffic, not CNPG promotion, cross-VM latency,
failure recovery, a maximum maintenance window or the 1,000/10 throughput target.
Interruption simulations are outside this requested checkpoint.

## Watcher bug discovered during qualification

An earlier run completed the handoff and passed traffic checks, but correctly
failed its final live-state check: the real Fastify pods had lost their runtime
watch and closed creation admission. Read-only diagnosis found repeated
`410 Expired` events. Fetching an unchanged ConfigMap returned its old object
resource version; restarting every watch from that version could never escape
compacted Kubernetes watch history. No failure had been injected into live pods.

A temporary metadata-only annotation refresh restored admission without changing
runtime data. The permanent repair reads a named collection snapshot and starts
watching from its fresh snapshot resource version. RBAC adds only named `list`
permission alongside existing `get/watch`, retaining the name restriction.
A positive regression test covers differing object and collection versions.

The repair passed local lint/type checks and its regression test. All checks in
[GitHub Actions run 43858738938](https://github.com/dentuzhik/shortlink/actions/runs/43858738938)
passed before publication. Both live replicas were then rolled to the verified
immutable image. The temporary annotation was removed. Runtime revision **4**
still selects **source**, accepts creations and keeps HA prepared. The read-only
replication comparison matched **11,008 links**, schema and history on source,
HA primary and both standbys. HA sequences remain `1, false`; source runtime
INSERT/sequence permissions and the active migration stream remain intact.
No live cutover journal or source fence schema was created.

## Private evidence

- Initial run with failed final live-state check:
  `.kind/db-cluster/handoff-rehearsals/2026-11-16T11-22-56-790Z/result.json`
- Passing successful-flow run:
  `.kind/db-cluster/handoff-rehearsals/2026-11-16T11-33-47-919Z/result.json`
- Repair rollout and post-deployment checks:
  `.kind/releases/2026-11-16T11-58-53-808Z-redirect-deploy/`
- Read-only data comparison:
  `.kind/db-cluster/live-replication-verify/2026-11-16T11-59-31-933Z/result.json`

Before live cutover, review stop/recovery and backup-age allowances and generate
a fresh plan tied to the repaired deployment. Previously generated plans no
longer match its pod identities or tooling hashes. Live cutover has not run.
