# Database backup and restore rehearsal

[Project overview](../README.md) · [Migration exercise](ha-migration.md)

This is a recoverability checkpoint before resizing or migrating infrastructure.
Export the existing application database to the Mac, restore into a disposable
Postgres instance, and verify both its contents and application behavior. The
[November 14 results](experiments/backup-restore.md) record two successful runs.

## Run the rehearsal

With the existing Colima profile and local Kubernetes application healthy:

```sh
pnpm test:db-restore
```

The command builds the database package and Fastify locally, then runs
[`scripts/rehearse-db-restore.mjs`](../scripts/rehearse-db-restore.mjs). It explicitly
targets Docker context `colima` and Kubernetes context `kind-shortlink`, using
`.kind/kubeconfig` and namespace `shortlink`. It does not use an ambient
`DATABASE_URL` as the restore destination or switch the default contexts.

This command is an operator exercise, not an ordinary unit test or a CI job.
It expects the existing nonempty links database, official Postgres image, kind
containerd metadata, and source Gateway on loopback port 8080. Adapting it to
another profile, operator or hardware is a later reviewed increment.

## What the command does

1. Locate the single ready source Postgres pod. Resolve its actual OCI manifest
   from the kind node, and use that digest for the clone. A Kubernetes runtime
   image ID is not necessarily a pullable registry reference.
2. Check the source API and UI, then sample `/healthz`, `/readyz` and the UI root
   throughout the exercise. These sparse HTTP checks do not prove a latency SLO.
3. Open a short `REPEATABLE READ READ ONLY` transaction and call
   `pg_export_snapshot()`. Collect table content hashes and a schema export
   using that snapshot, and pass it to `pg_dump --snapshot` as well.
4. Stream a custom-format archive directly from the pod to a private directory
   on the Mac. Keep partial output under a `.partial` filename; rename only on
   successful completion. Record archive size and SHA-256, then release the
   source snapshot. Its idle timeout also bounds an abandoned transaction.
5. Create a fresh labeled container and volume on the current Colima runtime,
   with a one-CPU limit, 512 MiB memory limit, an ephemeral loopback-only database
   port, and a generated password. Restore the archive in one transaction with
   `pg_restore --exit-on-error --single-transaction`.
6. Compare the restored schema and every user-table row, then run application
   checks against the clone. No migrations or test writes run against the source.
7. Close clients, release the snapshot and remove the rehearsal's container and
   volume. Cleanup verifies run-specific labels before removal. Keep the backup
   and evidence on the Mac; return a nonzero exit status if verification, source
   health observations or cleanup fail.

A regular `pg_dump` already makes a consistent database export. The explicitly
shared snapshot is needed here so the independently computed verification
manifest describes the same data, even if the application creates links during
export. Comparing the backup with a later live row count would not establish that.
Normal reads and writes can continue. Dumping takes shared relation locks, so do
not combine this first rehearsal with schema-changing migrations. The command
sets a five-second dump lock-wait limit and short source verification timeouts.

## Verification details

The current database has two user tables: `public.links` and
`drizzle.__drizzle_migrations`. Discover them through the catalog rather than
assuming that a backup contains only links.

For each table, serialize every row as JSONB, order the rows using the `C`
collation, and hash the resulting stream with SHA-256. Include all columns, so
IDs, destinations, timestamps and migration-history values participate. Set the
session timezone to UTC on both sides. This implementation aggregates each small
table in memory; a large database would need a streaming or partitioned approach.

Compare schema-only dumps made with quoted identifiers and ownership/ACL output
excluded. Ignore only the random `\restrict` and `\unrestrict` tokens emitted by
Postgres 18; retain the schema definitions themselves. This checks restored table
structure, defaults, constraints, indexes and sequence definitions.

Verify that the restored `links.id` sequence will allocate a value greater than
the maximum restored ID. Sequences are not MVCC snapshot data; concurrent writes
can make the dump's sequence value advance beyond snapshot rows. Gaps are valid.
The requirement is safe future allocation, not equality to a later source value.

The clone then proves:

- Ten existing links produce the stored destination, `302` and `no-store`.
- REST and GraphQL each create a new redirectable link.
- New IDs advance beyond the restored maximum and exactly two rows are added.
- A duplicate code fails with `links_code_unique`; a missing code returns `404`.
- Database-backed application readiness returns `200`.

Two negative controls run on the clone: change one destination and verify that
content comparison detects it, then roll the transaction back; reset the
identity sequence and verify that the safety check rejects it, then explicitly
restore the sequence state. A sequence change is not undone by transaction
rollback, which is why its restoration is explicit.

## Backup and evidence files

Each run writes a new directory:

```text
.kind/backups/<UTC timestamp>/
  shortener.dump
  source-manifest.json
  source-schema.sql
  restored-schema.sql
  source-health.json
  restore-container.log
  result.json
```

The backup directory has mode `0700`, files `0600`, and `.kind/` is ignored by Git.
The dump contains real application data. Only redacted summaries belong in docs;
do not upload the dump as a public CI artifact. `result.json` contains timings,
content hashes, image identity, checks and cleanup results, not the generated
restore password.

The archive and verification manifest live outside the Colima VM. Removing the
temporary clone does not delete them. This protects this backup from loss of the
VM's own data disk, but it is still on the same physical Mac. No off-host backup
or automatic retention policy is established by this exercise.

## Scope and limits

This portable database restore deliberately uses a fresh bootstrap role and
omits source ownership and ACLs. It does not recreate cluster-wide roles,
passwords, tablespaces, Postgres settings, TLS material or external services.
A single-database dump is not a complete server recovery plan.

It also does not provide continuous WAL backups, point-in-time recovery,
replication, failover or writes made after the snapshot. Add those capabilities
with the selected HA operator and rehearse them separately. A four-second local
rehearsal on a small database does not establish a production recovery-time goal
or demonstrate recovery on a clean machine without cached images.

## References

- [Postgres pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).
- [Postgres pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html).
- [Snapshot synchronization](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION).
