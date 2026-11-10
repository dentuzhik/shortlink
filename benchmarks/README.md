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
