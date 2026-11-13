# Rolling-restart experiment log

[Project overview](../../README.md) · Run commands from the repository root.

These are historical measurements, grouped by the configuration used at the
time. They include failed trials and the evidence that motivated changes.
Start with the [current test procedure](../performance.md) to run a new trial.
Raw `.kind/` artifacts are local and ignored by Git; the tables and conclusions
below preserve the recorded results when those artifacts are unavailable.

## Initial restart and drain trials

The first trial on November 12, 2026 **failed** on the unchanged 2-CPU / 2-GiB
Colima VM, with native k6 on the Mac:

| Measurement                                 |        Result |
| :------------------------------------------ | ------------: |
| Baseline correct redirects                  | 2,000 / 2,000 |
| Baseline client p99                         |         13 ms |
| Completed visits across the trial           |         8,750 |
| Correct redirects across the trial          |         3,012 |
| Failed or incorrect redirects               |         5,738 |
| Dropped starts                              |           251 |
| Overall client p99                          |      3,001 ms |
| Restart request to rollout completion       |        73.0 s |
| Minimum sampled Deployment availability     |             2 |
| Minimum sampled ready application endpoints |             1 |

The rollout finished after the scheduled traffic had ended. The phase named
`after` in this failed run is the fixed 60–90s window, not a successful period
after rollout completion.

The availability field alone hid the practical degradation: Fastify returned
`503`s before its shutdown signal, clients timed out, and probes failed across
Postgres, Traefik, Grafana, and the application. VM diagnostics after the trial
showed only about 123–136 MiB available memory, no swap, and substantial memory
and CPU pressure. This is strong evidence of shared VM resource contention;
it does not isolate shutdown behavior or prove a single root cause. Both
replacement Fastify pods, the Gateway, and Grafana experienced container restarts.
The stack recovered to two ready Fastify replicas after the trial. No shutdown
delay, breaker tuning, VM resize, or weakened thresholds were applied to make
this run pass. Preserve this result when comparing a later trial with more VM
capacity; zero-downtime restart behavior remains unproven.

A repeat later on November 12 used **2 CPUs / 4 GiB**, with the new resource
collectors enabled. The application image, shutdown behavior, rollout policy,
native k6 scenario, and thresholds were unchanged. The strict test still
**failed**, with a much smaller interruption:

| Measurement        | 2 GiB trial | 4 GiB repeat |
| :----------------- | ----------: | -----------: |
| Completed visits   |       8,750 |        8,973 |
| Correct redirects  |       3,012 |        8,890 |
| Failed visits      |       5,738 |           83 |
| Dropped starts     |         251 |           27 |
| Overall client p99 |    3,001 ms |      9.27 ms |
| Rollout duration   |      73.0 s |        4.6 s |

The repeat's 2,000 baseline and 3,000 post-rollout visits were all correct and
within 100ms. During the fixed restart window, 3,890 of 3,973 visits were correct
within 100ms (97.91%); that window's client p99 was 3,001ms. The failures comprise
75 timeout warnings, seven sampled `502`s, and one sampled `503`, accounting for
all 83 failed visits. The Fastify log explicitly recorded a request refused
because the server was closing, 19ms after its `SIGTERM` log. The evidence points
to a shutdown/routing handoff problem; the test did not change that behavior.
An aggregate p99 below 100ms did not capture this concentrated failure window.

Recorded VM available memory stayed above **2.04 GiB**. Memory PSI full stalls
peaked below **0.02%**; sampled 30-second CPU non-idle utilization peaked at
23.74%. These smoothed readings cannot exclude short spikes. No additional
restarts appeared in the surviving `shortlink` workload containers, and both new
Fastify pods had zero restarts. Deployment availability and ready application
endpoints were at least two in the one-second snapshots. All Fastify scrapes
sampled every five seconds were successful, illustrating that scrape health can
miss a short client-visible interruption. New monitoring overhead also differs
between the two trials, so this is not a perfectly isolated RAM-only comparison.

The repeat's artifacts are in
`.kind/rolling-restart/2026-11-12T11-26-30-521Z/`: `run.json`, `summary.json`,
`resource-report.json`, `resource-series.json`, `client-analysis.json`, shutdown
logs, events, and the pod/endpoint timeline. The resource report includes a fixed
dashboard time window. Both replacements were ready and `/readyz` returned `200`
afterward. Further shutdown coordination work remains before claiming a
zero-error restart at this load.

The next trial enabled the **5-second `preStop.sleep` hook**, keeping the same
2-CPU / 4-GiB VM, image, k6 scenario, and thresholds. It **passed**:

| Measurement                          | Before drain wait | With 5s drain wait |
| :----------------------------------- | ----------------: | -----------------: |
| Correct redirects                    |     8,890 / 8,973 |      9,001 / 9,001 |
| Failed visits                        |                83 |                  0 |
| Dropped starts                       |                27 |                  0 |
| Restart-window client p99            |          3,001 ms |               5 ms |
| Maximum client duration across trial |          3,004 ms |              17 ms |

Every redirect was correct within 100ms in each reporting window. Both
replacement pods were ready with zero container restarts afterward. The old
pods received `SIGTERM` 4.55s and 5.03s after their first observed terminating
sample; the one-second snapshots introduce observation uncertainty. Their logs
recorded **51 and 36 successful redirect completions** after endpoint withdrawal
was observed and before `SIGTERM`. Neither old pod logged a closing refusal.
This confirms that Fastify remained available during the wait rather than being
paused, and late routing/in-flight work completed successfully in this trial.

The controller reported rollout completion in 4.69s, while the last old-pod
`SIGTERM` arrived 9.76s after the restart request: rollout status can finish
before terminating processes complete their drain. Sampled availability and
ready endpoints stayed at least two. VM available memory stayed above 1.93 GiB;
memory PSI full stalls stayed below 0.035%, with no additional restarts in the
surviving `shortlink` containers. These readings and the unchanged client checks
validate this local 100-redirects/s trial, not an arbitrary load or environment.

Artifacts are in `.kind/rolling-restart/2026-11-12T11-42-07-664Z/`, including
`drain-evidence.json`, the k6 summary, raw shutdown logs, resource history and
dashboard time windows. The five-second wait remains a measured local candidate
to revisit when the traffic profile or deployment topology changes.

## Higher-traffic restart trials

Two subsequent 90-second trials kept the same 2-CPU / 4-GiB VM, two replicas,
image, five-second drain and restart timing, while raising traffic to **1,000
redirects/s plus 10 link creations/s**. Both met the target of at least 99% correct
redirects within 100ms overall and in every phase, but **both failed the stricter
zero-error continuity test**:

| Measurement                         | Initial mixed run | Preallocated-worker follow-up |
| :---------------------------------- | ----------------: | ----------------------------: |
| Redirect visits                     |            89,996 |                        90,001 |
| Correct redirects                   |            89,993 |                        89,982 |
| Application `503` responses         |                 3 |                            19 |
| Dropped starts                      |                 5 |                             0 |
| Successful link creations           |         901 / 901 |                     901 / 901 |
| Restart-window redirect client p99  |             15 ms |                         27 ms |
| Maximum redirect client duration    |            105 ms |                        128 ms |
| Overall correct redirects <= 100 ms |           99.996% |                       99.969% |

The initial run allocated 50 redirect workers and 20 creation workers up front,
with ceilings of 350 and 50. k6 grew its worker pool during the trial and dropped
five starts. The follow-up allocated those same ceilings before traffic began;
it dropped no starts. This removes runtime worker initialization as a source of
those follow-up drops, without establishing the precise cause of the initial
drops or eliminating application errors.

In the follow-up, the baseline had 19,983 correct redirects, the restart window
had 39,986 correct redirects, and the after window had 30,013 correct redirects
out of 30,032. The correct-within-100ms fractions were 100%, 99.990% and 99.920%,
respectively. All creations succeeded in each phase; restart-window creation
client p99 was 31ms. No creation latency target was added.

The first run's three `503`s were logged by an old pod before endpoint withdrawal
or `SIGTERM`. In the follow-up, all 19 failures started in a burst approximately
74.8 seconds into the trial, after the old pods had received `SIGTERM` at about
29.2s and 33.2s. Every captured body was
`{"error":"Redirect temporarily unavailable"}`, identifying the application's
Postgres checkout protection. Prometheus attributed all 19 to replacement pod
`redirect-service-7b67bbfd45-xkrbr`. At that point, the response and metrics did not
distinguish the 128-waiter cap from the 50ms checkout deadline, nor establish why
these requests reached Postgres. The diagnostic trials below investigate this. The
drain interval and protection settings were left unchanged.

In both trials, sampled Deployment availability and ready endpoints stayed at
least two, and there were no additional container restarts. In the follow-up,
the controller completed the rollout in 8.15s. The old pods logged 1,325 successful
redirect completions after endpoint withdrawal was observed and before
`SIGTERM`, with no closing refusals. VM available memory stayed above 1.84 GiB,
while the maximum sampled 30-second CPU non-idle average was 90.16% and CPU
waiting pressure reached 82.32%. CPU scheduling contention is a lead, not a
proven cause. Pool waiter gauges sampled zero; their scrape interval cannot
rule out a short checkout delay or event-loop stall.

Artifacts are in `.kind/rolling-restart/2026-11-12T11-51-37-405Z/` and
`.kind/rolling-restart/2026-11-12T11-54-23-185Z/`. Each retains its k6 summary,
shutdown timeline, drain evidence, resource history and dashboard window. The
follow-up also has `application-evidence.json` with client failure bodies and
per-pod Prometheus counters. Post-run logs from the replacement pods had already
rotated past the failure interval, so their absence of matching log lines is not
evidence of zero errors.

## Checkout rejection diagnosis

The debugging increment added the checkout outcome/reason, Redis read outcome
and event-loop metrics described in the [observability guide](../observability.md),
plus structured rejection logs. It
preserves all protection settings: five connections per pool, a 128-waiter
admission threshold, a 50ms checkout deadline, and the five-second drain. The
runner now follows replacement-pod logs as well as old-pod logs, and records
container image IDs, so rotation cannot erase the observed post-rollout burst
from a later log fetch.

The debug image passed 28 unit tests and all 14 integration tests. The new unit
tests cover queue rejection, successful checkout, deadline expiry, release of a
late connection, a late pg failure, an overdue completion before timers run and
an early pg error. The real Postgres/Redis integration test verifies one metric
event for each controlled queue-full and checkout-timeout rejection. The timeout
reporting path is idempotent: a later pg settlement does not count it again.

Two more unchanged 90-second trials ran at 1,000 redirects/s plus 10 creations/s:

| Measurement                      | First diagnostic trial | Reproduction |
| :------------------------------- | ---------------------: | -----------: |
| Redirect visits                  |                 90,001 |       90,001 |
| Correct redirects                |                 90,001 |       89,875 |
| HTTP `503` responses             |                      0 |          126 |
| Successful creations             |              900 / 900 |    900 / 900 |
| Dropped starts                   |                      0 |            0 |
| Checkout timeout events          |                      0 |           37 |
| Queue-full rejection events      |                      0 |            0 |
| Restart-window client p99        |                  25 ms |        96 ms |
| Maximum redirect client duration |                  75 ms |       361 ms |

The first run passed every threshold; the repeat reproduced the failure. Its
37 rejected checkout attempts took **50.03–96.48ms**, crossing the 50ms deadline.
The pool had **0–8 waiters** when those rejections were recorded, and the exact
queue-full counters remained zero. Coalesced followers propagated those 37
lookup failures into 126 failed HTTP redirects. Per-pod counters and retained
logs agree: 2 / 16 / 19 timeout events produced 2 / 67 / 57 HTTP `503`s across
the three affected processes. This identifies the rejection path in this
reproduction; it does not retroactively prove the cause of the previous
uninstrumented runs.

Rejections occurred 20.75–31.45s into the repeat. Redis command timeouts opened
the existing read breaker three times across two pods, each recovering after
approximately a second. Failed reads and open-circuit bypasses fall back to
Postgres, so these events explain additional database lookup attempts despite
Redis remaining deployed. The breaker was observed without changing its behavior
or thresholds. Recent event-loop delay maxima recorded with rejected checkouts
reached 88.08ms; sampled per-pod peaks reached 111.35ms. These delays are comparable
to or larger than the 50ms checkout allowance.

The 2-CPU VM reached a sampled 30-second CPU non-idle average of 89.32% and CPU
waiting pressure of 84.93%, while available memory stayed above 1.74 GiB with no
additional container restarts. This supports investigating shared CPU scheduling
and event-loop delays as contributors, but does not establish a single root cause
or prove that Postgres queries were slow. Some rejection snapshots showed idle
connections; those are snapshots after a late connection may have been released,
not proof that it was usable throughout the checkout wait. A controlled CPU
allocation comparison is a subsequent experiment, keeping deadlines fixed.

The reproduction also failed the per-phase correct-within-100ms target:
**98.73% baseline**, **98.94% restart window**, and **100% after**. Its overall
99.24% fraction and 96ms restart-window p99 do not override those failures:
correctness and latency must be assessed together, with the failures in the
denominator. Sampled availability and ready endpoints stayed at least two, and
old pods logged no closing refusals. Both replacement pods were healthy with
zero container restarts after the run. No tuning or remedial fix was applied.

Artifacts are in `.kind/rolling-restart/2026-11-12T12-36-45-485Z/` and
`.kind/rolling-restart/2026-11-12T12-39-22-155Z/`. In addition to the k6 summaries,
all-pod logs, timeline and resource reports, they contain
`checkout-diagnostics.json` and `checkout-metric-series.json` with rejection,
cache and event-loop evidence. These measurements apply to the local VM and this
traffic pattern.

## Four-CPU comparison

Later on November 12, Colima was resized from **2 CPUs to 4 CPUs**, retaining
**4 GiB** of configured memory. The existing kind cluster, Postgres, Prometheus
and Grafana PVC identities were preserved. The API, UI and collectors recovered
before testing; the Fastify container image ID matched all previous diagnostic
trials. No application image rebuild, replica increase or protection tuning was
performed: Fastify still runs two replicas with five pool connections each,
128-waiter admission, a 50ms checkout deadline and a five-second drain.

Two more 90-second trials used the same native k6 runner, preallocated worker
counts, ten warmed redirect fixtures, 1,000 redirects/s plus 10 creations/s,
Gateway route, restart timing and thresholds. Both passed every threshold:

| Measurement                         | 2 CPUs, diagnostic 1 | 2 CPUs, diagnostic 2 | 4 CPUs, trial 1 | 4 CPUs, trial 2 |
| :---------------------------------- | -------------------: | -------------------: | --------------: | --------------: |
| Test result                         |                 PASS |                 FAIL |            PASS |            PASS |
| Correct redirects                   |               90,001 |               89,875 |          90,001 |          90,001 |
| Failed redirects                    |                    0 |                  126 |               0 |               0 |
| Successful creations                |                  900 |                  900 |             901 |             900 |
| Dropped starts                      |                    0 |                    0 |               0 |               0 |
| Checkout timeouts                   |                    0 |                   37 |               0 |               0 |
| Queue-full rejections               |                    0 |                    0 |               0 |               0 |
| Redis read breaker openings         |                    0 |                    3 |               0 |               0 |
| Restart-window redirect p99         |                25 ms |                96 ms |            5 ms |            6 ms |
| Maximum redirect duration           |                75 ms |               361 ms |           36 ms |           50 ms |
| Maximum sampled event-loop delay    |             30.34 ms |            111.35 ms |        17.06 ms |        24.08 ms |
| Maximum 30s VM CPU non-idle average |               91.92% |               89.32% |          64.92% |          61.93% |
| Maximum 30s CPU waiting pressure    |               84.04% |               84.93% |          43.26% |          42.31% |

Across the four-CPU trials, **180,002 redirects were correct within 100ms** and
**1,801 creations succeeded**, with no dropped starts or checkout rejections.
The correct-within-100ms fraction was 100% in every reporting phase in each
trial. Available VM memory stayed above 1.93 GiB. Each run retained at least two
sampled available replicas and ready endpoints, recorded no additional surviving
container restarts during the test, and finished with two healthy replacement
pods. VM boot-related restarts occurred before the measurement windows.

The reduced event-loop delay, CPU waiting pressure and absence of fallback bursts
support CPU scheduling contention as a contributor to the earlier failure at
this local load. They do not isolate a single cause: the two-CPU behavior was
intermittent, the comparison occurred later, and the required VM reboot restarted
processes and cache state. Each trial recreated and warmed its own fixtures.
Four CPUs are the current tested allocation, not a measured optimum or a newly
established throughput ceiling. The 50ms protection deadline remains unchanged.

Resize identity snapshots and the four-trial summary are saved under
`.kind/cpu-comparison/`, including `comparison.json`. New run artifacts are in
`.kind/rolling-restart/2026-11-12T19-24-15-533Z/` and
`.kind/rolling-restart/2026-11-12T19-26-11-400Z/`; each includes client results,
all-pod logs, resource history, drain evidence and checkout diagnostics. The
resource report verifies four VM CPUs throughout each run. Checkout analysis
filters scrape addresses using the trial's pod timeline so older IP series
retained after the VM reboot do not inflate the rejection counts.
`last-run.json` points to the second passing four-CPU trial.
