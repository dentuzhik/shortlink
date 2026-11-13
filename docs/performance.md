# Performance targets and test procedures

[Project overview](../README.md) · Run commands from the repository root.

## Performance target and current baseline

The agreed 30-second trial target is **1,000 redirects/s plus 10 creations/s**:
at least 99% of requests for existing links return the correct `302` and
`Location` within 100ms, measured by the client. The original budget applies
separately with healthy Redis and with Redis reads timing out. The
[latency-budget trials](../benchmarks/README.md#redirect-latency-budget-with-concurrent-link-creation)
record those experiments and their different environments.

The latest restart validation used **4 VM CPUs / 4 GiB**, two Fastify replicas,
healthy Redis and ten hot redirect codes. Two 90-second trials each passed all
correctness/latency checks, including a rolling restart. Both used 1,000
redirects/s plus 10 creations/s; no Redis fault was injected in those runs.
[Recorded results](experiments/rolling-restarts.md#four-cpu-comparison) include
resource settings, client measurements and the earlier checkout failures.
The restart check deliberately requires zero errors and zero dropped starts in
addition to the 99% budget. A p99 value alone does not account for correctness.

The script automatically creates links and retains them in the local database.
Use the experiment log to distinguish observed limits from hypotheses; results
from a different VM size, replica count, route or cache distribution are separate
measurements. Passing the target workload establishes a tested operating point; ceiling
measurements are separate.

## Test a Fastify rolling restart

With two healthy Fastify replicas in the running Kubernetes stack:

```sh
pnpm test:rolling-restart
```

The current manifest already declares the rollout and drain policy. Reapplying
`deploy/k8s/apps.yaml` also switches Fastify to its development `:local` image;
keep the deployed image when testing a versioned release.

This deliberately replaces **both Fastify pods** while k6 sends **1,000 redirects/s
plus 10 link creations/s for 90 seconds through the Gateway**. The two independent
arrival-rate scenarios continue scheduling requests even when responses slow
down. It creates ten fixture links, warms them, collects a 20-second baseline,
requests a rolling restart, and continues traffic.
The fixed reporting windows are baseline (0–20s), restart window (20–60s), and
after (60–90s); actual restart and rollout completion timestamps are recorded
separately. A rollout taking more than the 40-second restart window fails the
test. Redis and Postgres keep running; Redis's normal 60-second TTL still applies.
The fixture rows and links created under load remain in the local database.
This exercises ten hot redirect keys with healthy Redis, including normal TTL
expiry; it does not simulate Redis read timeouts or a broad distribution of codes.

To repeat the earlier redirect-only comparison instead, run:

```sh
RATE=100 CREATE_RATE=0 pnpm test:rolling-restart
```

The Deployment declares `maxUnavailable: 0` and `maxSurge: 1`. Kubernetes can
start one extra non-terminating pod while preserving two available replicas.
Terminating pods can briefly add to the physical count. Fastify's existing
`SIGTERM` handler calls `app.close()`; the container entrypoint uses `exec`, so
Node receives that signal. The initial trials in the [experiment log](experiments/rolling-restarts.md) used that shutdown handler
without a routing drain wait.

The current Fastify pod template adds a native Kubernetes `preStop.sleep` hook
of **five seconds** and explicitly keeps `terminationGracePeriodSeconds: 30`.
The kubelet waits before sending `SIGTERM`; it does not suspend the Node.js
process. Fastify keeps serving requests while Kubernetes marks the endpoint as
terminating/unready and Traefik updates routing. After the hook completes,
Fastify's existing shutdown handler finishes accepted requests and closes its
pool and Redis client. The 30-second allowance includes both phases, leaving up
to 25 seconds after the hook. `/readyz` continues checking Postgres; terminating
endpoints become unready for regular routing independently of that probe.

Five seconds is an initial measured-test candidate: the previous 4-GiB run's
failed requests began across roughly a two-second handoff interval. This gives
local propagation headroom, but it is not an acknowledgement from Traefik or a
universal production setting. Validate it with the same correctness and latency
checks; a sufficiently long routing delay can still exceed a fixed wait. The
hook applies to replacement pods, so the setup rollout must complete before
testing a restart of pods that actually contain it. This uses the existing image
and requires no Fastify code or image rebuild. See the Kubernetes
[lifecycle hook execution rules](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/#hook-handler-execution).

The strict correctness goal is zero wrong destinations, connection errors, or
unexpected statuses, plus `Cache-Control: no-store` on every redirect. k6 must
drop no scheduled iterations, execute at least `RATE * 90 - 1` visits, and complete
at least 99% correctly within 100ms both overall and in each reporting window.
When `CREATE_RATE` is positive, it must also execute at least
`CREATE_RATE * 90 - 1` creations, all returning `201` with the expected destination
and an eight-character code. Creation correctness and latency are reported by
phase, without imposing a separate creation latency target. The runner
also checks that both old pods were replaced, the rollout completed, and sampled
Deployment availability stayed at two. The initial trials in the [experiment log](experiments/rolling-restarts.md) used 100
redirects/s without concurrent creations; the default now checks the higher
mixed workload using the same drain policy and restart timing.

k6 preallocates its existing ceilings of 350 redirect workers and 50 creation
workers before traffic starts. This avoids worker initialization during a brief
latency spike; it does not raise the previous worker limits. Both scenarios
still fail on any dropped start. Failure logs include a bounded response body to
distinguish application protection from shutdown or Gateway errors.

The runner uses native `k6` from `PATH`, or the executable specified by `K6_BIN`.
Otherwise it uses the pinned Docker k6 image, sharing Colima's resources. It saves
the k6 summary and log, one-second pod/endpoint/availability snapshots, logs from both old and replacement pods, Kubernetes events, and run metadata beneath
`.kind/rolling-restart/<timestamp>/`. `last-run.json` points to the latest report
and its fixed dashboard time window. A failed threshold exits nonzero while
preserving the diagnostics; the runner does not roll back or alter the shutdown
implementation automatically.

Run metadata includes the configured lifecycle hook and total termination grace
period. Timeline snapshots include each pod's deletion timestamp and grace
period; the deletion timestamp is a deadline, not necessarily the start of the
hook. These fields and the `SIGTERM` logs help verify the delay independently of
the client result. Kubernetes can report rollout completion while old terminating
pods are still draining, so that duration does not by itself measure all cleanup.

In Grafana, old pod series end and two replacement names appear. Their counters
and pools start fresh, while Redis remains shared. Three serving pods may briefly
share traffic. Successful scrape counts may fluctuate and failed scrapes may
appear during startup/termination because the metrics Service includes unready
pods. Scrape failures are separate from user-visible failures; k6 also detects
Gateway/network failures that never reach Fastify's HTTP counters. Five-second
scrapes and one-second control-plane snapshots can miss short transitions, so
the client measurements are the primary continuity evidence.

## Benchmark redirects

With Colima running:

```sh
pnpm bench:redirect
```

This starts a separate Compose project, migrates an empty Postgres database,
and seeds 1,000 links. k6 sends requests directly to `redirect-service:3000`
on the private Compose network. The test starts neither Next.js nor a port
forward and removes its containers and database volume when it finishes.

After a short warm-up, the test schedules 50, 150, then 300 requests per second
for 10 seconds each. It starts requests at the requested rate even if the
server slows down. It checks `302` and the expected `Location` header without
following the redirect.

Read `http_reqs` for achieved request rate, `http_req_duration` for latency,
and `checks_failed` for incorrect redirects. A dropped iteration means k6
could not start a scheduled request with the available virtual users. It is
separate from a request that reached Fastify and failed.

For a short check, run `BENCH_RATES=5 BENCH_SECONDS=1 pnpm bench:redirect`.
See [benchmark results](../benchmarks/README.md) for the recorded baseline.

See the [rolling-restart experiment log](experiments/rolling-restarts.md) for historical trials and the [original benchmark journal](../benchmarks/README.md) for Compose load, cache, and breaker experiments.
