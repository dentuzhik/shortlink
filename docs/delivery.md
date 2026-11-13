# Continuous integration, releases and rollback

[Project overview](../README.md) · Run commands from the repository root.

## Continuous integration on GitHub Actions

[CI runs](https://github.com/dentuzhik/shortlink/actions/workflows/ci.yaml) are
configured in `.github/workflows/ci.yaml`. A push to `main`, any pull request, or
manual dispatch starts the workflow. Node comes from `.node-version`, pnpm from
`package.json`, and dependency installation uses the committed lockfile. Action
versions are pinned to commit SHAs. Dependency and Docker layer caches reduce
repeated downloads; newer runs supersede older runs for the same ref.

| Job                                  | What it validates                                                                                                                                    |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application checks                   | Shared DB package build, lint, all workspace type checks, unit tests, release-helper tests, and production workspace builds including Next.js.       |
| Postgres and Redis integration tests | Real disposable Postgres/Redis containers, database migrations, and the existing integration suite.                                                  |
| Container image (`redirect`, `web`)  | Both Docker targets build after checks/tests pass; their revision labels match the tested Git SHA, and Fastify's baked runtime revision matches too. |

The integration runner uses its own Docker daemon and Testcontainers databases;
it does not connect to local development databases or the kind cluster. The
workflow needs no database or registry secrets and has read-only repository
permissions. It uses ordinary pull-request events so fork contributions execute
with the corresponding restricted token.

Container validation currently builds `linux/amd64` images on Ubuntu runners.
These images remain on the temporary runner; registry publishing and deployment
are separate future steps. The local Colima/kind environment uses ARM64, so a
future publish/deploy workflow must explicitly choose the matching platform or
publish a multi-platform artifact. CI does not alter the running local release.

To reproduce the application checks locally:

```sh
pnpm install --frozen-lockfile
pnpm --filter @url-shortener/db build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:release
pnpm build
pnpm test:integration
```

Workflow checks report results; requiring them before merging is a separate
repository branch-protection/ruleset setting.

The first published run for `cfc81a1` passed all four jobs on November 13, 2026: [view the run](https://github.com/dentuzhik/shortlink/actions/runs/43390914895).

## Deploy a versioned Fastify image and roll back

Release images use the **full Git commit SHA** as their tag. `git archive` supplies
Docker with the committed snapshot, excluding working-tree changes and ignored
local files. The builder supplies `APP_REVISION` and the OCI revision label; the
app exposes `shortlink_build_info{revision="<sha>"} 1` on its internal metrics
listener. Development/Compose builds without a release revision report
`development`. Candidate releases also log their revision with `Application started`.

With the existing kind stack running:

```sh
pnpm image:redirect              # build committed HEAD, without deploying
pnpm k8s:deploy                  # build/reuse HEAD, load into kind, roll out
pnpm k8s:version                 # rollout history and per-pod version checks
pnpm k8s:rollback                # roll back to the previous retained revision
pnpm k8s:rollback 20             # example: choose a retained revision from history
```

`image:redirect` and `k8s:deploy` also accept an explicit Git commit. Default HEAD
builds require a clean working tree; an explicit commit always builds its archive,
so local uncommitted work is deliberately excluded. Existing SHA-tagged images
are reused after metadata checks and never overwritten by this workflow.
The script targets only `kind-shortlink`, namespace `shortlink`, Deployment
`redirect-service` and container `api`; it does not publish images to a registry.

A **Git SHA identifies source**. A **Kubernetes revision identifies a pod-template
rollout**; a restart can create another rollout of the same Git version. Deploy
changes the image and records its source and actual kind image digest in pod
annotations, preserving the two-replica rollout strategy and drain hook. It waits
for the rollout, then checks each non-terminating pod's readiness, image reference,
actual image digest and self-reported metric. It does not infer success from one
request through a load-balanced Service.

Rollback selects a ReplicaSet owned by this Deployment, verifies the retained
artifact against that revision's digest, and uses `kubectl rollout undo` to restore
the earlier pod template. It does not rebuild a previous release or reverse the
database. Legacy `:local` revisions lack verified release metadata and are not
accepted by the rollback helper; establish a versioned baseline before testing a
candidate. A failed check exits nonzero and preserves evidence rather than
silently declaring success or automatically rolling back.

Operation reports are saved to `.kind/releases/<timestamp>-<action>/operation.json`;
`.kind/releases/latest.json` points to the latest build/deploy/rollback report.
In Grafana Explore, use `shortlink_build_info{job="redirect-service"}` to see source
revisions per pod across the chosen time range. Historical versions can remain
visible after a rollout.

This increment changes no database schema. Release commands do not run migrations;
coordinating schema changes is a separate deployment step. `pnpm k8s:up` remains
the full-stack development bootstrap and applies `:local` images, so use
`k8s:deploy` for versioned application updates after bootstrap. The local kind
image policy remains `Never`; CI image publishing and registry policy are a later
integration step. Commit tags plus retained-digest checks are a local workflow
convention, not a registry-enforced immutable-tag policy.

Checks: `pnpm test:release` verifies rollback selection, artifact mismatches, pod
readiness and version parsing; the app tests verify isolated version metrics.

### Verified versioned deployment exercise

On November 13, the versioned workflow was exercised against the existing
4-CPU / 4-GiB local cluster with no schema changes:

| Step                 | Git revision | Kubernetes revision | Result                                             |
| :------------------- | :----------- | ------------------: | :------------------------------------------------- |
| Establish baseline A | `4cd4bc0`    |                  18 | Both ready pods reported A and its recorded digest |
| Deploy candidate B   | `c6caad2`    |                  19 | Both ready pods reported B and its recorded digest |
| Roll back to A       | `4cd4bc0`    |                  20 | Original A artifact restored; both pods verified   |
| Restore candidate B  | `c6caad2`    |                  21 | Retained B artifact reused; both pods verified     |

The final running version is `c6caad20dd3c613481ec2b7123ec57dba06002f5`.
Rollback created a new Kubernetes revision (20), rather than resetting the
revision counter to 18. Subsequent rollouts can update the revision numbers
retained in history; choose rollback numbers using `pnpm k8s:version`.

A low-rate functional continuity probe recorded **3,744 redirects, all correct**,
while building/deploying B, rolling back and restoring B. It checked `302`, the
stored destination and `Cache-Control: no-store`; the fixture remained usable
across all releases. This is a functional smoke exercise, with the prior
four-CPU load trials providing the separate performance evidence. Both B pods'
startup logs also reported the expected full commit SHA.

Validation passed 29 application unit tests, all 14 real Postgres/Redis
integration tests, six release-verification tests, type checking and lint. The
initial platform identity check exposed an implementation mismatch before
Deployment mutation: Docker reported an OCI index ID, while CRI reported a
platform configuration ID. The corrected workflow hashes the platform config
from the saved image archive and compares that with CRI, then checks the actual
running pod digest and self-reported revision after rollout.

The implementation is committed so image tags identify the source actually
built. Review it with `git diff 13619e9..c6caad2`; this includes the version-metric
baseline, release workflow, tests and platform identity fix. The earlier CPU
comparison notes were checkpointed separately in `13619e9`. Measurement notes
from this exercise remain available for review as a working-tree diff.

Evidence is in `.kind/releases/exercise-2026-11-13T07-45-34-057Z/`, including
`smoke.json`, `candidate-deploy.json`, `rollback.json`, `restored-candidate.json`
and `startup-logs.json`. Each deployment also retains its own operation report.
The initial probe setup received a Gateway `404` because its HTTP client did not
send the required Host header; the corrected probe started its measurements
after fixture creation succeeded.

The repository was moved to `/Users/dentuzhik/shortlink` during this increment.
`origin` now points to `https://github.com/dentuzhik/shortlink`; no CI configuration
was introduced. The local Gateway bridge's bind mount was refreshed to the new
`deploy/kind/haproxy.cfg` path, and the UI and API passed checks afterward.
