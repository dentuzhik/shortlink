# Metrics, Grafana and VM resources

[Project overview](../README.md) · Run commands from the repository root.

## Inspect application metrics

Fastify now records metrics using the pinned official Node.js client,
`@prometheus-io/client`. Each application instance owns a registry in memory.
The `onResponse` hook counts completed responses and observes their Fastify
duration. A second Fastify listener serves the registry at `/metrics` on port
9090. Closing the application also closes that listener before ending the pool.

| Metric                                            | Type      | Meaning                                                                                        |
| :------------------------------------------------ | :-------- | :--------------------------------------------------------------------------------------------- |
| `shortlink_http_requests_total`                   | Counter   | Completed responses by HTTP method, route template, and status code.                           |
| `shortlink_http_request_duration_seconds`         | Histogram | Response durations in seconds, using the same labels.                                          |
| `shortlink_db_pool_connections`                   | Gauge     | Existing pool clients with `state="idle"` or `state="in_use"`.                                 |
| `shortlink_db_pool_waiting_requests`              | Gauge     | Checkouts currently waiting in the pg pool queue.                                              |
| `shortlink_build_info`                            | Gauge     | One sample with the running image Git revision (or `development`) as its label.                |
| `shortlink_redirect_db_checkout_rejections_total` | Counter   | Rejected checkout attempts by `reason="queue_full"` or `"timeout"`.                            |
| `shortlink_redirect_db_checkout_duration_seconds` | Histogram | Checkout elapsed time by `outcome="acquired"`, `"queue_full"`, `"timeout"`, or `"error"`.      |
| `shortlink_redirect_redis_reads_total`            | Counter   | Cache read outcomes: `hit`, `miss`, or `unavailable` (failed reads and circuit bypasses).      |
| `shortlink_event_loop_delay_max_seconds`          | Gauge     | Maximum Node event-loop sampling delay since the preceding metrics scrape, at 10ms resolution. |

Counters and histograms accumulate until the process restarts. Pool gauges read
`totalCount`, `idleCount`, and `waitingCount` when scraped; collecting them opens
no connections and runs no SQL. `in_use` is `totalCount - idleCount`, which includes
clients still connecting and is not a count of active SQL queries. These are
snapshots, so a periodic scrape can miss a short queue spike.

Checkout rejection counters record events when they happen, so a scrape can
observe the accumulated count even after a short queue or delay has disappeared.
They count underlying database lookup attempts, not HTTP followers sharing a
lookup through coalescing. One rejected checkout can therefore produce several
`503` responses. The structured `Redirect database checkout rejected` log records
the reason, elapsed time, current pool counts, configured limits and the maximum
event-loop delay observed since the preceding scrape. No URL or short code is
included in this diagnostic event.

The event-loop monitor uses Node's built-in `monitorEventLoopDelay`; its samples
include the normal 10ms sampling interval and scheduling delays. A high value
shows that Node was delayed, but does not identify whether CPU scheduling, GC or
synchronous application work caused that delay. Scraping resets its maximum;
closing the metrics listener disables the monitor. `registerMetrics` returns the
listener and observer callbacks, which `buildApp` passes into checkout and cache
handling without adding a Prometheus dependency to those helpers.

In Grafana Explore, select **Shortlink Prometheus** and inspect these queries:

```promql
sum by (pod, reason) (increase(shortlink_redirect_db_checkout_rejections_total[1m]))
```

```promql
shortlink_event_loop_delay_max_seconds
```

```promql
sum by (pod, outcome) (rate(shortlink_redirect_redis_reads_total[30s]))
```

The existing dashboard panels remain unchanged. A minute-long `increase` is an
extrapolated estimate; use counter values and the retained rejection logs for
exact incident counts.

Route labels use `/:code`, `/links`, `/graphql`, or `unmatched`; they contain no
short codes, destinations, request bodies, or query strings. Uncommon HTTP
methods are grouped as `OTHER`. Health/readiness probes and requests to the
separate metrics listener are excluded from application HTTP metrics.

The HTTP duration histogram has a bucket at `0.1` seconds. Its count gives the exact number of
observed server responses at or below 100 ms; later, Prometheus can estimate
percentiles from all the buckets. This measures Fastify time, while our performance
target measures client time and correct redirects. HTTP status is also separate
from GraphQL operation success: an error inside an HTTP `200` response is counted
as HTTP `200`. Operation-outcome metrics can be added in a later increment.

With `pnpm dev` running on the host:

```sh
curl http://127.0.0.1:9090/metrics
```

The host listener uses `METRICS_PORT` if supplied; containers use port 9090.
Compose leaves this port unpublished. In Kubernetes, the internal
`redirect-metrics:9090` Service selects the Fastify pods. It publishes unready
pods too, so application readiness failures do not hide monitoring. The normal
`redirect-service:3000` Service continues to select ready endpoints for user
traffic. The Gateway references only that application port.

After `pnpm k8s:up`, inspect metrics from inside a pod:

```sh
kubectl --kubeconfig .kind/kubeconfig -n shortlink exec deployment/web -- \
  node -e 'fetch("http://redirect-metrics:9090/metrics").then(r => r.text()).then(console.log)'
```

For temporary access from the Mac, forward only the private metrics Service in
one terminal, then run curl in another:

```sh
kubectl --kubeconfig .kind/kubeconfig -n shortlink port-forward \
  --address 127.0.0.1 service/redirect-metrics 19090:9090
```

```sh
curl http://127.0.0.1:19090/metrics
```

A response after two successful redirects might include:

```text
shortlink_http_requests_total{method="GET",route="/:code",status_code="302"} 2
shortlink_db_pool_connections{state="in_use"} 0
shortlink_db_pool_connections{state="idle"} 1
shortlink_db_pool_waiting_requests 0
```

The registry is per process. The monitoring configuration below discovers and
scrapes individual pods, preserving that separation when replicas are added.

## View Grafana dashboards and generate traffic

With the Kubernetes stack running, provision or update monitoring with:

```sh
pnpm monitoring:up
```

This also runs as part of `pnpm k8s:up`. Open the
[Shortlink dashboard](http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview).
It observes the Fastify pods in the kind cluster, reached by the Gateway URLs.

Log in as **admin**. The first installation generates a random password in the
ignored `.kind/grafana-admin.env` file and creates the Kubernetes Secret
`grafana-admin`. Retrieve the initial password with:

```sh
kubectl --kubeconfig .kind/kubeconfig -n shortlink get secret grafana-admin \
  -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d
```

`scripts/monitoring-up.sh` creates the Secret once. The Grafana Deployment in
`deploy/k8s/monitoring.yaml` reads it as `GF_SECURITY_ADMIN_USER` and
`GF_SECURITY_ADMIN_PASSWORD` environment variables. Grafana persists its account
in its own database on a PVC; editing the initial-password file or Secret alone
does not rotate an existing account's password.

The new infrastructure dependencies are pinned to **Prometheus v3.16.0** and
**Grafana 13.3.1**. Prometheus remains internal; Grafana uses the existing Gateway
at `grafana.localhost:8080`. Each component has a 1 GiB PVC. Prometheus retains
history for up to 24 hours, bounded to 256 MB of retained blocks. The monitoring
startup waits for both deployments and healthy Fastify scrape targets.

The checked-in files have distinct jobs:

| File                                        | Purpose                                                                          |
| :------------------------------------------ | :------------------------------------------------------------------------------- |
| `deploy/monitoring/prometheus.yaml`         | Discover the metrics Service's pod endpoints and scrape each every five seconds. |
| `deploy/monitoring/grafana-datasource.yaml` | Connect Grafana to the internal Prometheus API.                                  |
| `deploy/monitoring/grafana-dashboards.yaml` | Load dashboards from files.                                                      |
| `deploy/monitoring/shortlink.json`          | Define panels and their PromQL queries.                                          |
| `deploy/k8s/monitoring.yaml`                | Deploy the collector, UI, storage, discovery permissions, and Grafana route.     |

Prometheus queries each pod on port 9090. Grafana asks Prometheus for the recorded
history; viewing a chart does not scrape Fastify directly. The dashboard shows
request rates, server latency percentiles, HTTP statuses, cumulative `5xx`
responses in current pods, and database-pool state. Its 30-second rate windows
smooth and lag the load stages. Histogram percentiles are estimates; the client
latency target still needs client measurements.

The **Overview** combines all Fastify pods. **Pods (details)** filters the lower
section, which shows current scrape health, scrape history, redirect traffic and
p99 latency, pool clients and waiting checkouts, and `5xx` rates per pod. Select
one pod to inspect it or **All** to compare replicas; the overview remains global.
Current scrape health uses an instant query, while history charts use range
queries. The selector includes pod names observed within the chosen time range.
A chart can therefore have three colors after a replacement even when only two
pods run now. A replaced pod's historical series remains until it falls outside
the selected time range or Prometheus retention.

**Scrape targets up** and **Failed scrapes** count currently discovered targets.
They do not compare against the Deployment's desired replica count. A removed
target disappears from discovery; it does not stay present as a failed scrape.
Likewise, `UP` means the metrics listener answered, not that `/readyz` passes or
redirects work end to end. This dashboard adds no Kubernetes readiness collector
or synthetic availability probe. Pod p99 values preserve the `pod` and `le`
labels when combining histogram buckets; they are not averages of percentiles.

For dashboard-only changes, update the mounted ConfigMap without restarting
Prometheus or Grafana:

```sh
kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink -n shortlink \
  create configmap grafana-dashboards \
  --from-file=shortlink.json=deploy/monitoring/shortlink.json \
  --dry-run=client -o yaml | \
  kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink -n shortlink apply -f -
```

Allow time for Kubernetes to refresh the mounted ConfigMap and Grafana's
10-second provisioning poll, then reload the dashboard. `pnpm monitoring:up`
remains the command to reconcile the complete monitoring setup.

Run the demonstration load:

```sh
pnpm load:demo
```

The 225-second k6 scenario ramps through 100 → 500 → 1,000 → 100 redirects/s,
plus one GraphQL link creation/s. Five percent of visits deliberately request
missing codes. Setup creates 50 fixture links through REST, and the scenario
creates about 225 additional links through GraphQL. It validates redirect
destinations without following them. These demo records remain in the local DB.

The script uses a native `k6` when it is on `PATH`. Otherwise it runs the pinned
`grafana/k6:2.3.0` Docker image on the kind network. The Docker runner shares the
VM's resources with the application. Both paths traverse the TCP bridge and the
same Gateway routes. The first run below used native k6 on the Mac.

The summary is saved to `.kind/observability/last-summary.json`. After a successful
run, `.kind/observability/last-run.json` includes a dashboard URL with the exact
recorded time window. Select **Last 15 minutes** in Grafana to return to a live
view before another run. These results describe this local setup with monitoring
running; the demo is not a throughput-ceiling qualification.

The November 11, 2026 demonstration completed with:

| Measurement                               | Result |
| :---------------------------------------- | -----: |
| Total link visits                         | 98,999 |
| Existing-link visits                      | 94,049 |
| Correct `302` responses                   | 94,048 |
| Unexpected `503` responses                |      1 |
| Deliberate missing-code visits, all `404` |  4,950 |
| GraphQL creations, all successful         |    225 |
| Dropped starts                            |      0 |
| Existing-link client p99                  |  12 ms |

Grafana's recorded rate reached approximately 1,000 redirects/s. All twelve panel
queries returned time-series data, and history, provisioning, and login survived
a monitoring restart. The Docker runner's network path and summary output also
passed a one-request smoke check.

The pool waiting gauge stayed at zero at scrape times. That does not rule out a
short queue between five-second samples. The `5xx` total shows the single `503`;
its rate chart can miss the first event of a newly observed status series when
the initial counter sample is already one. This is why the dashboard includes
both cumulative totals and rates. A Grafana screenshot and query-check results
are saved under `.kind/observability/`.

## Monitor Colima and Kubernetes resources

The separate **Shortlink resources** dashboard is provisioned from
`deploy/monitoring/resources.json`. After resource-monitoring deployment, open:

```text
http://grafana.localhost:8080/d/shortlink-resources/shortlink-resources
```

The application dashboard remains focused on HTTP behavior and database pools.
The resource dashboard covers VM CPU count, utilization and time modes; memory
total and available; CPU, memory and I/O pressure stalls; Kubernetes allocatable
resources; container requests and limits; per-pod CPU and memory usage, restarts,
and readiness. **Namespaces (workloads)** filters only workload panels; the VM
and cluster-allocation sections always show the complete local environment.

The three metric sources have separate responsibilities:

| Source                                               | What it measures                                                                       | Access                                                                             |
| :--------------------------------------------------- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| Node Exporter v1.12.1 (`vm-metrics`)                 | Selected VM-wide CPU, memory, load and PSI counters                                    | No Kubernetes token or host mounts; ordinary pod reading selected `/proc` counters |
| Existing kubelet `/metrics/resource`                 | Actual container CPU time and memory working sets                                      | Prometheus token, verified TLS with kind's public kubelet serving-CA bundle        |
| kube-state-metrics v2.20.0 (`cluster-state-metrics`) | Node capacity/allocatable, container requests/limits, pod readiness and restart counts | Read-only watches of Node and Pod objects                                          |

Kubernetes provides the usage endpoint, but it does not retain this history or
provide these Grafana views by itself. `kubectl describe node` shows current
capacity and declared allocations. `kubectl top` requires Metrics Server, which
is not installed in this cluster. Metrics Server supplies the resource Metrics
API used by tools and autoscaling; it is not required for Prometheus to scrape
the existing kubelet endpoint. See the official
[resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/).

This deployment is specific to our **single-node kind cluster inside Colima**.
The node and VM share a Linux kernel. CPU count, `/proc/meminfo`, and memory PSI
read inside an ordinary pod were compared with `colima ssh` and matched the VM
counters. Node Exporter enables only CPU, meminfo, loadavg and pressure collectors;
it does not claim to monitor host filesystems, interfaces, disks, or individual
processes. Its pod is pinned to `shortlink-control-plane`. A multi-node or
multi-VM deployment needs a different collector layout and host configuration.
VM and node capacity are overlapping views, not additive resource pools. These
metrics describe the Linux guest, not macOS host pressure or physical-core use.

Provisioning with `pnpm monitoring:up` applies
`deploy/k8s/resource-metrics.yaml`, copies only the public kubelet certificate
chain to a ConfigMap, mounts it into Prometheus, and adds three scrape jobs.
Kubelet scrapes verify the serving CA and the DNS identity
`shortlink-control-plane` while discovery connects to the node IP. The existing
internal-only Services expose the exporters inside the cluster; there are no
new Gateway routes or host ports. The same setup runs through `pnpm k8s:up`.

Review the access changes before applying them:

- ServiceAccount `shortlink/cluster-state-metrics`: `get`, `list`, and `watch`
  **Nodes and Pods across the cluster**. Pod reads include workload configuration;
  they grant no Secret API access. Deployment objects are not needed or watched.
- Existing ServiceAccount `shortlink/prometheus`: `get`, `list`, and `watch`
  Nodes for discovery, plus `get` on `nodes/metrics` for
  **`shortlink-control-plane` only**. It receives no `nodes/proxy` access.
- Node Exporter has its Kubernetes token mount disabled. Neither collector uses
  host namespaces, privileged mode, host mounts, or the Docker socket.

The two collectors request **40 MiB RAM and 20m CPU combined**, with memory
limits of 64 MiB and 96 MiB. These are configured requests/limits, not measured
overhead. New time series also consume Prometheus memory and storage. The
collectors appear in their own workload charts after deployment. On this small
VM, check their actual costs before another load trial.

Allocation queries sum **scheduled Pending/Running regular containers** and
exclude completed Jobs. They omit init containers and Pod overhead, so they are
not scheduler-exact effective Pod requests. An absent limit means unbounded,
not a zero-resource ceiling. Configured limit totals may exceed VM capacity
without reserving that amount. Working-set memory, process RSS, and VM total
minus available are different measurements; use VM available memory and pressure
alongside client behavior when sizing the backing VM.

Active Pod state is matched by Pod UID and must come from the latest successful
cluster-state scrape. This prevents an old Pod retained in Prometheus lookback
after a collector restart from inflating current allocation, memory, and readiness
counts. Kubelet memory gauges use the same active-Pod filter by namespace/name;
the resource endpoint does not provide Pod UID labels.
The setup script also avoids requesting a second replacement when applying a
changed monitoring pod template has already started one.

Pressure Stall Information measures time spent waiting for CPU, memory, or I/O,
not utilization. `some` and `full` overlap and must not be summed. See the
[Linux PSI definitions](https://docs.kernel.org/accounting/psi.html). Missing
metrics stay missing instead of being rendered as healthy zeroes. Five-second
scrapes and 30-second rates smooth short events. Collection starts only after
installation and cannot reconstruct the earlier failed restart trial. All these
collectors and Prometheus share the VM; a full VM outage also interrupts them.

Verified locally on November 12, 2026 after resizing Colima to **2 CPUs / 4 GiB**:
all three resource sources and both Fastify targets were healthy; the 39 panel
queries and namespace selector executed; allocation totals matched the live Pod
specifications; and ten calculation checks covered filtering, missing limits,
CPU normalization, PSI, and retained deleted-Pod data. Guest `MemTotal` was about
3.81 GiB and matched `colima ssh`; configured VM memory also includes reservations
that are not reported as guest-usable RAM. About 2.2 GiB was available in the idle
sample. The two collectors used about 19 MiB combined working-set memory, excluding
additional Prometheus overhead. All 293 existing links and the original Postgres,
Prometheus, and Grafana PVCs survived the VM restart. These checks do not establish
the rolling-restart or throughput result at the larger allocation.

The current persisted Colima allocation is now **4 CPUs / 4 GiB**; the [CPU comparison](experiments/rolling-restarts.md#four-cpu-comparison) records
its restart-test results. The setting is stored in
`~/.colima/default/colima.yaml` (`cpu: 4`, `memory: 4`), so subsequent plain
`colima start` commands reuse it. The existing VM was resized with:

```sh
colima stop
colima start --cpus 4 --memory 4
```

This restarts the VM and its workloads. Docker and the existing kind node both
reported four CPUs afterward, with four allocatable Kubernetes CPUs. The local
Gateway bridge was recreated to refresh Docker DNS with
`docker compose -f deploy/kind/compose.yaml up -d --force-recreate`.
