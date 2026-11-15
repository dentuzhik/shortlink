# HA connection target preparation — November 15, 2026

[Pool control and procedure](../database-pool-switching.md) · [Migration plan](../ha-migration.md)

**Result:** the real HA target is staged and validated in both deployed Fastify
replicas. Source remains the selected application database, and creations remain
enabled. The first load trial was interrupted by a tooling comparison error;
the corrected full trial failed its client thresholds. This is successful
connection preparation, not a passing load qualification or a database cutover.

## Deployed configuration

The Fastify image is unchanged: commit
`cfd1d5ff1ea14757f5e40bdb97229314a515a27f`, ARM64 manifest
`sha256:ef2f3c71824e093a7ff75b6e9b95748e2285f55b2731076901afd1ca52327dba`.
The application VM remains six CPUs/six GiB; the database VM remains four/four.
No VM, source Postgres, Redis, Next.js or CNPG configuration change was made.

The application namespace now contains immutable Secret `fastify-ha-target`
with the HA application URL and public CA. Fastify's Pod template references the
URL through `secretKeyRef` and mounts only `ca.crt` read-only. The CA private key
was not copied. TLS verifies `db-lab-primary.shortlink.svc.cluster.local`, through
the existing private cross-VM Service/bridge to CNPG's current primary.

The target database is `shortener`, and the nonsuperuser login is
`shortlink_lab`. Runtime revision **4** is fully acknowledged by both replicas:

```json
{
  "revision": 4,
  "creationMode": "accept",
  "activeDatabase": "source",
  "prepareDatabase": "ha"
}
```

Both report `candidateReady: true`, `preparedDatabase: ha`, source as their
actual/desired active database, and no error. CNPG primary `shortlink-lab-1`
shows two idle application candidate connections using TLS 1.3, one per replica.
Validation checks identity, primary status, TLS, expected schema and privileges
using SELECT queries; it does not insert links. The destination links sequence
remains at 1 with `is_called: false`. Correcting sequences before destination
writes remains a required future handoff step.

## First attempt and test correction

The trial began at 19:54:59 Europe/Tallinn (UTC+2). The rolling update and HA
preparation both succeeded, but the operator's final template invariant compared
hashes of serialized JSON. Kubernetes reordered object keys, incorrectly causing
an "Unexpected Fastify template change" failure. Structural equality confirmed
the intended template. The check now uses structural comparison; tooling tests
also cover reordered map keys.

The runner interrupted k6 after approximately 35 seconds. All **35,427** recorded
redirect checks were correct and within 100 ms, and all **351** creations
succeeded, but the planned trial duration/after phase was not completed. The
attempt remains failed. All 351 acknowledged code/destination pairs were checked
in both source and HA after interruption.

For the repeat, runtime revision 3 cancelled only the candidate while keeping
source active and creation admission open. The operator restored the previous
same-image source-only Pod template from its ReplicaSet and waited for both pods
to stabilize. The immutable target Secret was retained. This reset happened
before the new trial, with no database authority transfer. Returning to a source
configuration after HA has accepted application writes would require a different,
qualified data-return procedure.

## Full repeat: connection checks pass, load trial fails

19:59:08–20:00:38 Europe/Tallinn (UTC+2), with **1,000 scheduled redirects/s plus
ten creations/s for 90 seconds**. Each creation also immediately verifies its
redirect, adding probe reads. The phases remain 20 seconds baseline, a 40-second
rollout window and 30 seconds after. The same deployed image was already cached.

| Phase          | Measured redirects | Correct and ≤100 ms | Redirect p99 | Redirect errors | Creations |
| :------------- | -----------------: | ------------------: | -----------: | --------------: | --------: |
| Baseline       |             20,187 |             98.167% |    219.14 ms |              14 |       200 |
| Rollout window |             40,401 |             99.757% |         3 ms |              32 |       400 |
| After          |             30,302 |                100% |         2 ms |               0 |       301 |

- Overall: **89,989** scheduled redirects plus **901** immediate probes;
  **90,844 of 90,890** measured redirects correct, **46** errors.
- Correct redirects within 100 ms: **90,422 / 90,890 (99.485%)** overall.
  The separate baseline phase failed the agreed 99% condition.
- Failed HTTP requests: **46 of 91,811**. Dropped starts: **12**.
- Creations: **901/901** correct and immediately usable. Creation p99 21 ms,
  maximum 337 ms; there is no separately invented creation latency threshold.
- Combined rollout, HA preparation and verification completed **13.036 seconds**
  after the request, inside the 40-second window. Actual Pod replacement/removal
  took 10.602 seconds; HA preparation then completed in 0.629 seconds.
- Minimum sampled available Fastify replicas / ready endpoints: **2 / 2**.
  Up to four Pod objects existed because terminating pods briefly overlapped.
- k6 exit 99; runner result **FAIL**. The data verification below was performed
  independently because the runner exits its success path after failed thresholds.

Redirect failures were already observed during baseline, before requesting the
HA wiring rollout. macOS memory pressure was observed at warning level 2 during
this run and remained there in the preserved diagnostic. These observations do
not establish the root cause of all failures or clear the rollout of any impact.
The previous clean image-deployment trial does not override this failed result.
No resource settings, traffic levels or thresholds were changed to obtain a pass.

## Data and limits

Source links increased from **9,545 to 10,817**: 351 acknowledged creations and
ten setup links in the interrupted attempt, then 901 and ten in the repeat.
All **1,252** acknowledged code/destination pairs matched source and HA. The
subsequent read-only comparison matched full bounded contents, schema and
migration history on source, the HA primary and both physical standbys, with an
active TLS migration stream and zero recorded apply/sync errors. This verifies
catch-up after traffic, not each link's replication delay when it was acknowledged.

Source remains authoritative for creations and redirect database misses; Redis
continues serving cached positives. HA receives source changes through the
existing logical subscription. HA candidate validation is not writer fencing,
a final replication barrier, sequence correction, qualified backup/restore,
HA failover testing, or a writer-handoff rehearsal. The full load qualification
also remains failed and requires investigation before claiming a clean migration
under this workload.

## Evidence

Private Git-ignored paths relative to the repository:

- `.kind/db-cluster/ha-target-preparation/2026-11-15T17-54-57-855Z/`:
  initial Secret staging record; no credential data in the report.
- `.kind/rolling-restart/2026-11-15T17-54-59-415Z/`: interrupted trial and its
  independent `post-trial-cohort-verification.json`.
- `.kind/db-cluster/ha-target-preparation/2026-11-15T17-58-04-320Z/`:
  corrected read-only validation of the first prepared candidates.
- `.kind/db-cluster/ha-target-rehearsal-reset/2026-11-15T17-58-43-961Z/`:
  source-only rehearsal reset and first-cohort checks.
- `.kind/rolling-restart/2026-11-15T17-59-07-724Z/`: full failed trial, summary,
  timeline, pod logs, acknowledged creation journal, independent cohort check,
  host/guest pressure diagnostic and exact harness snapshots/hashes.
- `.kind/db-cluster/ha-target-preparation/2026-11-15T17-59-28-121Z/`:
  successful configuration rollout, runtime acknowledgements, TLS sessions and
  unchanged source/CNPG wiring checks.
- `.kind/db-cluster/ha-target-preparation/2026-11-15T18-01-27-031Z/`:
  post-load read-only candidate validation.
- `.kind/db-cluster/live-replication-verify/2026-11-15T18-01-28-295Z/`:
  full source/primary/both-standby data comparison at 10,817 links.
