import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GraphQLError } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import type { CreateLink } from "./link-creation.js";

export function registerGraphQL(app: FastifyInstance, createLink: CreateLink) {
  const yoga = createYoga<{ req: FastifyRequest; reply: FastifyReply }>({
    cors: false,
    graphiql: false,
    landingPage: false,
    logging: false,
    maskedErrors: { isDev: false },
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          status: String!
        }

        type Link {
          code: String!
          targetUrl: String!
          createdAt: String!
        }

        input CreateLinkInput {
          targetUrl: String!
        }

        type Mutation {
          createLink(input: CreateLinkInput!): Link!
        }
      `,
      resolvers: {
        Query: { status: () => "ok" },
        Mutation: {
          async createLink(
            _parent: unknown,
            { input }: { input: { targetUrl: string } },
          ) {
            const result = await createLink(input.targetUrl).catch(
              (error: unknown) => {
                app.log.error(
                  {
                    errorType: error instanceof Error ? error.name : "unknown",
                  },
                  "GraphQL link insert failed",
                );
                throw new GraphQLError("Could not create link", {
                  extensions: { code: "INTERNAL_SERVER_ERROR" },
                });
              },
            );

            if (result.status === "created") return result.link;
            throw new GraphQLError(result.message, {
              extensions: {
                code:
                  result.status === "invalid-url"
                    ? "BAD_USER_INPUT"
                    : "CODES_EXHAUSTED",
              },
            });
          },
        },
      },
    }),
  });

  app.route({
    url: yoga.graphqlEndpoint,
    method: ["GET", "POST"],
    handler: (req, reply) =>
      yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
  });
}
