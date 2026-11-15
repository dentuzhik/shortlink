-- Create only after source maintenance and reverse-path verification pass.
-- The dedicated role is provisioned independently by source-role.sql.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE PUBLICATION shortlink_migration
  FOR TABLE public.links, drizzle.__drizzle_migrations
  WITH (publish = 'insert, update, delete, truncate');
COMMIT;
