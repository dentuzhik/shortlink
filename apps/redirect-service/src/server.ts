import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { readDatabaseUrl, readDatabaseUser } from "./database.js";
import type { DatabaseTarget } from "./database-pools.js";
import {
  kubernetesMaintenanceSource,
  startMaintenanceWatch,
} from "./maintenance-watch.js";
import {
  type MaintenanceConfig,
  RuntimeMaintenance,
} from "./runtime-maintenance.js";

const revision = process.env.APP_REVISION ?? "development";
const configMap = process.env.MAINTENANCE_CONFIGMAP;
const maintenance = new RuntimeMaintenance(!configMap);
let ha: DatabaseTarget | undefined;
if (process.env.HA_DATABASE_URL) {
  if (!process.env.HA_DATABASE_CA_FILE || !process.env.HA_DATABASE_SERVERNAME) {
    throw new Error("HA database requires a CA file and TLS server name");
  }
  const connectionString = readDatabaseUrl(process.env.HA_DATABASE_URL);
  ha = {
    connectionString,
    expectedDatabase: "shortener",
    expectedRole: readDatabaseUser(connectionString),
    ssl: {
      ca: readFileSync(process.env.HA_DATABASE_CA_FILE, "utf8"),
      servername: process.env.HA_DATABASE_SERVERNAME,
    },
    requireTLS: true,
    requireNonSuperuser: true,
  };
}
const app = buildApp(readDatabaseUrl(process.env.DATABASE_URL), {
  poolMax: Number(process.env.DB_POOL_MAX ?? 5),
  reportPoolWait: process.env.DB_POOL_TIMING === "1",
  redisUrl: process.env.REDIS_URL ?? "",
  reportCacheHit: process.env.REDIS_CACHE_HEADER === "1",
  redirectMaxWaiters: Number(process.env.REDIRECT_DB_MAX_WAITERS ?? 128),
  redirectCheckoutTimeoutMs: Number(
    process.env.REDIRECT_DB_CHECKOUT_TIMEOUT_MS ?? 50,
  ),
  revision,
  maintenance,
  databaseTargets: ha ? { ha } : {},
});
if (configMap) {
  const namespace = process.env.POD_NAMESPACE;
  if (!namespace)
    throw new Error(
      "POD_NAMESPACE is required for runtime maintenance control",
    );
  const watcher = startMaintenanceWatch(
    maintenance,
    kubernetesMaintenanceSource(namespace, configMap),
    () =>
      app.log.warn(
        "Runtime maintenance configuration unavailable; rejecting creations",
      ),
    1000,
    app.getDecorator<(config: MaintenanceConfig) => Promise<void>>(
      "applyRuntimeConfig",
    ),
  );
  app.addHook("onClose", watcher.stop);
}

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down");

  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.getDecorator<FastifyInstance>("metricsServer").listen({
    host: process.env.LISTEN_HOST ?? "127.0.0.1",
    port: Number(process.env.METRICS_PORT ?? 9090),
  });
  await app.listen({
    host: process.env.LISTEN_HOST ?? "127.0.0.1",
    port: 3000,
  });
  app.log.info({ revision }, "Application started");
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
