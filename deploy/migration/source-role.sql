-- Password is provisioned separately through private stdin; never put it in Git.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE ROLE shortlink_migrator LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE shortener TO shortlink_migrator;
GRANT USAGE ON SCHEMA public, drizzle TO shortlink_migrator;
GRANT SELECT ON TABLE public.links, drizzle.__drizzle_migrations TO shortlink_migrator;
COMMIT;
