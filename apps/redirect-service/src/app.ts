import { createLinkStore } from "@url-shortener/db/links";
import Fastify from "fastify";
import { createDatabasePool } from "./database.js";
import { registerLinkRoutes } from "./links.js";

export function buildApp(databaseUrl: string) {
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const pool = createDatabasePool(databaseUrl);

  pool.on("error", (error) => {
    // Pool errors can include the database client. Log only the message.
    app.log.warn({ reason: error.message }, "Idle Postgres connection failed");
  });

  app.addHook("onClose", async () => {
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

  registerLinkRoutes(app, createLinkStore(pool));

  return app;
}
