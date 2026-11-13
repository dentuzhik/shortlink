import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { readDatabaseUrl } from "./database.js";

const revision = process.env.APP_REVISION ?? "development";
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
});

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
