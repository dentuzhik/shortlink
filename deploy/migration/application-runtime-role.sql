-- Apply as the selected database administrator after verifying the selected server/database.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
  IF current_database() <> 'shortener' THEN
    RAISE EXCEPTION 'Application role preparation requires the shortener database';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shortlink_app') THEN
    CREATE ROLE shortlink_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE shortlink_app IS 'shortlink:runtime-application:v1';
  ELSIF shobj_description((SELECT oid FROM pg_roles WHERE rolname='shortlink_app'),'pg_authid')
      IS DISTINCT FROM 'shortlink:runtime-application:v1' THEN
    RAISE EXCEPTION 'Refusing to change an unmanaged application role';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shortlink_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app')) THEN
    RAISE EXCEPTION 'Application role has unexpected privileges or ownership';
  END IF;
END $$;
GRANT CONNECT ON DATABASE shortener TO shortlink_app;
GRANT USAGE ON SCHEMA public,drizzle TO shortlink_app;
GRANT SELECT,INSERT ON TABLE public.links TO shortlink_app;
GRANT USAGE ON SEQUENCE public.links_id_seq TO shortlink_app;
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO shortlink_app;
COMMIT;
