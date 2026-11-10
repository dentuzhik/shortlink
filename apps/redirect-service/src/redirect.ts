import type { FastifyInstance } from "fastify";

export type RedirectLookup = (
  code: string,
  onDatabaseTiming?: (checkoutMs: number, lookupMs: number) => void,
  onCacheHit?: () => void,
) => Promise<string | undefined>;

export function registerRedirectRoute(
  app: FastifyInstance,
  findTargetUrl: RedirectLookup,
  reportPoolWait = false,
  reportCacheHit = false,
) {
  app.get<{ Params: { code: string } }>("/:code", async (request, reply) => {
    // A cached 404 could also hide a link that is created later.
    reply.header("Cache-Control", "no-store");

    try {
      const { code } = request.params;
      const onDatabaseTiming = reportPoolWait
        ? (checkoutMs: number, lookupMs: number) => {
            reply.header(
              "Server-Timing",
              `db_pool;dur=${checkoutMs.toFixed(3)}, db_lookup;dur=${lookupMs.toFixed(3)}`,
            );
          }
        : undefined;
      const onCacheHit = reportCacheHit
        ? () => {
            reply.header("X-Cache", "HIT");
          }
        : undefined;
      const targetUrl =
        onDatabaseTiming || onCacheHit
          ? await findTargetUrl(code, onDatabaseTiming, onCacheHit)
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
