import { createLinkStore } from "@url-shortener/db/links";
import Fastify from "fastify";
import { createDatabasePool } from "./database.js";
import { registerGraphQL } from "./graphql.js";
import { createLinkCreator } from "./link-creation.js";
import { registerLinkRoutes } from "./links.js";
import { registerRedirectRoute } from "./redirect.js";
import { createRedirectCache } from "./redirect-cache.js";

export function buildApp(
  databaseUrl: string,
  {
    poolMax = 5,
    reportPoolWait = false,
    redisUrl = "",
    reportCacheHit = false,
  } = {},
) {
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const pool = createDatabasePool(databaseUrl, poolMax);
  const linkStore = createLinkStore(pool);
  const cache = redisUrl
    ? createRedirectCache(redisUrl, linkStore.findTargetUrl, app.log)
    : undefined;

  pool.on("error", (error) => {
    // Pool errors can include the database client. Log only the message.
    app.log.warn({ reason: error.message }, "Idle Postgres connection failed");
  });

  app.addHook("onClose", async () => {
    cache?.close();
    await pool.end();
  });

  app.get("/healthz", async () => {
    return { status: "ok" };
  });

  app.get("/readyz", async (request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      request.log.warn({ reason }, "Postgres readiness check failed");
      return reply.code(503).send({ status: "not ready" });
    }
  });

  registerLinkRoutes(app, linkStore);
  registerGraphQL(app, createLinkCreator(linkStore));
  const findTargetUrl = cache?.findTargetUrl ?? linkStore.findTargetUrl;
  registerRedirectRoute(app, findTargetUrl, reportPoolWait, reportCacheHit);

  return app;
}
