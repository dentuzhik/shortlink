import { randomBytes } from "node:crypto";
import type { createLinkStore } from "@url-shortener/db/links";
import type { FastifyInstance } from "fastify";

const maxCodeAttempts = 3;

const createLinkBodySchema = {
  type: "object",
  required: ["targetUrl"],
  additionalProperties: false,
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: 2048 },
  },
} as const;

function parseTargetUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;

  const url = URL.parse(value);
  if (!url || url.username || url.password) return null;

  return url.href;
}

function generateLinkCode(): string {
  // Six random bytes encode to eight URL-safe characters.
  return randomBytes(6).toString("base64url");
}

export function registerLinkRoutes(
  app: FastifyInstance,
  store: ReturnType<typeof createLinkStore>,
  generateCode = generateLinkCode,
) {
  app.post<{ Body: { targetUrl: string } }>(
    "/links",
    { schema: { body: createLinkBodySchema } },
    async (request, reply) => {
      const value = request.body?.targetUrl;
      const targetUrl =
        typeof value === "string" ? parseTargetUrl(value) : null;
      if (!targetUrl) {
        return reply.code(400).send({
          error:
            "targetUrl must be an absolute HTTP or HTTPS URL without credentials",
        });
      }

      try {
        for (let attempt = 0; attempt < maxCodeAttempts; attempt++) {
          const link = await store.insert(generateCode(), targetUrl);
          if (link) {
            return reply.code(201).send({
              ...link,
              createdAt: link.createdAt.toISOString(),
            });
          }
        }
      } catch (error) {
        request.log.error(
          { errorType: error instanceof Error ? error.name : "unknown" },
          "Link insert failed",
        );
        return reply.code(500).send({ error: "Could not create link" });
      }

      request.log.warn("Link code attempts exhausted");
      return reply
        .code(503)
        .send({ error: "Could not allocate a short code; try again" });
    },
  );
}
