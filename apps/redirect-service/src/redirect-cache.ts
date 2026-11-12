import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";
import type { RedirectLookup } from "./redirect.js";
import { createRedisReadBreaker } from "./redis-read-breaker.js";

const ttlSeconds = 60;

export function createRedirectCache(
  redisUrl: string,
  findInPostgres: RedirectLookup,
  log: FastifyBaseLogger,
  observeRead?: (outcome: "hit" | "miss" | "unavailable") => void,
) {
  const redis = new Redis(redisUrl, {
    commandTimeout: 25,
    socketTimeout: 1000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  const pendingLookups = new Map<string, Promise<string | undefined>>();
  const readRedis = createRedisReadBreaker((key) => redis.get(key), log);

  redis.on("error", (error) => {
    log.warn({ errorType: error.name }, "Redis connection error");
  });

  const findTargetUrl: RedirectLookup = async (
    code,
    onDatabaseTiming,
    onCacheSource,
  ) => {
    const key = `shortlink:redirect:${code}`;
    const cachedUrl = await readRedis(key);
    observeRead?.(
      typeof cachedUrl === "string"
        ? "hit"
        : cachedUrl === null
          ? "miss"
          : "unavailable",
    );

    if (typeof cachedUrl === "string") {
      onCacheSource?.("HIT");
      return cachedUrl;
    }

    const existingLookup = pendingLookups.get(code);
    if (existingLookup) {
      const targetUrl = await existingLookup;
      if (targetUrl !== undefined) {
        onCacheSource?.("COALESCED");
      }
      return targetUrl;
    }

    const lookup = (async () => {
      const targetUrl = await findInPostgres(code, onDatabaseTiming);
      // Only a confirmed miss permits a cache fill.
      if (cachedUrl === null && targetUrl !== undefined) {
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
    pendingLookups.set(code, lookup);

    try {
      return await lookup;
    } finally {
      pendingLookups.delete(code);
    }
  };

  return { findTargetUrl, close: () => redis.disconnect() };
}
