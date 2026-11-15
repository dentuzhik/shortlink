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
ALTER ROLE shortener NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REASSIGN OWNED BY shortener TO fixture_admin;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,drizzle FROM shortener,PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public,drizzle FROM shortener,PUBLIC;
REVOKE CREATE ON SCHEMA public,drizzle FROM shortener,PUBLIC;
GRANT USAGE ON SCHEMA public,drizzle TO shortener;
GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO shortener;
-- This last administrator transaction is itself part of the publication.
INSERT INTO public.handoff_barrier(token) VALUES('@RUN_ID@');
SELECT pg_current_wal_insert_lsn()::text;
COMMIT;
