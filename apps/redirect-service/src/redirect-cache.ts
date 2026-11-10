import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type { RedirectLookup } from "./redirect.js";

const ttlSeconds = 60;

export function createRedirectCache(
  redisUrl: string,
  findInPostgres: RedirectLookup,
  log: FastifyBaseLogger,
) {
  const redis = new Redis(redisUrl, {
    commandTimeout: 25,
    socketTimeout: 1000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  const pendingFills = new Map<string, Promise<string | undefined>>();

  redis.on("error", (error) => {
    log.warn({ errorType: error.name }, "Redis connection error");
  });

  const findTargetUrl: RedirectLookup = async (
    code,
    onDatabaseTiming,
    onCacheSource,
  ) => {
    const key = `shortlink:redirect:${code}`;
    let cachedUrl: string | null;

    try {
      cachedUrl = await redis.get(key);
    } catch (error) {
      log.debug(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Redis redirect lookup failed",
      );
      return findInPostgres(code, onDatabaseTiming);
    }

    if (cachedUrl !== null) {
      onCacheSource?.("HIT");
      return cachedUrl;
    }

    const existingFill = pendingFills.get(code);
    if (existingFill) {
      const targetUrl = await existingFill;
      if (targetUrl !== undefined) {
        onCacheSource?.("COALESCED");
      }
      return targetUrl;
    }

    // Keep sharing the lookup while Redis is still being filled.
    const fill = (async () => {
      const targetUrl = await findInPostgres(code, onDatabaseTiming);
      if (targetUrl !== undefined) {
        try {
          await redis.set(key, targetUrl, "EX", ttlSeconds);
        } catch (error) {
          log.debug(
            { errorType: error instanceof Error ? error.name : "unknown" },
            "Redis redirect cache fill failed",
          );
        }
      }
      return targetUrl;
    })();
    pendingFills.set(code, fill);

    try {
      return await fill;
    } finally {
      pendingFills.delete(code);
    }
  };

  return { findTargetUrl, close: () => redis.disconnect() };
}
