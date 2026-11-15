import Fastify from "fastify";
import { DatabasePools, type DatabaseTarget } from "./database-pools.js";
import { registerGraphQL } from "./graphql.js";
import { createLinkCreator } from "./link-creation.js";
import { registerLinkRoutes } from "./links.js";
import { registerMetrics } from "./metrics.js";
import { registerRedirectRoute } from "./redirect.js";
import { createRedirectCache } from "./redirect-cache.js";
import {
  type DatabaseName,
  type MaintenanceConfig,
  RuntimeMaintenance,
} from "./runtime-maintenance.js";

export function buildApp(
  databaseUrl: string,
  {
    poolMax = 5,
    reportPoolWait = false,
    redisUrl = "",
    reportCacheHit = false,
    redirectMaxWaiters = 128,
    redirectCheckoutTimeoutMs = 50,
    revision = "development",
    maintenance = new RuntimeMaintenance(true),
    databaseTargets = {} as Partial<Record<DatabaseName, DatabaseTarget>>,
  } = {},
) {
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const databases = new DatabasePools(databaseUrl, maintenance, {
    poolMax,
    maxWaiters: redirectMaxWaiters,
    checkoutTimeoutMs: redirectCheckoutTimeoutMs,
    targets: databaseTargets,
    onPoolError: () => app.log.warn("Postgres pool error"),
    observeCheckout: (observation) => {
      metrics.observeRedirectCheckout(observation);
      if (
        observation.outcome === "queue_full" ||
        observation.outcome === "timeout"
      ) {
        app.log.warn(
          {
            ...observation,
            checkoutTimeoutMs: redirectCheckoutTimeoutMs,
            maxWaiters: redirectMaxWaiters,
            eventLoopDelayMaxMsSinceScrape: metrics.eventLoopDelayMaxMs(),
          },
          "Redirect database checkout rejected",
        );
      }
    },
  });
  const metrics = registerMetrics(app, () => databases.poolState(), revision);
  const metricsServer = metrics.server;
  app.decorate("metricsServer", metricsServer);
  app.decorate("applyRuntimeConfig", (config: MaintenanceConfig) =>
    databases.configure(config),
  );
  metricsServer.get("/internal/maintenance", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const control = maintenance.status();
    const database = databases.status();
    return {
      ...control,
      database,
      configurationApplied:
        control.configurationCurrent &&
        database.appliedRevision === control.observedRevision &&
        database.error === null &&
        (!control.prepareDatabase ||
          control.prepareDatabase === control.activeDatabase ||
          (database.preparedDatabase === control.prepareDatabase &&
            database.candidateReady)),
    };
  });
  const linkStore = databases.store;
  const cache = redisUrl
    ? createRedirectCache(
        redisUrl,
        linkStore.findTargetUrl,
        app.log,
        metrics.observeRedisRead,
        () => databases.cacheGeneration(),
      )
    : undefined;

  app.addHook("onClose", async () => {
    await metricsServer.close();
    cache?.close();
    await databases.close();
  });

  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  app.get("/readyz", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!maintenance.configurationInitialized) {
      return reply.code(503).send({ status: "not ready" });
    }
    try {
      await databases.probe();
      return { status: "ready" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      request.log.warn({ reason }, "Postgres readiness check failed");
      return reply.code(503).send({ status: "not ready" });
    }
  });

  registerLinkRoutes(app, linkStore, undefined, maintenance);
  registerGraphQL(app, createLinkCreator(linkStore, undefined, maintenance));
  const findTargetUrl = cache?.findTargetUrl ?? linkStore.findTargetUrl;
  registerRedirectRoute(app, findTargetUrl, reportPoolWait, reportCacheHit);

  return app;
}
