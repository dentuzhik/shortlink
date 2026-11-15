# Fastify runtime-control deployment — November 15, 2026

[Pool control](../database-pool-switching.md) · [Test procedure](../performance.md#test-a-versioned-fastify-rollout)

**Result:** the first cold-node-image attempt failed its deployment deadline.
After staging the same published image in the kind node, the repeat passed the
same traffic, correctness, latency and deployment-window thresholds. The deployed
Fastify replicas now have runtime maintenance/pool control; source Postgres
remains the sole application database.

## Commit, image and environment

- Application commit: `cfd1d5ff1ea14757f5e40bdb97229314a515a27f`.
- [GitHub Actions run](https://github.com/dentuzhik/shortlink/actions/runs/43739277166):
  application checks, integration tests, four native image builds, browser E2E,
  k6/Playwright web rollout and both image publications passed.
- Public image: `ghcr.io/dentuzhik/shortlink-redirect:cfd1d5ff1ea14757f5e40bdb97229314a515a27f`.
- Published index digest:
  `sha256:ac56988ffe2cb5bc7cc5e81188bba945d886f65c0030974a8e6485e887e54bfe`.
- Deployed ARM64 manifest:
  `sha256:ef2f3c71824e093a7ff75b6e9b95748e2285f55b2731076901afd1ca52327dba`.
- Previous application revision: `befb121f76e20ce6ad63e6dac4ab3462e4fbdcc2`.
- Application Colima VM: six vCPUs/six GiB; one kind node; two Fastify replicas.
  The separate database VM remains four/four. Mac memory pressure was normal.
- k6 2.3.0 ran in Docker inside the application VM, sharing its resources. It
  allocated 350 redirect VUs and 50 creation VUs before traffic.
- Creation stayed enabled; no database-selection change or maintenance rejection
  was requested. The UI, Postgres and Redis deployments were not replaced.

CI's web-rollout check is distinct from the local Fastify trial described here.

## First attempt: cold kind-node cache

The original runner first cached image layers in Docker, then requested the
versioned rollout after 20 seconds of load. The kind node uses its own containerd
image store, so that did not stage its image. Kubernetes recorded a **52.565-second
pull** for the 348,970,572-byte image. Deployment and verification took **64.570
seconds** from request, exceeding the fixed 40-second window.

The trial failed and stopped at 85.846 seconds. Forced k6 cleanup prevented a
summary export. No aggregate client latency/throughput qualification is available
for this attempt. The timeline sampled at least two available replicas and two
ready endpoints, and no request-failure lines were logged; neither observation
substitutes for a complete client result. All **852 acknowledged creations**
were subsequently verified against source Postgres with exact destinations.

Failure artifacts remain unchanged at
`.kind/rolling-restart/2026-11-15T17-17-07-388Z/`. The later independent content
check is `post-trial-cohort-verification.json` in that directory.

## Correction and repeat

The operator restored the previous source-only Kubernetes revision 24 and
verified its image and readiness. The same new image was staged and its native
manifest digest checked in the actual kind node, then the original deployment
was repeated. Image revision, VM resources, traffic and thresholds were unchanged.

The runner now calls `image:stage` before baseline. This stage validates the
published artifact and uses CRI in the current kind node. Docker cache presence
alone is insufficient. A deadline failure now finishes the scheduled client trial
before reporting failure; interrupted runs get time to flush k6 summaries before
forced cleanup. A node-digest validation test was added; 24 tooling tests pass.

The backend image remained exactly `cfd1d5f`. The second run used local test-runner
staging/summary-retention fixes. Its `harness/` directory contains the exact runner,
release helper, workload, file hashes and patch used for the run.

## Passing trial

19:26:44–19:28:15, Europe/Tallinn (UTC+2). Requested load was **1,000 redirects/s plus
ten creations/s for 90 seconds**, split into the unchanged 20/40/30-second phases.
Each creation also immediately verified its new redirect, adding approximately
ten probe reads/s beyond the scheduled redirect scenario. All measured redirects
check 302, exact Location and no-store, with client elapsed time measured in ms.

| Phase               | Measured redirects | Correct and ≤100 ms | Redirect p99 | Redirect max | Creations | Creation p99 |
| :------------------ | -----------------: | ------------------: | -----------: | -----------: | --------: | -----------: |
| Baseline, 0–20 s    |             20,199 |                100% |         2 ms |        26 ms |       200 |      4.00 ms |
| Deployment, 20–60 s |             40,401 |                100% |         2 ms |        80 ms |       400 |      4.02 ms |
| After, 60–90 s      |             30,302 |                100% |         2 ms |        21 ms |       301 |      3.00 ms |

- Scheduled redirect iterations: **90,001**; additional immediate verification
  redirects: **901**; measured redirects total **90,902**, all correct and ≤100 ms.
- Creations: **901/901** correct and immediately usable. Every acknowledged
  code/destination also matched source Postgres after the trial.
- Failed HTTP requests: **0 of 91,823**, including setup traffic.
- Dropped starts: **0**. k6 exit: **0**. Runner result: **PASS**.
- Rollout completion/verification: **9.147 seconds**, inside the 40-second window.
- Minimum sampled available replicas and ready endpoints: **2 / 2**. Up to four
  pod objects briefly existed because old terminating pods were still present.
- Both final replicas reported configuration revision 1 fully applied, creation
  enabled, actual/desired database `source`, no prepared candidate and no error.

Creation latency is reported rather than judged against an invented new budget.
The agreed redirect condition passed separately in all three phases.

## Data and remaining boundary

Source links grew from 7,772 to **9,545**: ten setup links and 852 acknowledged
creations from the first run, then ten setup links and 901 creations from the
repeat. Test links were retained. The read-only live replication verification
subsequently matched full bounded row contents/schema and both HA standbys at
9,545 links plus migration history. The migration stream remains active; no
application writer authority moved to the HA tier.

This qualifies one local deployment with an image already cached in the kind
node, Redis healthy and the existing resource allocation. It does not establish
cold-image pull timing, staging impact under load, Redis-outage performance,
worker/VM failure tolerance, or the real database writer handoff. The staging
helper targets this current single-node kind setup; a multi-worker environment
would need preparation on every eligible node.

## Evidence

Private, Git-ignored paths relative to the repository:

- `.kind/rollout-preflight/2026-11-15T17-04-41-810Z/`: original health/row/slot
  inventory and published image digests.
- `.kind/rolling-restart/2026-11-15T17-26-43-669Z/`: passing run.json, summary,
  timeline, per-pod logs, creation journal, release output and exact harness.
- `.kind/releases/2026-11-15T17-24-22-191Z-redirect-rollback/`: verified return
  to the old source-only version before the repeat.
- `.kind/releases/2026-11-15T17-26-39-102Z-redirect-stage/` and
  `.kind/releases/2026-11-15T17-27-04-081Z-redirect-deploy/`: repeat staging and
  immutable-image deployment records.
- `.kind/db-cluster/live-replication-verify/2026-11-15T17-29-27-521Z/`: source,
  primary and both-standby comparisons after the workload.
