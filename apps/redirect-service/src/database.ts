import { type ConnectionOptions, checkServerIdentity } from "node:tls";
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

export function createDatabasePool(
  connectionString: string,
  max: number,
  ssl?: ConnectionOptions,
  keepWarm = false,
): Pool {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error("DB_POOL_MAX must be a positive integer");
  }

  if (
    ssl &&
    [...new URL(connectionString).searchParams.keys()].some((key) =>
      key.startsWith("ssl"),
    )
  ) {
    throw new Error(
      "TLS parameters must be provided in one database configuration",
    );
  }
  const hostname = new URL(connectionString).hostname;
  const expectedHostname =
    ssl?.servername ??
    (hostname.startsWith("[") ? hostname.slice(1, -1) : hostname);
  return new Pool({
    connectionString,
    max,
    min: keepWarm ? 1 : 0,
    ...(ssl
      ? {
          ssl: {
            ...ssl,
            rejectUnauthorized: true,
            // pg sets SNI from its connection host. Verify our explicit expected name too.
            checkServerIdentity: (_hostname, certificate) =>
              checkServerIdentity(expectedHostname, certificate) ??
              ssl.checkServerIdentity?.(expectedHostname, certificate),
          },
        }
      : {}),
    // Bound the wait for a connection and a query result separately.
    connectionTimeoutMillis: 500,
    query_timeout: 500,
    application_name: "redirect-service",
  });
}
