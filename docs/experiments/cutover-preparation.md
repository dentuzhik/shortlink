# Guarded cutover preparation — November 16, 2026

[Procedure and recovery rules](../database-cutover.md) · [Migration plan](../ha-migration.md)

**Result: implementation and read-only preflight prepared; live execution not run.**
This increment adds operator code and tests without deploying a new Fastify image.
The working changes are on top of `abb09ba` for review.

## Checks performed

- Lint, syntax and whitespace checks passed.
- All **64 tooling tests** passed, including phase-by-phase failures, deadline
  expiry, changed plans, ambiguous canary outcomes, interrupted aborts and
  maintenance/release authority guards.
- The isolated SQL suite passed **9 tests** on two disposable 128-MiB Postgres
  containers. It verified wrong-database refusal; atomic rejection of an
  ineffective fence through PUBLIC privileges; permission revocation on an
  existing session; marker replay past a fresh WAL boundary; monotonic sequence
  preparation; retained publisher slots; and rejection of stale prepare/setval/
  disable commands after admission. Both labelled containers were removed.
- The SQL suite is wired into the GitHub Actions integration job. This new
  workflow change has not been pushed or run on GitHub yet.
- The live read-only planning command passed, including source/HA/standby content
  verification, and `status` confirmed the generated plan still matches tooling.

## Live state retained

The final comparison at **11:50:59 Europe/Tallinn (UTC+2)** retained:

- Runtime revision **4**, source selected, creations accepted, HA prepared and
  both original Fastify pod UIDs fully acknowledging the configuration.
- Source and HA identities, application/database specifications, credential
  Secret versions and role privileges.
- **11,008 links** on source and HA; the preflight comparison also matched both
  standbys and migration history/schema.
- Source runtime INSERT/identity permissions and an enabled migration subscriber.
- Both HA identity sequences at **1, false**.
- No live `database-cutover` journal and no `shortlink_cutover` database schema.
  No marker/canary was inserted into live data and no creation gate was closed.

Private evidence:

- `.kind/db-cluster/live-cutovers/2026-11-16T09-46-13-229Z/plan.json`
- The same directory's `preflight.json` and `unchanged-live-state.json`.
- `.kind/cutover-readonly-before.json`, the comparison's initial baseline.

## Qualification boundary

These initial checks exercised policy and real PostgreSQL SQL separately. The
[successful coordinator rehearsal](cutover-success.md) subsequently passed using
the same phase engine and adapter under reduced traffic. Deliberate interruption
simulations were excluded at the user's request. Recovery after primary or host
loss remains unqualified. Before any live execution, choose explicit stop and
backup-age limits and rerun fresh preflight; plans made before the watcher repair
rollout are stale.
The 1,000/10 performance target remains a separate unqualified follow-up; the
agreed controlled learning cutover may use the reduced workload.
