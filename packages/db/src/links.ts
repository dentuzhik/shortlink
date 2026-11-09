import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { links } from "./schema.js";

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

    async findTargetUrl(code: string) {
      const [link] = await db
        .select({ targetUrl: links.targetUrl })
        .from(links)
        .where(eq(links.code, code));

      return link?.targetUrl;
    },
  };
}
