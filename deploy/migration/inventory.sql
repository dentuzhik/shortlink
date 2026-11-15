BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT json_build_object(
  'database', current_database(),
  'serverVersion', current_setting('server_version'),
  'settings', (SELECT json_agg(x ORDER BY name) FROM (
    SELECT name, setting, unit, context, pending_restart FROM pg_settings
    WHERE name IN ('wal_level','ssl','max_replication_slots','max_wal_senders',
      'max_slot_wal_keep_size','max_active_replication_origins',
      'max_worker_processes','max_logical_replication_workers',
      'max_sync_workers_per_subscription','max_parallel_apply_workers_per_subscription')
  ) x),
  'relations', (SELECT json_agg(x ORDER BY schema, name) FROM (
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
      c.relpersistence AS persistence, c.relreplident AS replica_identity,
      c.relrowsecurity AS row_security, pg_get_userbyid(c.relowner) AS owner,
      (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname)
         FROM pg_constraint WHERE conrelid=c.oid) AS constraints
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','S','v','m','f')
  ) x),
  'sequences', (SELECT json_agg(x ORDER BY schemaname, sequencename) FROM (
    SELECT schemaname, sequencename, start_value::text, increment_by::text,
      max_value::text, last_value::text FROM pg_sequences
    WHERE schemaname IN ('public','drizzle')
  ) x),
  'extensions', (SELECT json_agg(extname ORDER BY extname) FROM pg_extension),
  'userFunctions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'),
  'roles', (SELECT json_agg(x) FROM (SELECT rolname,rolsuper,rolreplication,rolcanlogin,rolbypassrls
    FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname) x),
  'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata),
  'eventTriggers', (SELECT count(*) FROM pg_event_trigger),
  'userTriggers', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
  'slots', (SELECT coalesce(json_agg(x), '[]'::json) FROM (
    SELECT slot_name, slot_type, plugin, active, wal_status,
      pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::text AS retained_bytes
    FROM pg_replication_slots
  ) x),
  'publications', (SELECT coalesce(json_agg(pubname), '[]'::json) FROM pg_publication),
  'subscriptions', (SELECT coalesce(json_agg(subname), '[]'::json) FROM pg_subscription
    WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database()))
);
COMMIT;
