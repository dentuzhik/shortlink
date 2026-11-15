-- FIXTURE ONLY. The source server must carry this run's startup marker.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5s';
DO $$ BEGIN
  IF current_setting('shortlink.handoff_fixture',true) IS DISTINCT FROM '@RUN_ID@' THEN
    RAISE EXCEPTION 'Refusing to fence a database outside this disposable fixture';
  END IF;
END $$;
-- Allow SELECT, but serialize with any previously admitted source DML.
LOCK TABLE public.links,drizzle.__drizzle_migrations,public.handoff_barrier IN SHARE MODE;
-- The runtime role never owned the tables and cannot restore its own grants.
REVOKE INSERT ON TABLE public.links FROM shortlink_app;
REVOKE USAGE ON SEQUENCE public.links_id_seq FROM shortlink_app;
GRANT SELECT ON TABLE public.links TO shortlink_app;
-- This last administrator transaction is itself part of the publication.
INSERT INTO public.handoff_barrier(token) VALUES('@RUN_ID@');
SELECT pg_current_wal_insert_lsn()::text;
COMMIT;
