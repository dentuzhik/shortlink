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

export function createLinkStore(pool: Pool) {
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
      onPoolWait?: (milliseconds: number) => void,
    ) {
      if (!onPoolWait) {
        return selectTargetUrl(db, code);
      }

      const startedAt = performance.now();
      const client = await pool.connect();
      const waitMs = performance.now() - startedAt;
      let discardClient = false;
      const onClientError = () => {
        discardClient = true;
      };
      // The pool's idle error listener is detached while we own the client.
      client.on("error", onClientError);
      try {
        onPoolWait(waitMs);
        return await selectTargetUrl(drizzle({ client }), code);
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
