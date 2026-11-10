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

Next experiment: repeat the workload with a smaller pool and measure how long
requests wait to acquire a connection. Keep the data, rates, and environment
the same so we can attribute changes to the pool more confidently.
