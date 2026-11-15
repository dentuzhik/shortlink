-- STAGED ONLY. Configure TLS/HBA and provision a password separately first.
-- REPLICATION is a powerful cluster attribute, not a publication-scoped grant.
-- Deliberately fail if these names already exist; do not silently reuse a role.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE ROLE shortlink_migrator LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE shortener TO shortlink_migrator;
GRANT USAGE ON SCHEMA public, drizzle TO shortlink_migrator;
GRANT SELECT ON TABLE public.links, drizzle.__drizzle_migrations TO shortlink_migrator;
CREATE PUBLICATION shortlink_migration
  FOR TABLE public.links, drizzle.__drizzle_migrations
  WITH (publish = 'insert, update, delete, truncate');
COMMIT;
