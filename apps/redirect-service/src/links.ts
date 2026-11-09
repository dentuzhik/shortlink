import type { FastifyInstance } from "fastify";
import { createLinkCreator, maxTargetUrlLength } from "./link-creation.js";

const createLinkBodySchema = {
  type: "object",
  required: ["targetUrl"],
  additionalProperties: false,
  properties: {
    targetUrl: { type: "string", minLength: 1, maxLength: maxTargetUrlLength },
  },
} as const;

export function registerLinkRoutes(
  app: FastifyInstance,
  ...dependencies: Parameters<typeof createLinkCreator>
) {
  const createLink = createLinkCreator(...dependencies);

  app.post<{ Body: { targetUrl: string } }>(
    "/links",
    { schema: { body: createLinkBodySchema } },
    async (request, reply) => {
      try {
        const result = await createLink(request.body?.targetUrl);
        switch (result.status) {
          case "created":
            return reply.code(201).send(result.link);
          case "invalid-url":
            return reply.code(400).send({ error: result.message });
          case "codes-exhausted":
            request.log.warn("Link code attempts exhausted");
            return reply.code(503).send({ error: result.message });
        }
      } catch (error) {
        request.log.error(
          { errorType: error instanceof Error ? error.name : "unknown" },
          "Link insert failed",
        );
        return reply.code(500).send({ error: "Could not create link" });
      }
    },
  );
}
