# Redirect baseline: Postgres only

Recorded November 10, 2026 from app code at `10bd4da`. Run from the project root
with Colima running: `pnpm bench:redirect`.

One Fastify container and PostgreSQL 18.6 shared a private Compose network with
k6 2.3.0. The Colima VM was ARM64 with 2 vCPUs and about 2 GiB of RAM; the local
kind cluster was also running. Fastify used its existing five-connection pool
and request logging. The benchmark cycled evenly through 1,000 seeded links
and never followed a redirect.

After a 3-second warm-up at 20 requests/s, each measured stage ran for 10 seconds.
Achieved rate and latency below are from k6's `http_reqs` and `http_req_duration`.

| Target req/s | Achieved req/s | Requests | p95 (ms) | p99 (ms) | Incorrect redirects | Dropped iterations |
| -----------: | -------------: | -------: | -------: | -------: | ------------------: | -----------------: |
|           50 |          50.09 |      501 |     7.67 |    11.79 |                   0 |                  0 |
|          150 |         150.06 |    1,501 |     4.06 |     6.47 |                   0 |                  0 |
|          300 |         300.05 |    3,001 |     2.33 |     3.95 |                   0 |                  0 |

This run sustained the highest tested rate without finding saturation. The lower
latency at later stages does not establish that more traffic improves latency:
the stages were short, always ran in the same order, and shared VM resources.
These numbers are a local reference for the same workload.

## One vs. five Postgres connections

Run both pool limits at 1,000 requests/s for 30 seconds each:

```sh
for pool_max in 1 5; do
  BENCH_POOL_MAX="$pool_max" BENCH_RATES=1000 BENCH_SECONDS=30 pnpm bench:redirect
done
```

Each run seeds a fresh database with the same 1,000 links and warms up at
20 requests/s for three seconds. In the benchmark stack, Fastify reports
`db_pool` in the `Server-Timing` header and k6 records it as `db_pool_acquire`.
The timer ends when `pool.connect()` returns a client, before the lookup runs.
It includes any queueing and the cost of opening a connection if needed.

| Pool max | Achieved req/s | Checkout p95 (µs) | Checkout p99 (µs) | HTTP p95 (ms) | HTTP p99 (ms) | HTTP failures | Dropped iterations |
| -------: | -------------: | ----------------: | ----------------: | ------------: | ------------: | ------------: | -----------------: |
|        1 |       1,000.00 |               101 |               179 |          0.43 |          1.24 |             0 |                  0 |
|        5 |       1,000.01 |                15 |                34 |          0.46 |          1.27 |             0 |                  0 |

One connection increased checkout time, while HTTP tail latency was similar in
these short runs. An earlier run in the opposite order also showed longer
checkouts with one connection. In that run k6 dropped two scheduled iterations
with one connection, and every request it sent succeeded. The single-replica
workload uses a small dataset and redirect reads, so this comparison measures
pool behavior for that workload.

## Postgres-only load probe

Run the 30-second stages with the five-connection pool:

```sh
BENCH_POOL_MAX=5 BENCH_RATES='2000 3000 5000' BENCH_SECONDS=30 pnpm bench:redirect
```

The probe used Colima with 2 vCPUs and about 2 GiB of RAM. The three benchmark
containers shared the VM with the local kind node and a separate development
Postgres container. The default k6 scenario starts with 20 virtual users and
can add up to a limit of 60. The two 5,000 requests/s reruns used fresh stacks
and set both `preAllocatedVUs` and `maxVUs` to 60 and 120 respectively in
temporary copies of the k6 script.

| Target req/s | k6 workers (start / limit) | Achieved req/s | HTTP p95 (ms) | HTTP p99 (ms) | Checkout p99 (ms) | Dropped starts |
| -----------: | :------------------------- | -------------: | ------------: | ------------: | ----------------: | -------------: |
|        2,000 | 20 / 60                    |       1,999.92 |          0.52 |          1.48 |             0.027 |              2 |
|        3,000 | 20 / 60                    |       2,995.15 |          0.79 |          2.26 |             0.045 |            145 |
|        5,000 | 20 / 60                    |       4,990.51 |          2.15 |          5.43 |             1.710 |            279 |
|        5,000 | 60 / 60                    |       4,986.91 |          2.93 |          7.89 |             3.480 |            392 |
|        5,000 | 120 / 120                  |       4,999.37 |          2.39 |          6.48 |             1.730 |             18 |

Every issued request returned the expected `302` and `Location`. All measured
stages exceeded k6's zero-drop threshold. k6 reported reaching its worker limit
in each 5,000 requests/s run. Starting with 120 workers reduced the number of
skipped starts in the rerun, while p99 HTTP latency still exceeded 5 ms.

In the 120-worker run, the median of six Docker CPU samples was 40% for k6,
50% for Fastify, and 18% for Postgres, where 100% represents one CPU core.
Checkout and HTTP tail latency both rose at 5,000 requests/s. The CPU snapshots
can miss short spikes, and the checkout timer includes the time for Node to
resume the waiting request. These measurements leave Postgres's capacity limit
undetermined.

## Load probe with k6 on the Mac

Put [k6 2.3.0](https://github.com/grafana/k6/releases/tag/v2.3.0) on `PATH` and run:

```sh
BENCH_HOST=1 BENCH_VUS=240 BENCH_POOL_MAX=5 \
  BENCH_RATES='5000 7500 10000' BENCH_SECONDS=30 pnpm bench:redirect
```

`BENCH_HOST=1` runs k6 on the host and publishes Fastify on a temporary
loopback port. Postgres stays inside Compose. `BENCH_VUS` sets both the starting
and maximum worker count. The benchmark uses the same 1,000 links and the same
five-connection pool in both modes. Run the in-VM control with:

```sh
BENCH_VUS=240 BENCH_POOL_MAX=5 BENCH_RATES=5000 BENCH_SECONDS=30 pnpm bench:redirect
```

`db_pool_acquire` measures the time to get a connection. `db_lookup` measures the
subsequent lookup from Node, including the driver and its round trip to Postgres.

| k6 location | Target req/s | Achieved req/s | HTTP p99 (ms) | Checkout p99 (ms) | Lookup p99 (ms) | Dropped starts |
| :---------- | -----------: | -------------: | ------------: | ----------------: | --------------: | -------------: |
| Mac         |        5,000 |       4,966.18 |         51.27 |             46.76 |            2.56 |          1,007 |
| Mac         |        7,500 |       6,214.28 |         65.98 |             62.60 |            2.53 |         38,383 |
| Mac         |       10,000 |       6,397.76 |         68.31 |             63.53 |            2.49 |        107,878 |
| Colima      |        5,000 |       4,999.93 |         13.04 |              5.14 |            1.30 |              0 |

Every issued request passed both benchmark checks. The host stages failed the
zero-drop threshold and hit the 240-worker limit. The host run plateaued around
6.4k requests/s as checkout slowed, while lookup p99 stayed near 2.5 ms. At the
10k target, the median of six CPU samples was 58% for Fastify and 28% for
Postgres, where 100% represents one CPU core.

The 5k control shows that the result is sensitive to the setup. The Mac run
moved k6 outside the VM and sent requests through Colima's published port. The
control kept the whole request path inside the VM. The two runs vary both
factors, so the throughput plateau describes the host setup as tested.

## Five vs. ten connections at 7,500 requests/s

Use the Mac runner with k6 2.3.0 and run the comparison in both orders:

```sh
for pool_limit in 5 10 10 5; do
  BENCH_HOST=1 BENCH_VUS=240 BENCH_POOL_MAX="$pool_limit" \
    BENCH_RATES=7500 BENCH_SECONDS=30 pnpm bench:redirect
done
```

Each run used a fresh stack seeded with the same 1,000 links. The runner,
worker count, target rate, warm-up, and 30-second duration were the same.

| Run | Pool max | Achieved req/s | HTTP p99 (ms) | Checkout p99 (ms) | Mean lookup (ms) | Lookup p99 (ms) | Dropped starts |
| --: | -------: | -------------: | ------------: | ----------------: | ---------------: | --------------: | -------------: |
|   1 |        5 |       6,186.47 |         67.18 |             63.40 |             0.78 |            2.76 |         39,227 |
|   2 |       10 |       6,180.06 |         69.52 |             62.26 |             1.57 |            4.87 |         39,433 |
|   3 |       10 |       6,166.60 |         72.89 |             65.05 |             1.59 |            4.76 |         39,776 |
|   4 |        5 |       6,332.78 |         68.23 |             64.30 |             0.76 |            2.69 |         34,832 |

Every issued request passed both checks. All four runs hit the 240-worker
limit and failed the zero-drop threshold. Doubling the pool gave no throughput
gain, and checkout p99 stayed in the same range. With ten connections, mean
lookup time roughly doubled. That timing includes the driver, network round
trip, and Node scheduling. The comparison measures the effect of pool size on
this workload and leaves the source of the lookup slowdown open.

## Postgres vs. an in-memory redirect fixture

With k6 2.3.0 on `PATH`, run both lookups at 7,500 requests/s:

```sh
BENCH_HOST=1 BENCH_PORT=38175 BENCH_VUS=240 BENCH_POOL_MAX=5 \
  BENCH_RATES=7500 BENCH_SECONDS=30 BENCH_FIXTURE_CONTROL=1 pnpm bench:redirect
```

Both stages used the same Fastify route, request logging, Colima port, and
1,000 short codes. The runner measured Postgres first, then restarted Fastify
with an in-memory map matching the seeded links. The fixture change applies to
the compiled file in the disposable benchmark container. k6 checked the
expected `302` and `Location` and verified the timing header for each mode.

| Redirect lookup | Achieved req/s | HTTP p95 (ms) | HTTP p99 (ms) | Checkout p99 (ms) | Lookup p99 (ms) | Dropped starts |
| :-------------- | -------------: | ------------: | ------------: | ----------------: | --------------: | -------------: |
| Postgres        |       5,833.26 |         58.73 |         73.79 |             69.43 |            2.84 |         49,820 |
| In-memory map   |       7,499.89 |          1.94 |          4.03 |                 — |               — |              0 |

Every issued request passed both checks. The Postgres stage failed the
zero-drop threshold. The fixture stage delivered the target rate through the
same HTTP path. The comparison shows what bypassing the database lookup can
save in this setup. A Redis cache would have its own network and lookup costs,
and cache misses would still go to Postgres.

## Cold and warm Redis at 7,500 requests/s

Run the Postgres baseline and both Redis stages with k6 2.3.0 on `PATH`:

```sh
for redis_mode in 0 1; do
  BENCH_REDIS="$redis_mode" BENCH_HOST=1 BENCH_PORT=38175 BENCH_VUS=240 \
    BENCH_POOL_MAX=5 BENCH_RATES=7500 BENCH_SECONDS=30 pnpm bench:redirect
done
```

Both modes used the same 1,000 links, Mac runner, and loopback port. Redis mode
starts a disposable Redis service, clears it after the app warm-up, and runs
the cold stage. It then clears Redis again, visits each fixture once through
Fastify, and checks that all 1,000 keys are present before the warm stage.

| Redirect lookup | Achieved req/s | HTTP p99 (ms) | Redis hits | Postgres lookups | Dropped starts |
| :-------------- | -------------: | ------------: | ---------: | ---------------: | -------------: |
| Postgres only   |       6,091.07 |         65.88 |      0.00% |          182,898 |         42,103 |
| Cold Redis      |       7,440.31 |         18.86 |     99.53% |            1,028 |          1,785 |
| Warm Redis      |       7,497.61 |          7.15 |    100.00% |                0 |             66 |

Hit rate and lookup counts cover successful redirects in the timed stages.
The warm stage's 1,000 priming lookups are counted separately. Every issued
request returned the expected redirect. All three stages failed the zero-drop
threshold, with the warm stage skipping 66 of 225,001 scheduled starts.

Of the 21,327 successful requests that started in the first three seconds of
the cold stage, 20,299 hit Redis (95.17%). All 1,028 Postgres lookups occurred
in that window, where HTTP p99 was 106.23 ms. The full-stage numbers mostly
reflect a filled cache because the workload cycles through the same 1,000 codes.

## Hot-key expiry at 7,500 requests/s

With k6 2.3.0 on `PATH`, run three 15-second trials against one short code:

```sh
BENCH_REDIS=1 BENCH_HOT_KEY=1 BENCH_HOST=1 BENCH_PORT=38175 BENCH_VUS=240 \
  BENCH_POOL_MAX=5 BENCH_RATES='7500 7500 7500' BENCH_SECONDS=15 pnpm bench:redirect
```

The runner warms `00000001` and sets its remaining TTL to six seconds just
before each trial. All timed requests go to that code. The expiry window
includes requests k6 started within 500 ms on either side of the deadline
reported by Redis. Redis's own counters confirmed exactly one expiration per
trial, and the runner checked that the key was present again afterward.

| Trial | Achieved req/s | Redis misses | Postgres lookups | Expiry window p99 (ms) | Outside window p99 (ms) | Dropped starts |
| ----: | -------------: | -----------: | ---------------: | ---------------------: | ----------------------: | -------------: |
|     1 |       7,498.43 |           24 |               24 |                   7.68 |                    8.76 |              0 |
|     2 |       7,494.14 |           19 |               19 |                  12.40 |                    8.04 |             78 |
|     3 |       7,499.43 |           21 |               21 |                  11.38 |                    8.07 |              0 |

Every issued request returned the expected redirect. All Postgres lookups
occurred in the expiry window. One key expiration therefore caused 19 to 24
queries for the same destination before the cache filled again. The p99 effect
varied across trials. Dropped starts are counted for the full trial.

### After request coalescing

Repeating the same command with one Fastify process produced these results:

| Trial | Achieved req/s | Redis misses | Coalesced redirects | Postgres lookups | Expiry window p99 (ms) | Outside window p99 (ms) | Dropped starts |
| ----: | -------------: | -----------: | ------------------: | ---------------: | ---------------------: | ----------------------: | -------------: |
|     1 |       7,498.54 |           10 |                   9 |                1 |                   5.30 |                    9.25 |              0 |
|     2 |       7,498.93 |           39 |                  38 |                1 |                   3.59 |                    4.72 |              0 |
|     3 |       7,499.15 |            8 |                   7 |                1 |                   7.12 |                    4.68 |              0 |

Every issued request returned the expected redirect. Each trial had one Redis
expiration and one Postgres lookup in the expiry window. The other Redis misses
waited for that lookup and are counted separately from Redis hits. This shows
the reduction in database work for one hot key on one Fastify process. The
latency numbers varied between trials, including outside the expiry window.

## Hot-key expiry during a 20,000 requests/s spike

With k6 2.3.0 on `PATH`, run:

```sh
BENCH_REDIS=1 BENCH_HOT_KEY=1 BENCH_HOT_SPIKE=1 BENCH_HOST=1 \
  BENCH_PORT=38175 BENCH_VUS=800 BENCH_POOL_MAX=5 pnpm bench:redirect
```

One continuous k6 scenario reuses its worker pool across three 3-second phases:
7,500 requests/s, 20,000 requests/s, and 7,500 requests/s. All redirect traffic
goes to one code. A separate scenario probes `/healthz` at 50 requests/s. k6
tags requests by their actual start time so the spike latency is reported
separately from baseline and recovery.

The trial order is warm, expiry, expiry, warm. In the expiry trials Redis is
scheduled to expire the key about 100 ms after the spike begins; the warm trials
use the same measurement boundary and keep the key cached. The runner verifies
the expiration count and that the key is present afterward. k6 reports the
first 100 ms after the boundary separately, and checks for dropped starts,
incorrect responses, and whether close to 60,000 requests started in the spike.

The Mac drove the benchmark through Colima's published loopback port, with
one Fastify process, Redis, and Postgres in the 2-vCPU, 2-GiB VM. Dropped
starts below are across the whole trial. Postgres counts come from successful
redirects that reported a lookup in `Server-Timing`.

| Trial (800 workers) | Spike requests | Spike failures | Dropped starts | Spike p99 (ms) | First 100 ms p99 (ms) | `/healthz` spike p99 (ms) | Postgres lookups | Coalesced redirects |
| :------------------ | -------------: | -------------: | -------------: | -------------: | --------------------: | ------------------------: | ---------------: | ------------------: |
| Warm 1              |         55,769 |              0 |          4,239 |          56.70 |                 22.10 |                     45.28 |              100 |                   0 |
| Expiry 1            |         57,857 |              0 |          2,079 |          70.46 |                 22.86 |                     57.67 |                1 |                 131 |
| Expiry 2            |         52,657 |             28 |          7,103 |          85.98 |                 22.62 |                     64.30 |              306 |                 267 |
| Warm 2              |         56,122 |              0 |          3,559 |          83.30 |                 15.20 |                     63.45 |              194 |                   0 |

The first 100 ms contained 1,962 to 2,000 starts in each trial. The expiry
trials had 132 and 268 Redis misses, respectively, with one fewer coalesced
redirect in each. All health probes succeeded with 800 workers.

Repeating with `BENCH_VUS=1600` still fell short. The table separates
transport failures from HTTP 5xx responses during the spike. Health failures
are counted across all 450 probes per trial.

| Trial (1,600 workers) | Spike requests | Dropped starts | Transport failures | HTTP 5xx | Health failures | Spike p99 (ms) | First 100 ms p99 (ms) | Postgres lookups | Coalesced redirects |
| :-------------------- | -------------: | -------------: | -----------------: | -------: | --------------: | -------------: | --------------------: | ---------------: | ------------------: |
| Warm 1                |         54,722 |          4,959 |                596 |        0 |              51 |          89.85 |                 35.97 |              223 |                   0 |
| Expiry 1              |         56,235 |          3,239 |                597 |        0 |              46 |          81.38 |                 26.60 |              263 |                 111 |
| Expiry 2              |         56,374 |          3,042 |                597 |        0 |              45 |          72.32 |                 69.54 |              111 |                 857 |
| Warm 2                |         55,950 |          3,609 |                598 |        1 |              46 |          83.50 |                 34.02 |              118 |                   0 |

Redis recorded one expiration in each expiry trial, roughly 100 ms into the
spike. There were 112 and 858 Redis misses, respectively. All but one miss in
each trial had a matching coalesced redirect. Client starts for those redirects
were within 31 ms of the scheduled expiry. Their HTTP p99 was 16.70 ms and
81.65 ms, respectively. In the slower trial, k6 started only 1,395 requests in
the first 100 ms after the boundary; the other three trials started 2,000 each.

Every measured trial fell short of the 60,000 starts expected during the spike.
Even the warm controls had Postgres lookups despite zero Redis misses. The app
falls back to Postgres when a Redis read fails, and this path bypasses
coalescing. These runs verify that requests shared the cache refill during the
spike, but the warm controls also degraded, so the test cannot isolate a
capacity limit or establish that expiry has no latency cost.

## Redirect latency budget with concurrent link creation

At **1,000 redirect requests/s and 10 link creation requests/s for 30 seconds**,
at least **99% of requests for existing short codes must return the correct
`302` and `Location` within 100 ms**, measured from the client. Each trial must
meet the target with Redis healthy or with Redis reads timing out.

With k6 2.3.0 on `PATH`, run:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 pnpm bench:redirect
```

The benchmark primes 1,000 fixture codes before each trial. Each measured run
schedules 1,000 redirects/s and 10 `POST /links` requests/s for 30 seconds.
There are three runs per condition, alternating which condition goes first in
each pair. Fastify talks to Redis through Toxiproxy in both conditions. The
timeout trials delay Redis replies by 75 ms, past Fastify's 25 ms Redis command
timeout. Response headers verify that healthy redirects use Redis and that
redirects in the timeout trials use Postgres or share an in-flight lookup.

The client times each request through the redirect response. Slow or incorrect
redirects count against the 100 ms score. The 200 and 300 ms cutoffs are also
reported. A valid run has zero dropped starts and completes at least 29,999
redirect and 299 link creation iterations, allowing one iteration per scenario
at the scheduling boundary. Every link creation must return `201`. k6 reports
link creation latency and the pool checkout and query times Fastify supplies in
`Server-Timing`.

| Trial     | Redirects | Redirect p99 (ms) | Slowest redirect (ms) | Link creation p99 (ms) | Pool checkout p99 (ms) |
| :-------- | --------: | ----------------: | --------------------: | ---------------------: | ---------------------: |
| Healthy 1 |    30,000 |                 3 |                    10 |                      6 |                      — |
| Timeout 1 |    30,001 |                28 |                    45 |                      5 |                  0.064 |
| Timeout 2 |    30,000 |                30 |                    55 |                      5 |                  0.060 |
| Healthy 2 |    30,000 |                 2 |                     8 |                      5 |                      — |
| Healthy 3 |    30,001 |                 3 |                    10 |                      4 |                      — |
| Timeout 3 |    30,001 |                28 |                    33 |                      4 |                  0.051 |

All 180,003 redirects were correct and within 100 ms, so all three cutoffs
scored 100%. All 1,806 creations returned `201` and k6 dropped zero starts.
Every measured healthy redirect hit Redis and every timeout redirect queried
Postgres. The steady load generated little pool contention, with checkout p99
below 0.1 ms in all timeout trials.

### Headroom with Redis reads timing out

Run two 30-second trials at each higher redirect rate, reversing the order in
the second pair. Link creation stays at 10 requests/s and the pool has five
connections. The benchmark applies the same 100 ms check at each rate.

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_RATES='1500 2000 2000 1500' \
  BENCH_BUDGET_CASES=timeout pnpm bench:redirect
```

| Redirects/s | Redirects | Redirect p99 (ms) | Slowest redirect (ms) | Pool checkout p99 (ms) | DB lookup p99 (ms) | Link creation p99 (ms) |
| ----------: | --------: | ----------------: | --------------------: | ---------------------: | -----------------: | ---------------------: |
|       1,500 |    45,000 |                32 |                    59 |                  0.301 |               2.06 |                     11 |
|       2,000 |    60,001 |                32 |                    61 |                  0.952 |               2.13 |                      8 |
|       2,000 |    60,001 |                33 |                    54 |                   1.22 |               2.14 |                      9 |
|       1,500 |    45,001 |                30 |                    49 |                  0.092 |               1.31 |                      8 |

All 210,003 redirects queried Postgres and returned the correct destination
within 100 ms. All 1,202 link creations returned `201`, and k6 dropped zero
starts. Pool checkout p99 rose from below 0.1 ms at the 1,000/s baseline to
roughly 1 ms at 2,000/s. The 2,000/s trials establish steady load headroom above
the target on this local setup. Choosing an entry limit also requires a burst
profile and measurements on the deployment it will protect.

### Throughput ceiling at 100 ms

The ceiling probe holds link creation at 10 requests/s, uses five Postgres
connections, and varies the offered redirect rate on the local Compose stack.
Each condition is measured separately. A passing rate delivers the scheduled
load with zero dropped starts, returns `201` for every creation, and returns
the correct redirect within 100 ms for at least 99% of redirect attempts.

Run the initial 30-second sweep with k6 2.3.0 on `PATH`:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_RATES='2500 3000 4000' \
  BENCH_BUDGET_CASES='healthy timeout' pnpm bench:redirect
```

| Redis condition | Redirects/s | Within 100 ms | Redirect p99 (ms) | Pool checkout p99 (ms) | DB lookup p99 (ms) | Creation p99 (ms) | Dropped starts |
| :-------------- | ----------: | ------------: | ----------------: | ---------------------: | -----------------: | ----------------: | -------------: |
| Healthy         |       2,500 |          100% |                 4 |                      — |                  — |                 7 |              0 |
| Timeout         |       2,500 |          100% |                51 |                  14.92 |               3.03 |                17 |              0 |
| Healthy         |       3,000 |          100% |                 4 |                      — |                  — |                 9 |              0 |
| Timeout         |       3,000 |          100% |                64 |                  28.20 |               3.54 |             40.20 |              0 |
| Healthy         |       4,000 |          100% |                 6 |                      — |                  — |                 9 |              0 |
| Timeout         |       4,000 |        81.90% |               152 |                 119.77 |               4.63 |               128 |          4,491 |

At 4,000/s with Redis timing out, 81.90% of the 115,510 redirects that k6
started met the target. Pool checkout p99 exceeded the entire 100 ms budget
while lookup p99 remained below 5 ms. The run also exhausted its 400 k6
workers, so the boundary check uses more workers to see whether the service
can receive the full offered load.

Probe the timeout boundary for 45 seconds with larger k6 worker allowances:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_SECONDS=45 BENCH_VUS=800 \
  BENCH_RATES='3500 4000' BENCH_BUDGET_CASES=timeout pnpm bench:redirect

BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_SECONDS=45 BENCH_VUS=1200 \
  BENCH_RATES='3250 3500 3250' BENCH_BUDGET_CASES=timeout pnpm bench:redirect

BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_SECONDS=45 BENCH_VUS=400 \
  BENCH_RATES='3000 3250' BENCH_BUDGET_CASES=timeout pnpm bench:redirect
```

| k6 workers | Redirects/s | Within 100 ms | Redirect p99 (ms) | Pool checkout p99 (ms) | DB lookup p99 (ms) | Creation success | Dropped starts |
| ---------: | ----------: | ------------: | ----------------: | ---------------------: | -----------------: | ---------------: | -------------: |
|        800 |       3,500 |        75.70% |               244 |                 211.61 |               5.13 |             100% |            575 |
|        800 |       4,000 |        35.63% |               250 |                 218.48 |               5.67 |             100% |          5,168 |
|      1,200 |       3,250 |        94.96% |             2,000 |                  77.27 |               4.43 |           44.00% |              0 |
|      1,200 |       3,500 |        94.33% |             2,000 |                  85.74 |               4.27 |           37.33% |              0 |
|      1,200 |       3,250 |        95.49% |             2,000 |                 108.21 |               4.23 |           44.00% |              0 |
|        400 |       3,000 |          100% |                64 |                  29.43 |               3.74 |             100% |              0 |
|        400 |       3,250 |          100% |                58 |                  26.40 |               3.43 |             100% |              0 |

The 1,200-worker runs delivered all scheduled starts, with HTTP transport
failures on both endpoints. In both 3,250/s trials, more than 1% of redirect
attempts also returned the correct result too late. The last pair returns to
the original 400 workers to compare the two closest rates under the same setup
as the initial sweep.

Run a matched 30-second comparison with the original worker count:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=400 BENCH_RATES='3500 3250' \
  BENCH_BUDGET_CASES=timeout pnpm bench:redirect
```

| Redirects/s | Within 100 ms | Redirect p99 (ms) | Pool checkout p99 (ms) | DB lookup p99 (ms) | Creation p99 (ms) | Dropped starts |
| ----------: | ------------: | ----------------: | ---------------------: | -----------------: | ----------------: | -------------: |
|       3,500 |        94.78% |               139 |                 104.46 |               4.63 |            114.01 |            939 |
|       3,250 |          100% |                74 |                  37.14 |               3.57 |                43 |              0 |

With 400 workers, 3,250/s passed both the 30- and 45-second trials. At 3,500/s,
all 104,062 redirects that started returned the correct destination, but only
94.78% did so within 100 ms. Every creation in the matched pair returned `201`.
The local benchmark puts the 100 ms throughput ceiling for Redis timeouts
between the tested rates of 3,250 and 3,500 redirects/s. Use **3,250 redirects/s**
as the validated local ceiling during Redis timeouts, with five Postgres
connections and 10 link creations/s. Healthy Redis passed at 4,000/s in the
initial sweep.

### Ceiling with healthy Redis

The healthy sweep uses the same five Postgres connections, 10 link creations/s,
and 100 ms target. The 1,000 fixture codes are primed before each trial, and
Redis replies pass through the benchmark proxy without added delay.

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=400 BENCH_RATES='5000 6500 8000' \
  BENCH_BUDGET_CASES=healthy pnpm bench:redirect

BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=800 BENCH_RATES='10000 15000 20000' \
  BENCH_BUDGET_CASES=healthy pnpm bench:redirect
```

The first sweep passed at all three rates. All 585,007 redirects hit Redis and
met the 100 ms target. All 902 creations returned `201`, with zero dropped
starts. Redirect p99 was 7 ms at 5,000/s, 13 ms at 6,500/s, and 16 ms at 8,000/s.

| Offered redirects/s | Redirects started | Within 100 ms of started | Redirect p99 (ms) | Creation p99 (ms) | Postgres lookups | Dropped starts |
| ------------------: | ----------------: | -----------------------: | ----------------: | ----------------: | ---------------: | -------------: |
|              10,000 |           300,007 |                   99.84% |                48 |               127 |              130 |              1 |
|              15,000 |           440,912 |                   99.69% |                68 |            270.10 |              791 |          9,093 |
|              20,000 |           493,412 |                   99.27% |                84 |             1,760 |            2,681 |        106,590 |

Every creation returned `201` in the higher sweep. All three trials failed
the zero-drop and all-cache-hit checks. At 20,000/s, k6 started roughly 16,450
redirects/s during the 30-second window, while link creation p99 reached 1.76 s.
The 99.27% latency score covers the requests k6 started.

Repeat near the full-load boundary with the original worker count:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=400 BENCH_RATES='9000 10000 12500' \
  BENCH_BUDGET_CASES=healthy pnpm bench:redirect
```

With 400 workers, the 9,000, 10,000, and 12,500/s runs dropped 132, 289, and
3,217 starts respectively. At 12,500/s, every started redirect hit Redis and
99.98% met 100 ms. To check the effect of stepping directly to full load, ramp
from 1,000/s over eight seconds and start the 30-second measurement and creation
traffic after the ramp. The no-drop check covers both phases.

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=800 BENCH_BUDGET_RAMP_SECONDS=8 \
  BENCH_RATES='10000 15000 20000' BENCH_BUDGET_CASES=healthy pnpm bench:redirect
```

| Offered redirects/s | Redirects started after ramp | Within 100 ms of started | Redirect p99 (ms) | Creation p99 (ms) | Dropped starts including ramp |
| ------------------: | ---------------------------: | -----------------------: | ----------------: | ----------------: | ----------------------------: |
|              10,000 |                      299,076 |                   99.78% |                61 |            151.76 |                           930 |
|              15,000 |                      433,293 |                   99.55% |                77 |               338 |                        16,722 |
|              20,000 |                      496,788 |                   99.73% |                75 |            438.23 |                       104,851 |

The ramped trials also fell short of the offered load. All creation requests
returned `201`. At 20,000/s, k6 started about 16,560 redirects/s during the
measured window.

Check the full-load boundary again with 400 workers and a direct start:

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=400 BENCH_RATES='8500 8000' \
  BENCH_BUDGET_CASES=healthy pnpm bench:redirect
```

| Offered redirects/s | Redirects started | Within 100 ms of started | Redirect p99 (ms) | Postgres lookups | Dropped starts |
| ------------------: | ----------------: | -----------------------: | ----------------: | ---------------: | -------------: |
|               8,500 |           254,931 |                   99.93% |                23 |               16 |             69 |
|               8,000 |           239,360 |                   99.90% |                23 |               84 |            640 |

The highest full-load, all-cache-hit pass was the initial 8,000/s run. The
8,000/s repeat dropped starts, so the result varied between runs. At higher
rates the local setup fell short of delivering the requested load while
started redirects continued to meet the 99% latency threshold. These trials
show the limit of what the local benchmark verified with healthy Redis. They
leave the service's 100 ms ceiling open at higher delivered rates.

### Redirect admission under Redis timeouts

The redirect checkout guard rejects a new Postgres lookup when the shared pool
has 128 waiting checkouts or the redirect spends 50 ms acquiring a connection.
These initial settings are configurable with `REDIRECT_DB_MAX_WAITERS` and
`REDIRECT_DB_CHECKOUT_TIMEOUT_MS`. Redis hits bypass checkout and coalesced
requests share the leader's admission result. Rejected redirects receive `503`
and count against the 100 ms correctness target.

```sh
BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 BENCH_PORT=38175 \
  BENCH_POOL_MAX=5 BENCH_VUS=400 BENCH_RATES='1000 3250 4000' \
  BENCH_BUDGET_CASES=timeout pnpm bench:redirect
```

| Redirects/s | Correct within 100 ms | `503` responses | Successful redirect p99 (ms) | `503` p99 (ms) | Pool checkout p99 (ms) | Creation p99 (ms) | Dropped starts |
| ----------: | --------------------: | --------------: | ---------------------------: | -------------: | ---------------------: | ----------------: | -------------: |
|       1,000 |                  100% |               0 |                           28 |              — |                  0.071 |                 5 |              0 |
|       3,250 |                99.65% |             339 |                           69 |             87 |                  35.34 |             42.04 |              0 |
|       4,000 |                97.30% |           3,230 |                           76 |             90 |                  42.17 |                55 |              0 |

Each trial ran for 30 seconds with 10 creations/s. All creation requests
returned `201`. The 1,000 and 3,250/s trials met the target. At 4,000/s, the
benchmark failed the correctness target because 2.70% of redirects received
`503`. Successful redirects had a 76 ms p99, and the load generator delivered
the full offered load. Compare this with the earlier unguarded 4,000/s trial,
where redirect p99 was 152 ms and k6 dropped 4,491 starts. These are separate
local runs, so the comparison includes run-to-run variation.

### Continuous Redis outage and recovery

```sh
BENCH_REDIS_RECOVERY=1 BENCH_LATENCY_BUDGET=1 BENCH_REDIS=1 BENCH_HOST=1 \
  BENCH_PORT=38175 BENCH_POOL_MAX=5 BENCH_VUS=400 \
  BENCH_RATES='1000 3250' pnpm bench:redirect
```

Each rate runs one continuous 45-second k6 trial with 10 link creations/s.
After priming the 1,000 fixture codes, the controller schedules 15 seconds of
healthy Redis, 15 seconds with 75 ms of downstream response latency, then
15 seconds after removing the fault. It uses the host clock shared with native
k6 and logs the completion lag of each control command. A lag above 500 ms
invalidates the trial. The runner stops after a failed rate.

Each phase independently requires at least 99% correct redirects within 100 ms,
successful link creations, and delivery of the offered load. Errors, including
`503`, count as failed redirects. Zero dropped starts and the total request count
are checked across the whole trial. Small per-phase count tolerances accommodate
the k6 setup handoff. These 15-second transition checks supplement the agreed
30-second steady-state performance target.

For correct responses, the healthy phase must use Redis; the stable fault window
(seconds 18–27) must use Postgres or a coalesced lookup; and the final five seconds
must use Redis again. Redis `INFO commandstats` snapshots independently count
actual `GET` commands during the stable fault window, where the breaker should
allow roughly one recovery probe per second. Service logs must show the circuit
opening during the fault and closing after restoration. The load stays on while
the fault is added and removed.

Recorded on November 11, 2026, using the same local Colima VM, five Postgres
connections, and 400 redirect VUs:

| Redirects/s | Phase    | Started redirects | Correct within 100 ms | Redirect p99 (ms) | `503` responses | Creation p99 (ms) |
| ----------: | :------- | ----------------: | --------------------: | ----------------: | --------------: | ----------------: |
|       1,000 | Healthy  |            14,999 |                  100% |                 4 |               0 |                 7 |
|       1,000 | Delayed  |            15,000 |                  100% |                 5 |               0 |                 6 |
|       1,000 | Recovery |            15,002 |                  100% |                 3 |               0 |                 6 |
|       3,250 | Healthy  |            48,743 |                  100% |                 6 |               0 |             10.04 |
|       3,250 | Delayed  |            48,750 |              99.9959% |                22 |               2 |             24.51 |
|       3,250 | Recovery |            48,760 |                  100% |                 6 |               0 |             10.50 |

Both initial completed trials passed every threshold, had zero dropped starts, and
created 451 links successfully. The two rejected redirects at 3,250/s count
against the delayed phase's correctness result. All other redirects met 100 ms.
The fault raised latency while keeping it inside the target.

The stable fault windows recorded nine Redis `GET`s each, over approximately
9.10 seconds at 1,000/s and 9.07 seconds at 3,250/s. This is about one read/s while
thousands of redirects/s continued through Postgres. Failed half-open probes
reopened the circuit during the fault. After removing the delay, the circuit
closed in approximately 0.41 and 0.47 seconds, respectively. Correct redirects
in the final five seconds all came from Redis. Recovery-phase hit rates were
97.23% and 97.03%; early recovery requests still used Postgres until a probe
succeeded.

The first 3,250/s attempt was discarded when fault injection took 280 ms and
exceeded the controller's original 250 ms tolerance. The controller now resolves
container IDs before the trial and uses direct `docker exec`, with a 500 ms
timing tolerance. On the completed retry, fault addition/removal finished 68/71
ms after their scheduled boundaries.

The final combined command was repeated after adding completed-iteration
thresholds, which prevent requests interrupted at the end of the test from
disappearing from the result. The 1,000/s repeat passed every check: all redirects
were correct within 100 ms, p99 was 3/4/2 ms across the three phases, and all
451 creations succeeded. The 3,250/s repeat produced:

| Phase    | Started redirects | Correct within 100 ms | Redirect p99 (ms) | `503` responses | Creation p99 (ms) | Cache hits |
| :------- | ----------------: | --------------------: | ----------------: | --------------: | ----------------: | ---------: |
| Healthy  |            48,748 |              99.3169% |                17 |             262 |             31.89 |     92.85% |
| Delayed  |            48,750 |              99.8646% |                26 |              66 |             15.04 |      0.68% |
| Recovery |            48,752 |                  100% |                 5 |               0 |              9.51 |     96.80% |

This repeat met the latency/correctness target in every phase, completed the
offered load with zero dropped starts, and created all 450 links successfully.
It **failed the healthy-phase cache-source check**: the circuit opened at
+3.180 seconds, before the scheduled fault at +15 seconds, then closed at
+4.180 seconds. Opening requires five Redis read failures. The existing logs
do not establish whether Redis latency, network delay, or an application/VM
pause caused those failures. Correct fallback responses during this period
violate the benchmark's all-cache-hit premise for its healthy phase.

The repeat still recorded nine Redis `GET`s during each approximately nine-second
stable fault window. The circuit closed at +30.429 seconds at 1,000/s and
+30.579 seconds at 3,250/s; fault removal completed at +30.047 and +30.071 seconds.
The final five seconds used Redis for every correct redirect at both rates.

Keep the early trip as a finding to investigate before tuning the 25 ms Redis
timeout or the breaker's five-failure threshold. These runs demonstrate recovery
and bounded reads during the injected delay, while showing variation before
the fault at 3,250/s. They do not establish a higher throughput ceiling or
guarantee zero service degradation.
