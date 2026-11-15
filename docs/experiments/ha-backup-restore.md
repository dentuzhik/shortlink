# HA database backup and restore — November 15, 2026

[Procedure](../database-recovery-ha.md) · [Migration plan](../ha-migration.md)

**Result: passed after correcting clone authentication.** The HA primary's
`shortener` database was exported to the Mac, restored into a disposable
same-image Postgres container, verified and the clone removed. Live Fastify
continued using source, with no deployment or maintenance change.

## Environment and scope

- Reviewed checkpoint: `66d6454`, committed before the new recovery increment.
  Recovery tooling was an uncommitted diff on top of that checkpoint.
- HA export: `kind-shortlink-db`, namespace `database-lab`, CNPG
  `shortlink-lab`, primary `shortlink-lab-1`, database `shortener`.
- PostgreSQL 18.7 image:
  `ghcr.io/cloudnative-pg/postgresql:18.7-system-trixie@sha256:5a5dfbde88d5909fd4938189c141f53fb153f53c519f14907dce9e7c04baa153`.
- Locale: UTF8, libc, `en_US.utf8` collation/ctype, collation version 2.41.
- Clone: Docker context `colima`, fresh labelled volume, one CPU, 512 MiB,
  loopback-only random port and fresh nonsuperuser `shortlink_lab` password.
- VM allocations unchanged: application six CPUs/six GiB; database four/four.
- Fastify image stayed `cfd1d5f`; runtime revision 4 remained source active,
  creation accepted and HA prepared. Both Fastify pod identities were unchanged.
- No injected load. Fastify application checks used local injection against the
  clone with Redis disabled; no test creation targeted either live database.

## Passing run

20:36:09–20:36:16 Europe/Tallinn (UTC+2). Package compilation preceded the
measured script duration.

| Measurement                                   |        Result |
| :-------------------------------------------- | ------------: |
| Full script, including preflight and cleanup  |       6.990 s |
| Compressed custom archive                     | 220,017 bytes |
| Dump/transfer to the Mac                      |     109.40 ms |
| Clone provisioning and TOC verification       |       1.481 s |
| Applying archive to the running clone         |      78.87 ms |
| Provisioning through application verification |       2.248 s |
| Links restored before tests                   |        10,817 |
| Migration-history rows restored               |             1 |
| Existing-link redirects checked               |            10 |
| REST/GraphQL creations on clone               |         2 / 2 |
| Sampled source HTTP checks / failures         |        18 / 0 |
| Temporary container / volume removed          |     Yes / Yes |

The phase timings are not additive: provisioning-through-application time
includes clone provisioning and the archive application. This small, cached-image
trial does not establish an operational recovery-time objective.

Archive SHA-256:

```text
f1a2f2daac96e5361d6e8aeed9a00def217efad8ad3d6d7bb14e984ffade518b
```

All columns of all rows in both user tables matched their same-snapshot SHA-256
manifest. Schema definitions matched with ownership/ACL output excluded. The
clone had zero subscriptions, publications and slots. Locale and nonsuperuser
application identity matched the intended recovery configuration.

Both sequences restored with `last_value=1, is_called=false`, exactly matching
the live subscriber. The clone-only preparation set links to `10817, true` and
history to `1, true`. New REST/GraphQL links received IDs 10818 and 10819 and
immediately redirected with correct Location, 302 and no-store. The clone ended
with 10,819 links. Negative controls detected a changed destination and unsafe
identity allocation, and were undone on the clone. Duplicate-code rejection,
404 handling and readiness passed.

Post-cleanup inspection found both live databases still at **10,817 links**,
source links sequence `10817, true`, and HA links sequence `1, false`. HA history
also remained `1, false`. There were no abandoned idle-in-transaction client
sessions on either live database. The source logical slot and HA apply worker
were active, with no recorded synchronization/apply errors. No labelled recovery
containers or volumes remained.

Six health samples checked API liveness/readiness and the UI root, with no
failures; every recorded host-memory-pressure observation was normal (1).
These samples do not prove latency or continuous availability between samples.

## Preserved failed attempt

The initial 20:34:34–20:34:40 attempt successfully exported and applied the
archive, and matched schema. Fastify's clone connection then failed because
initdb's default host rules did not cover Docker's forwarded bridge address
`172.17.0.1`. The clone initializer now explicitly permits only database
`restore_test` and role `shortlink_lab` using SCRAM password authentication.
The published port remains loopback-only. Live pg_hba settings were not edited.

The first attempt remains failed, with its backup, error and cleanup record
retained. Its clone and volume were both removed. The corrected full run above
was a new export/restore, not a relabelled partial result.

## Evidence and remaining boundary

Private Git-ignored directories:

- `.kind/ha-backups/2026-11-15T18-34-34-514Z/`: failed attempt and cleanup.
- `.kind/ha-backups/2026-11-15T18-36-09-934Z/`: passing archive, manifest,
  schemas, TOC, source-health samples, clone log and result. The `harness/`
  directory contains exact qualified scripts and hashes;
  `post-cleanup-live-check.json` records independent final source/HA observations.

The archive and report are on the Mac with `0700` directory / `0600` file
permissions; clone credentials are not saved. This is a logical single-database
recovery qualification with explicit role and sequence preparation. CNPG
physical recovery, WAL/PITR, off-host backups, original ACL recovery, HA failover,
and application writer handoff are not qualified by this run.

Next: rehearse the writer handoff using disposable publisher/subscriber data,
including maintenance, fencing, a final replication barrier, sequence handling,
subscription shutdown, multi-replica pool switching and failure/abort behavior.
The failed load qualification also remains a gate before the real cutover.
