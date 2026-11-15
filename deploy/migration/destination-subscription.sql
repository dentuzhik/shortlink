-- STAGED ONLY: restore schema first, freeze DDL, and verify the live reverse path.
-- source_conninfo must reference persistent TLS trust and password files available
-- on every destination instance. Never pass a password in CLI arguments.
-- No application writes to the subscriber's published tables during replication.
CREATE SUBSCRIPTION shortlink_migration_sub
  CONNECTION :'source_conninfo'
  PUBLICATION shortlink_migration
  WITH (
    slot_name = 'shortlink_migration_sub',
    copy_data = true,
    binary = false,
    synchronous_commit = on
  );
