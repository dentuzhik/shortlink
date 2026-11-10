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
