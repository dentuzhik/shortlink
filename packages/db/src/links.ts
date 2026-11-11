import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { links } from "./schema.js";

async function selectTargetUrl(db: NodePgDatabase, code: string) {
  const [link] = await db
    .select({ targetUrl: links.targetUrl })
    .from(links)
    .where(eq(links.code, code));

  return link?.targetUrl;
}

export function createLinkStore(
  pool: Pool,
  checkoutRedirect = () => pool.connect(),
) {
  const db = drizzle({ client: pool });

  return {
    async insert(code: string, targetUrl: string) {
      // Only a conflict on code skips the insert. Other database errors surface.
      const [link] = await db
        .insert(links)
        .values({ code, targetUrl })
        .onConflictDoNothing({ target: links.code })
        .returning({
          code: links.code,
          targetUrl: links.targetUrl,
          createdAt: links.createdAt,
        });

      return link;
    },

    async findTargetUrl(
      code: string,
      onDatabaseTiming?: (checkoutMs: number, lookupMs: number) => void,
    ) {
      const startedAt = onDatabaseTiming ? performance.now() : 0;
      const client = await checkoutRedirect();
      const waitMs = onDatabaseTiming ? performance.now() - startedAt : 0;
      let discardClient = false;
      const onClientError = () => {
        discardClient = true;
      };
      // The pool's idle error listener is detached while we own the client.
      client.on("error", onClientError);
      try {
        const lookupDb = drizzle({ client });
        const lookupStartedAt = onDatabaseTiming ? performance.now() : 0;
        const targetUrl = await selectTargetUrl(lookupDb, code);
        onDatabaseTiming?.(waitMs, performance.now() - lookupStartedAt);
        return targetUrl;
      } catch (error) {
        discardClient = true;
        throw error;
      } finally {
        client.off("error", onClientError);
        // Match pool.query's behavior of discarding a client after a query error.
        client.release(discardClient);
      }
    },
  };
}
