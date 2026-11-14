# Backup and restore rehearsal: November 14, 2026

[Procedure](../database-recovery.md) · [Migration plan](../ha-migration.md)

**Result: passed twice.** The existing database was exported onto the Mac,
restored into an isolated Postgres container, verified, and the clone removed.
The source remained on its original cluster and data volume. No VM resize or
migration was performed, so the maintenance interruption remains unused.

## Environment

- Source: `kind-shortlink`, namespace `shortlink`, Postgres 18.6.
- Application source revision: `1ccab3e`; the rehearsal script is a new reviewable
  change on top of that checkpoint, not part of a published image.
- Colima: the existing ARM64 4-CPU / 4-GiB profile.
- Restore: one CPU, 512 MiB, fresh volume and database, loopback-only random port.
- Source image manifest used for the clone:
  `docker.io/library/postgres@sha256:a8a18afebc8b2b529112c931f193151b712e566b7a49563dc0f328d51f652087`.
- No load was injected. Application checks used Fastify injection against the
  clone; they did not involve the live UI or write to the source.

## Recorded runs

| Measurement                                   | First passing run | Repeat after cleanup ownership checks |
| :-------------------------------------------- | ----------------: | ------------------------------------: |
| Start, UTC                                    |          15:00:05 |                              15:02:31 |
| Full script duration, excluding package build |            4.64 s |                                4.55 s |
| Compressed custom archive                     |     158,312 bytes |                         158,312 bytes |
| Dump command, including transfer to Mac       |             88 ms |                                 91 ms |
| Restore command into running clone            |             69 ms |                                 62 ms |
| Links restored                                |             7,764 |                                 7,764 |
| Migration-history rows restored               |                 1 |                                     1 |
| Sampled source HTTP checks / failures         |            15 / 0 |                                15 / 0 |
| Temporary container and volume removed        |               Yes |                                   Yes |

The source schema and all columns of all rows in both tables matched their
same-snapshot verification manifest. The identity sequence's last value was
7,764, with next allocation 7,765, greater than the restored maximum ID.

Both runs passed existing-link redirects, REST and GraphQL creation plus
immediate redirects, advancing identities, duplicate-code rejection, missing-code
behavior and readiness. Negative controls detected altered data and an unsafe
identity sequence; both changes were undone on the clone before application
checks. Exactly two new links were written to each clone.

After the first passing run, a source-only query confirmed 7,764 links, maximum
ID 7,764, no rehearsal target URLs, and no idle-in-transaction sessions. All nine
source Deployments retained their desired available replicas; source memory
pressure was zero in the immediate snapshot. These checks do not establish
availability between samples or a performance result under concurrent load.

Local evidence, ignored by Git:

```text
.kind/backups/2026-11-14T15-00-05-398Z/
.kind/backups/2026-11-14T15-02-31-164Z/
```

The repeat archive's SHA-256 is:

```text
9eafadb8e6d0752eb4a466ed3bb93f878ee57a6b5977c6be7af12caa5225a0f9
```

The two backups have different archive hashes because archive metadata is not a
canonical representation of table contents. Their table-content hashes match.
The saved archive and manifest are private local data, not committed artifacts.

Two earlier development preflights failed before a source snapshot or backup:
one attempted to pull a runtime image ID as a registry manifest; the other used
a health probe whose overridden Host header was discarded. Both were corrected.
The failing preflights and their diagnostics remain in the local backups folder;
they are not failed source-service or restore trials.

## Interpretation and next checkpoint

This demonstrates recovery of the application's database contents, schema and
identity behavior through a portable single-database dump. Ownership/ACLs,
cluster roles/settings, continuous WAL recovery, off-host backup and HA failover
are outside this test. The source and clone still share a VM and physical Mac,
although the backup is retained on the host outside the VM's data disk.

Next, choose the database operator/failover manager, then use disposable data to
validate the dedicated database profile, storage, replication and failover. Keep
all source restart requirements in the single planned maintenance window; do not
turn a successful logical restore into an assumption that replication cutover
or automatic failover is already safe.
