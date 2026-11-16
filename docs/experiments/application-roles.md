# Runtime database roles — November 15, 2026

[Procedure](../database-application-roles.md) · [Migration plan](../ha-migration.md)

## Preparation

Starting checkpoint `79c699a` committed the previous disposable handoff. Role
preparation is commit `513fcb2`; commit `6543074` corrects an existing asynchronous
readiness assertion exposed by its CI run. No source/HA writer selection change
is part of this increment.

Two `shortlink_app` logins were provisioned with independent generated passwords.
Source uses explicit grants and a TLS-only, database-scoped authentication block.
HA uses a retained CNPG DatabaseRole/password Secret, the same explicit grants,
and equivalent authentication restrictions. Fastify's new image derives the
expected HA principal from its explicit connection URL; superuser, TLS,
primary/database/schema checks remain enabled.

Real source and HA probes each confirmed:

- Database `shortener`, user `shortlink_app`, verified TLS.
- No superuser/create-role/create-database/replication/bypass-RLS authority,
  memberships or object ownership.
- Link SELECT/INSERT, identity allocation and migration-history SELECT allowed.
- UPDATE/DELETE/TRUNCATE, schema creation, sequence reset and history writes denied.
- Five denied SQL operations, including owner impersonation, without data changes.
- Plaintext, wrong-database and wrong-password connections rejected.

Preparation and its successful repeat retained source Deployment/Pod identity,
administrator Secret version, all three HA Pod identities, live sequence values
and the existing application Pod template. Runtime revision **4** stayed source
active, creations accepted, HA prepared and fully acknowledged on both pods.
Logical replication stayed active with zero apply/synchronization errors.

Initial private preparation evidence:

- `.kind/db-cluster/application-roles/2026-11-15T20-16-50-403Z/result.json`
- `.kind/db-cluster/application-roles/2026-11-15T20-20-24-516Z/result.json`

One repeat at `20-19-25-209Z` stopped on an overly literal comparison: CNPG drops
false/empty role fields while reconciling. The helper now recognizes the omitted
false/empty representation while still rejecting elevated attributes or
memberships. A regression test covers both cases. No passwords were reset and
no application rollout occurred in that failed attempt.

## Automated checks and publication

Local checks passed: 53 backend unit tests, 44 tooling tests, all-workspace type
checks, lint and 21 Postgres/Redis integration tests. The first local integration
invocation selected the unavailable default Docker context and skipped execution;
rerunning with explicit `DOCKER_CONTEXT=colima` passed.

The first CI attempt for `513fcb2` passed application checks but failed one
existing integration assertion immediately after terminating an idle HA pool
connection. Delivery of the termination error races the next readiness checkout.
The correction waits up to two seconds for readiness recovery; it does not change
application retries, suppress failures or relax a performance threshold. The
integration suite passed locally after the correction. The failed Actions run
is retained as [43757594892](https://github.com/dentuzhik/shortlink/actions/runs/43757594892).

## Remaining qualification

The both-role disposable handoff and combined live image/credential rollout
passed below. Actual runtime sessions confirmed Fastify stopped using the old
administrator/owner logins. The reduced 25/2 workload does not replace the
outstanding 1,000/10 operating-load qualification.

## Image staging

The passing [CI run](https://github.com/dentuzhik/shortlink/actions/runs/43757867140)
for `6543074af2d40f0c4f5af79a5c7f1058f1b53bfb` completed checks, integration,
all four native image builds, browser flows, the k6/Playwright web rollout and
both multi-platform publications.

The local ARM64 API platform digest is
`sha256:6c5f16bfb77b49298c75b63da2cfb616881ea39b2406e092ad485628264e41ab`.
Its publication index digest is
`sha256:d69c1de7f72c75b55982b5d634d947e8717c8fdb00a8507a769b209cfbdaa2a7`.
The verified baked revision and kind CRI manifest identity matched this release.

The first staging wrapper timed out after 180 seconds while pulling the image;
no live Pod template changed. The operator's image-staging allowance was extended
to ten minutes (the outer load coordinator allows fifteen minutes for all staging).
Application deadlines, rollout windows and benchmark thresholds were unchanged.
A direct Docker pull completed and repeated staging passed, including the kind
runtime download of the new layer. Private failed/passing evidence:

- `.kind/db-cluster/application-roles/2026-11-15T20-31-24-048Z/result.json`
- `.kind/db-cluster/application-roles/2026-11-15T20-35-47-759Z/result.json`

## Disposable qualification development attempt

The first both-role run at
`.kind/db-cluster/handoff-rehearsals/2026-11-15T20-39-05-489Z/` passed all nine
real denied-operation checks on each role, then failed before fencing. The
fault-injection query still selected the old `shortlink_lab` login, so removing
Service endpoints left the new role's existing candidate sessions usable. The
requested failure was not actually injected, and the expected source-retention
assertion correctly failed. The fixture was removed; live serving and data were
unchanged. The query now selects `shortlink_app` and explicitly requires at least
two successful candidate-session terminations before requesting the failed switch.

## Both-role disposable handoff: passed

Private evidence:
`.kind/db-cluster/handoff-rehearsals/2026-11-15T20-40-46-724Z/result.json`.
The new published image ran in two temporary Fastify replicas. Both runtime roles
passed nine real denied-operation checks, including TRUNCATE, permanent DDL and
sequence reset only on disposable data. Fault injection closed exactly two
candidate sessions; both replicas then retained source with creation admission
closed during the deliberate failure.

At 25 existing-link redirects/s and two creation attempts/s for 90 seconds:

| Observation                                     |        Result |
| :---------------------------------------------- | ------------: |
| Correct redirects / within 100 ms               | 2,593 / 2,593 |
| Redirect p99 / maximum                          |  3 ms / 69 ms |
| Successful creations / found on destination     |     171 / 171 |
| Expected maintenance rejections                 |             9 |
| Unexpected creation outcomes / dropped starts   |         0 / 0 |
| Deliberate failure maintenance interval         |       3.659 s |
| Successful handoff maintenance interval         |       1.143 s |
| Minimum sampled application-VM available memory |  3,553.16 MiB |
| Maximum memory full-stall avg10                 |             0 |

The same source connection, PID 170, inserted before fencing, received SQLSTATE
42501 after INSERT was revoked, and continued reading 34 source links. The
barrier, complete-data comparison, sequence preparation and subscriber-stop
gates all passed before the successful pool switch. Both original fixture API
Pod UIDs remained unchanged. Source data stayed fixed after fencing, every
acknowledged creation was preserved, all live-state comparisons passed and
fixture cleanup succeeded. Host pressure samples were normal (1); VM budgets
were unchanged. These maintenance intervals apply to the disposable handoff,
not to the live credential rollout below.

## Live image and credential rollout: passed

Command:

```sh
RATE=25 CREATE_RATE=2 REDIRECT_WORKERS=4 CREATE_WORKERS=2 \
  pnpm test:app-role-rollout 6543074af2d40f0c4f5af79a5c7f1058f1b53bfb
```

k6 ran in Docker on the application VM with six preallocated workers. The
90-second trial used a 20-second baseline, 40-second rollout window and 30-second
after phase. Image and credential staging completed before traffic began.
The controller requested deployment at 22:44:12 Europe/Tallinn (UTC+2).
Its Pod-template operation changed the image and both credential sets together;
there was no runtime-control revision change or maintenance rejection interval.

| Observation                                          |        Result |
| :--------------------------------------------------- | ------------: |
| Scheduled redirect iterations                        |         2,251 |
| Immediate creation redirect probes                   |           181 |
| Correct redirects / within 100 ms                    | 2,432 / 2,432 |
| Redirect p99 / maximum                               |   3 ms / 5 ms |
| Successful creations / verified in source            |     181 / 181 |
| Creation p99 / maximum                               |   5 ms / 6 ms |
| HTTP requests / failures                             |     2,633 / 0 |
| Dropped starts                                       |             0 |
| Minimum sampled available replicas / ready endpoints |         2 / 2 |
| Coordinator-observed rollout duration                |      10.266 s |
| k6 / coordinator                                     |   PASS / PASS |

Every phase separately passed redirect correctness, 99% within 100 ms and
creation correctness. The ten setup links and 181 measured creations were
retained in source as normal test records, continuing the existing append-only
exercise convention. This was a credential/image rollout, not a live database
handoff. The reduced workload does not qualify the agreed operating target.

New serving pods:

- `redirect-service-5886448c9b-77r5p`
- `redirect-service-5886448c9b-gp9p9`

Independent image verification confirmed each Pod's actual platform digest and
build-info revision match the published image. Final SQL session checks found
**two source and two HA candidate connections**, all `shortlink_app`, all TLS,
with no remaining administrator/HA-owner runtime sessions. Source administrator
Secret version, source Postgres spec/Pod UID and all three CNPG Pod UIDs were
unchanged. The bootstrap and HA object-owner accounts retained their privileges.

Runtime revision **4** remains `creationMode: accept`, `activeDatabase: source`,
`prepareDatabase: ha`, fully acknowledged by both new pods. Neither live identity
generator on HA advanced: both remain `1, false`. The live source runtime role
has not been fenced. Logical replication remains active with no apply/sync
errors. Independent content/schema/history comparison matched **11,008 links**
on source, the HA primary and both standbys.

The rollout's inherited change-cause annotation initially named the earlier
image. Its metadata was corrected to this release without changing Pod UIDs;
future role rollouts now set that annotation with the template operation.
Local rendering was unit-tested to retain the dedicated credential references
on a later `k8s:up`; that broad bootstrap command was not rerun against live data.

Private evidence:

- `.kind/db-cluster/application-roles/2026-11-15T20-43-40-932Z/result.json`:
  pretraffic stage and both role probes.
- `.kind/db-cluster/application-roles/2026-11-15T20-44-12-708Z/result.json`:
  combined rollout, session identities and unchanged-database assertions.
- `.kind/rolling-restart/2026-11-15T20-43-52-383Z/`: `run.json`, k6 summary/log,
  acknowledged creation journal, pod/endpoint timeline and logs.
- `.kind/db-cluster/application-roles/2026-11-15T20-45-56-255Z/result.json`:
  independent final role/authentication/session verification.
- `.kind/db-cluster/live-replication-verify/2026-11-15T20-47-12-743Z/result.json`:
  complete bounded content/schema/history comparison and standby replay checks.

## Next gates

Dedicated-role preparation and deployment are complete. This increment did not
perform live cutover, advance its sequences or stop its subscriber.

On November 16 the user accepted separating controlled low-traffic cutover from
the still-unqualified 1,000/10 performance target. The next work is the
[guarded live procedure and recovery rules](../database-cutover.md), its complete
disposable rehearsal, explicit stop/recovery limits and fresh backup, stream,
endpoint, capacity and fencing preflight checks.
