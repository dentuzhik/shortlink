# Logical replication preparation: November 14, 2026

[Approach and procedure](../database-replication.md) · [Migration plan](../ha-migration.md)

**Result:** a read-only live inventory and three disposable cross-VM logical
replication rehearsals passed. The live database remains unchanged; no source
restart, real-data replication or application cutover occurred.

The connectivity increment was committed as `7be38b3` before this work. Preparation
and rehearsal files form a new reviewable increment on that checkpoint.

## Live inventory

- Source: Postgres 18.6, `shortener`, 7,764 existing links; `wal_level=replica`,
  TLS off, ten available replication slots and ten WAL senders. No publications,
  slots or subscriptions existed before or after the rehearsal.
- Published-table candidate list: `public.links` and
  `drizzle.__drizzle_migrations`, both with primary keys/default replica identity.
- Two sequences require explicit handling: `public.links_id_seq` and
  `drizzle.__drizzle_migrations_id_seq`.
- Only default `plpgsql`; no user functions/triggers, large objects, RLS or
  non-table application relations were found.
- Destination: Postgres 18.7, three CloudNativePG instances, four logical workers,
  ten origins and 32 total workers. Existing physical standby replication stays
  separate from the fixture logical stream.
- Kubernetes accepted the source settings patch in a server-side dry run. It
  was not applied. TLS, reverse connectivity, credentials and retention capacity
  are still prerequisites for live streaming.

Evidence: `.kind/db-cluster/replication-preparation/2026-11-14T18-51-04-927Z/`.

## Disposable rehearsal results

Publisher: pinned Postgres 18.6 in Docker context `colima`, private application-VM
port 25432, its own volume and fixtures, logical WAL and verified TLS.
Subscriber: a temporary database on `shortlink-lab-1` in the dedicated VM, using
Postgres 18.7 and synchronous commit with one required standby.

Three complete runs passed:

- `.kind/db-cluster/replication-rehearsals/2026-11-14T18-44-45-762Z/`.
- `.kind/db-cluster/replication-rehearsals/2026-11-14T18-46-49-272Z/`.
- `.kind/db-cluster/replication-rehearsals/2026-11-14T18-51-05-596Z/`.

All three runs verified initial copy, committed changes, rollback exclusion, a paused
subscriber missing a later fixture write, retained WAL, re-enabled catch-up and
complete-row hashes for both tables. Table synchronization states reached `r`.
The publisher observed an active logical replication connection with TLS.
The final run executes the actual staged publisher arguments and publication/
subscription SQL, substituting fixture identifiers and the temporary connection.
It does not maintain a separate copy of those SQL definitions in the test.

The sequence demonstration was concrete: after copy/catch-up, destination
`links_id_seq` and migration-history sequence still had `last_value=1` and
`is_called=false`, while copied maximum IDs were 1003 and 2001. After stopping
replication and correcting both sequences, new destination IDs were 1004 and
2002. This proves the sequence issue and fixture correction, not safe live
writer cutover.

All fixture databases, subscription metadata, Docker containers/volumes and
temporary certificate/password/key files were cleaned up. Live Fastify and
Postgres Deployment specification hashes stayed unchanged; sampled source API
readiness and UI responses were `200`. The maintenance allowance remains unused.
A subsequent `db:lab:check` at 18:52:28 UTC also passed replication, TLS and
resource gates, with normal host pressure and about 56% available guest memory.
Postflight inspection found zero fixture databases/subscriptions, Docker
containers/volumes or private fixture files; the source still had 7,764 links,
`wal_level=replica`, TLS off and zero slots/publications.

The initial attempt at `2026-11-14T18-43-53-034Z` failed before replication
started: the destination Pod's `/tmp` was read-only. Cleanup passed. Temporary
files were moved to `/controller/run`; the original failed result was preserved.

## Limits

Fixture rows only, small dataset, no sustained traffic, no live publisher TLS
endpoint and no subscriber failover were tested. The test publisher's finite
128 MB slot-retention setting was exercised operationally but its exhaustion
behavior and suitability for the real workload were not qualified. Before/after
HTTP samples do not establish the redirect latency budget.

The next increment should complete and rehearse the source maintenance bundle,
including the private reverse endpoint, TLS/HBA/credentials, retention policy
and consolidated restart/VM-sizing requirements. Real-data initial copy follows
source preparation; the original database remains the only application writer.
