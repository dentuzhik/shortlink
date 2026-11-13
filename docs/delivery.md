# Continuous integration, releases and rollback

[Project overview](../README.md) · Run commands from the repository root.

## Continuous integration on GitHub Actions

[CI runs](https://github.com/dentuzhik/shortlink/actions/workflows/ci.yaml) are
configured in `.github/workflows/ci.yaml`. A push to `main`, any pull request, or
manual dispatch starts the workflow. Node comes from `.node-version`, pnpm from
`package.json`, and dependency installation uses the committed lockfile. Action
versions are pinned to commit SHAs. Dependency and Docker layer caches reduce
repeated downloads; newer runs supersede older runs for the same ref.

| Job                                    | What it validates                                                                                                                              |
| :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| Application checks                     | Shared DB build, lint, workspace type checks, unit/release tests and production builds including Next.js.                                      |
| Postgres and Redis integration tests   | Disposable databases, real migrations and the integration suite.                                                                               |
| Container image (target, architecture) | Four native builds: Fastify and Next.js on AMD64 and ARM64. Each image's revision label, architecture and baked runtime revision are verified. |
| Publish multi-platform image (target)  | Combines the exact verified platform indexes, preserving provenance, into one full-commit tag; verifies both resulting platform digests.       |

Pull requests build and validate images without publishing. Successful `main`
pushes and manual runs on `main` publish:

- `ghcr.io/dentuzhik/shortlink-redirect:<full-git-sha>`
- `ghcr.io/dentuzhik/shortlink-web:<full-git-sha>`

Each tag points to a multi-platform index for `linux/amd64` and `linux/arm64`.
Native runners avoid emulation. CI builds each platform once and pushes it under
a unique run/platform tag with build provenance. After pulling and validating it,
the final publish job combines its exact index digest without rebuilding. Run
artifacts and job summaries record index and platform digests. Temporary run tags
can exist even when subsequent validation fails; only a fully successful set of
platform checks permits publication of the commit tag.

Publishing jobs use `GITHUB_TOKEN` with `packages: write`, so no registry secret
is required. The integration runner has its own Docker/Testcontainers databases;
it never connects to local databases or Kubernetes. Pull requests use ordinary
`pull_request` events and fork tokens retain GitHub's restrictions.

**Visibility:** these packages are intended to be public, allowing anonymous
pulls. GHCR initially creates new packages as private even for a public source
repository. After the first push, set each package's Settings → Change visibility
to Public. Later versions inherit the package visibility. Public images require
no local registry credential or Kubernetes pull secret.

The published web image currently compiles
`NEXT_PUBLIC_SHORT_LINK_ORIGIN=http://go.localhost:8080`, matching our local
Gateway. Its GraphQL rewrite targets the internal `redirect-service:3000` Service.
Another public hostname requires a new web build; runtime environment variables
do not rewrite a Next.js browser bundle.

CI publishes artifacts; deployment remains an explicit local command. A commit
tag is a source convention, not an immutable registry policy: a rerun can replace
the tag. Pinning a digest keeps an already selected release unchanged.

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

Release images carry the **full Git commit SHA** as their tag and a baked
`APP_REVISION` plus OCI revision label. Fastify reports
`shortlink_build_info{revision="<sha>"} 1` on its internal metrics listener and
logs the revision on startup. Development/Compose builds report `development`.

After CI publishes a commit, with the kind stack running:

```sh
pnpm k8s:deploy                  # pull published HEAD and roll out Fastify
pnpm k8s:deploy <git-commit>      # choose another published commit
pnpm k8s:version                 # history and per-pod version/digest checks
pnpm k8s:rollback                # restore the previous retained revision
pnpm k8s:rollback 20             # example: choose a revision from history
```

`k8s:deploy` resolves the commit tag to its registry index digest, selects the
kind node's platform digest, pulls and checks that image's platform and baked
revision, then patches the Deployment to `repository:<sha>@sha256:<digest>` with
`imagePullPolicy: IfNotPresent`. The kubelet pulls the public artifact directly.
It never compiles local application code. Uncommitted edits are not included.
A missing/private image or a mismatched revision fails before deployment changes.

Local builds remain an explicit alternative:

```sh
pnpm image:redirect              # build committed HEAD without deploying
pnpm k8s:deploy:local            # build/load HEAD into kind, then roll out
pnpm k8s:deploy:local <commit>    # build an archived committed snapshot
```

These local commands use `git archive`, require a clean tree for implicit HEAD,
and retain the `Never` pull policy. Existing local SHA tags are checked and
reused rather than overwritten. Both paths target only context `kind-shortlink`,
namespace `shortlink`, Deployment `redirect-service`, container `api`.

A **Git SHA identifies source**. A **Kubernetes revision identifies a pod-template
rollout**; a restart can create another rollout of the same Git version. Deploy
changes the image and records its source and actual kind image digest in pod
annotations, preserving the two-replica rollout strategy and drain hook. It waits
for the rollout, then checks each non-terminating pod's readiness, image reference,
actual image digest and self-reported metric. It does not infer success from one
request through a load-balanced Service.

Rollback selects a ReplicaSet owned by this Deployment, verifies the retained
artifact against that revision's digest (pulling published images by digest), and uses `kubectl rollout undo` to restore
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
`k8s:deploy` for versioned application updates after bootstrap. Bootstrap uses locally loaded images with policy `Never`; registry deployments
use `IfNotPresent`. A later `k8s:up` reapplies the development manifests. Rollback
restores the previous policy along with its image and other pod-template settings.

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

The final version of that exercise was `c6caad20dd3c613481ec2b7123ec57dba06002f5`.
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
