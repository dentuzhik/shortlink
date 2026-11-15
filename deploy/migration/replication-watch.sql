BEGIN READ ONLY;
SET LOCAL statement_timeout='3s';
WITH s AS (
  SELECT slot_name, active, wal_status, invalidation_reason, inactive_since,
    pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::bigint AS retained_bytes,
    pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn)::bigint AS unconfirmed_bytes
  FROM pg_replication_slots WHERE slot_name='shortlink_migration_sub'
), health AS (
  SELECT NOT (:'slot_required')::boolean OR EXISTS (
    SELECT 1 FROM s WHERE invalidation_reason IS NULL AND wal_status <> 'lost'
      AND retained_bytes < 100663296
      AND (active OR inactive_since > clock_timestamp()-interval '2 minutes')
  ) AS ok
)
SELECT json_build_object('time',clock_timestamp(),'slotRequired',(:'slot_required')::boolean,
  'slots',(SELECT coalesce(json_agg(s),'[]'::json) FROM s),
  'warning',(SELECT coalesce(bool_or(retained_bytes >= 67108864 OR NOT active),false) FROM s),
  'healthy',(SELECT ok FROM health)) AS state, (SELECT ok FROM health) AS ok
\gset
\echo :state
COMMIT;
\if :ok
\else
SELECT 1 / 0 AS replication_health_failed;
\endif
