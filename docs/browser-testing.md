# Browser and web deployment tests

[Project overview](../README.md) · Run commands from the repository root.

## Test the running UI

Install the pinned browser once, then use the existing local Kubernetes Gateway:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

The Playwright test runs Chromium, fills the destination form, waits for the
same-origin GraphQL response, verifies the displayed short-link origin, checks
`302`, `Location` and `Cache-Control: no-store`, then clicks the link and verifies
the destination in the browser. A tiny local HTTP server supplies the destination;
the test does not depend on an external website. It fails on JavaScript errors,
failed application requests and failed documents, scripts or stylesheets.

The default UI is `http://app.localhost:8080`, with short links on
`http://go.localhost:8080`. For another local stack:

```sh
E2E_BASE_URL=http://127.0.0.1:3101 E2E_REDIRECT_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e
```

Whole-test retries are disabled. DOM readiness waits are still used; a navigation
or action timing out after ten seconds is a test failure guard, not a new UI
latency target. Screenshot and trace artifacts are retained on failure; a passing
test also saves the created-link screenshot and metadata. Reports default to
`.kind/playwright/`, or the `E2E_ARTIFACT_DIR` override:

```sh
pnpm exec playwright show-report .kind/playwright/report
pnpm exec playwright show-trace <path-to-trace.zip>
```

Tests against an existing stack create real rows. Their destinations only run for
the duration of the test; those fixture links remain in the local database.

## Run against disposable production containers

```sh
pnpm test:e2e:containers
```

The runner builds the production Docker targets and creates a uniquely named
Compose project containing Postgres, Redis, migrations, Fastify and Next.js.
It allocates loopback host ports dynamically, supplies the API's actual published
port as the web server's runtime short-link origin, and runs the same browser test.
It saves logs/reports, then removes only that project's containers, network and
volume. It never uses development database volumes or fixed application ports.
No existing local stack is required. Docker/Colima must be running.

To test two already-built artifacts instead of rebuilding, set both
`E2E_API_IMAGE` and `E2E_WEB_IMAGE`; use digest references for exact content.

In GitHub Actions, this browser job runs after native image validation and gates
the final multi-platform commit tags. Trusted main runs download the two verified
AMD64 digest records and test those exact registry artifacts. Pull requests and
manual runs on other branches build the production targets in the disposable
runner instead, without publishing. CI installs Chromium's Linux dependencies
and uploads reports, failure traces and container logs as `browser-e2e` artifacts.
A second CI job creates a disposable kind cluster and runs the combined k6 and
Playwright rollout test described below. Both jobs gate final image publication.

## Run Playwright and k6 during a web rollout

With a stable versioned web release and its five-second drain hook in kind:

```sh
pnpm test:web-rollout                     # restart the current web image
pnpm test:web-rollout <published-commit>  # deploy a different published UI image
```

Defaults are **100 redirects/s plus 2 GraphQL creations/s** for an initial
functional experiment. To use the existing higher workload:

```sh
RATE=1000 CREATE_RATE=10 pnpm test:web-rollout
```

The runner uses native `k6` from `PATH`, or `K6_BIN=/absolute/path/to/k6`. Otherwise
it falls back to `grafana/k6:2.3.0` in Docker's kind network, sharing Colima's
resources. Chromium runs on the host. Record the runner and resource environment
when comparing results; the browser flows add extra link creations beyond the
k6 arrival-rate scenarios.

Both clients run concurrently through the Gateway:

- k6 visits ten initially warmed codes and creates links through the UI's
  `/graphql` endpoint. It does not bypass Next.js using REST creation.
- The fresh-visitor loop creates a new browser context for each flow, loading the
  UI and assets without another visitor's cache.
- The existing-visitor loop keeps its baseline page and JavaScript loaded while
  repeatedly creating and following links through replacement.

The fixed windows are **10 seconds baseline, 60 seconds rollout window, 15 seconds
afterward**. Replacement starts after the baseline and must finish inside the
rollout window. Actual request/completion times are recorded separately. Each
browser session type must complete passing flows in every window, including at
least one flow overlapping the new pod's creation through rollout completion. A suite finishing
all its browser checks before the rollout cannot pass this test.

The combined run fails if either browser loop fails, if k6 drops a start or misses
its iteration floor, if an HTTP correctness check fails, if replacement does not
complete, if a sampled interval has no available web replica, or if phase coverage is missing. It reuses the redirect criterion of
99% correct responses within 100ms, separately in each fixed window. GraphQL
creation latency is measured without inventing a new UI/creation latency budget.
This is a different workload from the Fastify-only REST restart trial.

Reports live under `.kind/web-rollout/<timestamp>/`; `last-run.json` points to the
latest report. They include browser flow timestamps and outcomes, failure
screenshots/traces, k6 summary/log, pod/EndpointSlice snapshots, events, web logs
and the rollout output. Any observed failure remains a failure; the runner does
not retry failed flows, change the drain policy, or automatically roll back.
Passing a finite run establishes evidence for that workload and environment,
not a guarantee that every possible deployment is disruption-free.

The Playwright flow is shared between the CI smoke test and the rollout runner;
see [browser flow](../tests/e2e/web-flow.mjs),
[smoke test](../tests/e2e/links.spec.mjs),
[rollout controller](../scripts/test-web-rollout.mjs), and
[k6 workload](../benchmarks/web-rollout.js).

## Combined rollout check in GitHub Actions

The **k6 and Playwright during a web rollout** job runs on pushes, pull requests
and manual workflow runs. It creates a fresh single-node kind cluster, installs
Postgres, Redis, migrations, Fastify, Next.js and the same Traefik Gateway routes,
then invokes the same `test:web-rollout` harness. k6 and Chromium run together on
the GitHub runner while Kubernetes replaces the candidate web pods.

CI uses **100 redirects/s and 2 GraphQL creations/s**, with the same 10/60/15-second
windows, correctness checks, browser coverage checks and 100ms redirect criterion.
This checks pod replacement of one candidate image; the local optional commit
argument covers a change between published versions. Hosted-runner results are
separate from the Colima throughput measurements.

Trusted main runs test the verified AMD64 image digests directly in kind before
the final commit tags exist. Pull requests build commit-tagged images from their
tested source, bake the revision, load them into kind and record the runtime's
image digests. Both paths check the running revision and use the existing app,
Gateway and five-second web drain settings.

The cluster has a unique `shortlink-ci-<run-id>-<attempt>` name and its own
kubeconfig. The harness refuses the default local cluster when `CI` is set, and
requires kubeconfig/context overrides together. CI maps the Gateway NodePort to
runner loopback port 8080 during cluster creation, so it needs no local HAProxy
bridge, Grafana or existing developer cluster.

Tool versions are pinned: kind 0.33.0, Kubernetes node image 1.37.0, kubectl 1.37.2
and k6 2.3.0. Downloads and the Gateway API definitions have checksum checks; the
node image is pinned by digest. Diagnostics and cluster deletion run even when
the test fails. The **web-rollout** artifact retains bootstrap metadata, browser
failures/traces, k6 results and cluster logs for seven days. The kubeconfig stays
outside the artifact directory.

## Recorded validation

Initial local validation on November 13, 2026 used the existing 4-CPU / 4-GiB
Colima stack and native host k6. Both trials replaced the current web pods while
keeping Fastify, Postgres and Redis running:

| k6 arrival rates                   | Browser flows | Redirects | GraphQL creations | Dropped starts | Result            |
| :--------------------------------- | ------------: | --------: | ----------------: | -------------: | :---------------- |
| 100 redirects/s + 2 creations/s    |           252 |     8,501 |               171 |              0 | All checks passed |
| 1,000 redirects/s + 10 creations/s |           251 |    85,001 |               850 |              0 | All checks passed |

The higher-load trial's redirect p99 was 3ms; all measured redirects were correct
within 100ms. Its browser flows completed with no failures. These are same-image
restart results; version-change experiments are recorded separately.

Evidence: `.kind/web-rollout/2026-11-13T10-07-33-747Z/` and
`.kind/web-rollout/2026-11-13T10-10-08-463Z/`. The steady-state Playwright test also
passed against both the running Gateway and a disposable production-container
stack. CI and version-change evidence is available through the workflow runs and the
rollout reports described above.
