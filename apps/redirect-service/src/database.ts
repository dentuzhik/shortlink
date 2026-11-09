import { Pool } from "pg";

export function readDatabaseUrl(value: string | undefined): string {
  const url = value ? URL.parse(value) : null;

  if (
    !url?.hostname ||
    url.pathname.length <= 1 ||
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
  ) {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL URL with a host and database name",
    );
  }

  return url.href;
}

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    // Bound the wait for a connection and a query result separately.
    connectionTimeoutMillis: 500,
    query_timeout: 500,
    application_name: "redirect-service",
  });
}
