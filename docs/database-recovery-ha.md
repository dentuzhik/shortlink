# HA database backup and restore qualification

[Recovery overview](database-recovery.md) · [Migration plan](ha-migration.md) ·
[Measured results](experiments/ha-backup-restore.md)

**Status: passed November 15, 2026.** The real HA `shortener` database was exported
to the Mac and restored into a disposable container using the same PostgreSQL
image. The restored data and application behavior passed verification. Fastify
continues serving from source, with its HA candidate prepared but inactive.

## Run

```sh
pnpm test:db-restore:ha
```

This builds the database package and Fastify, then runs the existing
[restore harness](../scripts/rehearse-db-restore.mjs) with `--ha`. Plain
`pnpm test:db-restore` retains the original source-database exercise. Unsupported
arguments fail; neither mode takes a restore destination from `DATABASE_URL`.

The HA mode explicitly reads `.kind/db-cluster/kubeconfig`, context
`kind-shortlink-db`, namespace `database-lab`, and CNPG cluster `shortlink-lab`.
It exports database `shortener` from the current primary over Kubernetes exec.
The original `shortlink_lab` probe database is outside this backup. All live
HA export connections set `default_transaction_read_only=on`.

The clone runs in Docker context `colima`, with a fresh labelled volume, a one-CPU
and 512-MiB limit, and a random port published only on Mac loopback. It uses the
exact deployed digest of the reviewed PostgreSQL 18.7 system-trixie image.
The [clone initializer](../scripts/restore-ha-clone.sh) creates its own data
directory and password-authentication rule. No live database authentication
configuration or Kubernetes Deployment is patched.

## What is qualified

1. Require normal host memory pressure, three healthy HA instances, and both
   Fastify replicas acknowledging source active, creations accepted and HA
   prepared. Record deployment/control hashes, pod identities and live sequence
   values. Resolve/cache the clone image before opening a snapshot.
2. Export a `REPEATABLE READ READ ONLY` snapshot. Discover user tables and hash
   every complete row, then export schema and a custom-format archive using that
   same snapshot. This permits normal application writes and replication to
   continue while comparisons describe one consistent HA snapshot. Keep DDL
   frozen during the exercise.
3. Explicitly exclude subscriptions and publications with `--no-subscriptions`
   and `--no-publications`. Store the archive and same-snapshot manifest privately
   on the Mac, record archive SHA-256 and release the snapshot before restoring.
4. Initialize a fresh clone with matching UTF8/libc/en_US.utf8 locale. Recreate
   nonsuperuser `shortlink_lab` using a new random password and create
   `restore_test` owned by it. Roles/passwords are provisioned separately because
   the single-database archive does not contain cluster-wide roles.
5. Inspect the archive table of contents for replication objects. Restore with
   `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges
   --role=shortlink_lab`. The role assignment makes restored objects belong to
   the intended application owner without copying live credentials or ACLs.
6. Compare schema and every user-table row against the export manifest, verify
   locale and nonsuperuser identity, and confirm the clone has no subscriptions,
   publications or replication slots. The clone must not restart the migration
   stream against source.
7. Check both restored identity sequences, apply any required correction **only
   to the clone**, then test Fastify using that clone and Redis disabled.
   Existing redirects, REST/GraphQL creation and immediate redirects, identity
   allocation, code uniqueness, missing-code behavior and readiness must pass.
   Negative controls prove changed rows and unsafe sequence states are detected.
8. Confirm source selection/control, both running Fastify pod identities, source
   Postgres/CNPG configuration and live HA sequence values remain unchanged.
   Verify the logical stream is still active. Remove only the run-labelled clone
   and volume, retaining the backup and report.

## Subscriber sequence handling

Logical replication copied row IDs into HA without advancing its generators.
A backup taken now accurately preserves that state: the links and migration
history sequences both have `last_value=1, is_called=false`. Restoring the dump
alone does not make that subscriber state safe for application writes.

The rehearsal first verifies the raw restored values, then derives safe next
allocations from the restored table maxima. At the measured snapshot, the links
sequence was advanced to `10817, true`, and the history sequence to `1, true`.
The two new clone links received IDs 10818 and 10819. These changes never target
the live subscriber. A sequence already safely ahead is retained; BigInt
arithmetic avoids rounding large IDs.

This clone-only step qualifies part of the future recovery/handoff procedure.
The live destination sequences must still be corrected after source fencing and
final catch-up during the actual cutover.

## Evidence, scope and limits

Private artifacts are under `.kind/ha-backups/<UTC timestamp>/`: archive,
same-snapshot content manifest, source/restored schema, archive TOC, health
observations, timings and cleanup results. Directories are `0700` and files
`0600`; `.kind/` is Git-ignored. Passwords are not saved in the reports. The
backup remains on the Mac after the clone and its volume are removed.

This qualifies a manual, portable logical restore of one HA database with
explicit role/sequence preparation. It does not reconstruct the CNPG control
plane, three-instance topology, original ACLs, Secrets, certificates, other
databases or cluster settings. Continuous WAL archiving, point-in-time recovery,
automatic backup scheduling/retention and off-host storage remain outside this
increment. The Mac and its disk are still shared failure boundaries.

The health samples are sparse availability observations, not a latency SLO.
No k6 load is injected here, and the earlier failed rollout load trial remains
failed. Real writer handoff and its performance qualification remain separate
checkpoints.

Upstream details: [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
and [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).
