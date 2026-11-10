import type { FastifyInstance } from "fastify";

export function registerRedirectRoute(
  app: FastifyInstance,
  findTargetUrl: (
    code: string,
    onDatabaseTiming?: (checkoutMs: number, lookupMs: number) => void,
  ) => Promise<string | undefined>,
  reportPoolWait = false,
) {
  app.get<{ Params: { code: string } }>("/:code", async (request, reply) => {
    // A cached 404 could also hide a link that is created later.
    reply.header("Cache-Control", "no-store");

    try {
      const { code } = request.params;
      const targetUrl = reportPoolWait
        ? await findTargetUrl(code, (checkoutMs, lookupMs) => {
            reply.header(
              "Server-Timing",
              `db_pool;dur=${checkoutMs.toFixed(3)}, db_lookup;dur=${lookupMs.toFixed(3)}`,
            );
          })
        : await findTargetUrl(code);
      if (targetUrl === undefined) {
        return reply.code(404).send({ error: "Link not found" });
      }

      return reply.redirect(targetUrl, 302);
    } catch (error) {
      request.log.error(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Link lookup failed",
      );
      return reply.code(500).send({ error: "Could not look up link" });
    }
  });
}
