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
