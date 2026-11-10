import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { Client } from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import type { buildApp as buildProductionApp } from "../../src/app.js";

const run = promisify(execFile);
// Use Node's module loader so GraphQL Yoga and the app share one GraphQL runtime.
const { buildApp } = createRequire(import.meta.url)("../../dist/app.js") as {
  buildApp: typeof buildProductionApp;
};

describe("links with Postgres", () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:18.6")
      .withDatabase("shortener_test")
      .start();
    databaseUrl = postgres.getConnectionUri();

    // Run the same migration command as local development, on the test DB.
    await run("pnpm", ["--workspace-root", "run", "db:migrate"], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 30_000,
    });

    app = buildApp(databaseUrl);
    app.log.level = "silent";
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await postgres?.stop();
    }
  }, 30_000);

  test("creates a link and redirects from its stored code", async () => {
    const targetUrl = "https://example.com/guide";
    const created = await app.inject({
      method: "POST",
      url: "/links",
      payload: { targetUrl },
    });

    expect(created.statusCode).toBe(201);
    const { code } = created.json<{ code: string }>();
    expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);

    const redirect = await app.inject({ method: "GET", url: `/${code}` });

    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(targetUrl);
    expect(redirect.headers["cache-control"]).toBe("no-store");
  });

  test("returns 404 when Postgres has no matching code", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/not-created",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Link not found" });
  });

  test("creates a redirectable link through the GraphQL mutation", async () => {
    const targetUrl = "https://example.com/graphql";
    const created = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `mutation CreateLink($input: CreateLinkInput!) {
          createLink(input: $input) { code }
        }`,
        variables: { input: { targetUrl } },
      },
    });

    expect(created.statusCode).toBe(200);
    const result = created.json<{ data: { createLink: { code: string } } }>();
    expect(result).toEqual({
      data: {
        createLink: { code: expect.stringMatching(/^[A-Za-z0-9_-]{8}$/) },
      },
    });

    const redirect = await app.inject({
      method: "GET",
      url: `/${result.data.createLink.code}`,
    });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(targetUrl);
  });

  test("returns a GraphQL input error for a non-HTTP destination", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query: `mutation { createLink(input: { targetUrl: "ftp://example.com" }) { code } }`,
      },
    });

    expect(response.json()).toMatchObject({
      data: null,
      errors: [{ extensions: { code: "BAD_USER_INPUT" } }],
    });
  });

  describe("redirect cache with Redis", () => {
    const targetUrl = "https://example.com/cached";
    const poolMax = 5;
    let container: StartedTestContainer | undefined;
    let redis: Redis;
    let redisUrl: string;
    let cachedApp: ReturnType<typeof buildApp>;

    beforeAll(async () => {
      container = await new GenericContainer("redis:8.10.3-alpine")
        .withExposedPorts(6379)
        .start();
      redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
      redis = new Redis(redisUrl, { lazyConnect: true, commandTimeout: 3000 });
      await redis.connect();
      cachedApp = buildApp(databaseUrl, {
        poolMax,
        redisUrl,
        reportCacheHit: true,
        reportPoolWait: true,
      });
      cachedApp.log.level = "silent";

      // The app can serve from Postgres while its Redis connection opens.
      await redis.set("shortlink:redirect:cache-ready", targetUrl, "EX", 60);
      await vi.waitFor(async () => {
        const response = await cachedApp.inject("/cache-ready");
        expect(response.headers["x-cache"]).toBe("HIT");
      });
      await redis.del("shortlink:redirect:cache-ready");
    }, 120_000);

    afterAll(async () => {
      try {
        await cachedApp?.close();
      } finally {
        redis?.disconnect();
        await container?.stop();
      }
    }, 30_000);

    async function createLink() {
      const response = await cachedApp.inject({
        method: "POST",
        url: "/links",
        payload: { targetUrl },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ code: string }>().code;
    }

    test("fills Redis on a miss and returns a hit on the next visit", async () => {
      const code = await createLink();
      const key = `shortlink:redirect:${code}`;
      expect(await redis.get(key)).toBeNull();

      const miss = await cachedApp.inject(`/${code}`);
      expect(miss.statusCode).toBe(302);
      expect(miss.headers.location).toBe(targetUrl);
      expect(miss.headers["x-cache"]).toBeUndefined();
      expect(miss.headers["server-timing"]).toContain("db_lookup");
      expect(await redis.get(key)).toBe(targetUrl);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      const hit = await cachedApp.inject(`/${code}`);
      expect(hit.statusCode).toBe(302);
      expect(hit.headers.location).toBe(targetUrl);
      expect(hit.headers["x-cache"]).toBe("HIT");
      expect(hit.headers["cache-control"]).toBe("no-store");
      expect(hit.headers["server-timing"]).toBeUndefined();
    });

    test("shares one Postgres lookup across concurrent misses for the same code", async () => {
      const code = await createLink();
      const readRedisMisses = async () =>
        Number(
          /^keyspace_misses:(\d+)\r?$/m.exec(await redis.info("stats"))?.[1],
        );
      const requestCount = 6;
      const locker = new Client({ connectionString: databaseUrl });
      await locker.connect();

      try {
        // Hold up the first lookup until every request has missed Redis.
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
        const missesBefore = await readRedisMisses();
        const redirects = Promise.all(
          Array.from({ length: requestCount }, () =>
            cachedApp.inject(`/${code}`),
          ),
        );
        try {
          await expect.poll(readRedisMisses).toBe(missesBefore + requestCount);
        } finally {
          await locker.query("ROLLBACK");
        }

        const responses = await redirects;
        for (const response of responses) {
          expect(response.statusCode).toBe(302);
          expect(response.headers.location).toBe(targetUrl);
          expect(response.headers["cache-control"]).toBe("no-store");
        }
        const leaders = responses.filter((r) => r.headers["server-timing"]);
        expect(leaders).toHaveLength(1);
        expect(leaders[0]?.headers["server-timing"]).toContain("db_lookup");
        expect(leaders[0]?.headers["x-cache"]).toBeUndefined();
        const followers = responses.filter((r) => !r.headers["server-timing"]);
        expect(followers).toHaveLength(requestCount - 1);
        for (const follower of followers) {
          expect(follower.headers["x-cache"]).toBe("COALESCED");
        }
        expect((await cachedApp.inject(`/${code}`)).headers["x-cache"]).toBe(
          "HIT",
        );
      } finally {
        await locker.end();
      }
    });

    test("returns 404 without caching a missing code", async () => {
      const code = "redis-missing";
      const response = await cachedApp.inject(`/${code}`);

      expect(response.statusCode).toBe(404);
      expect(response.headers["x-cache"]).toBeUndefined();
      expect(await redis.get(`shortlink:redirect:${code}`)).toBeNull();
    });

    test("shares one Postgres lookup across concurrent Redis read timeouts", async () => {
      const code = await createLink();
      const cachedUrl = "https://example.com/previous-destination";
      await redis.set(`shortlink:redirect:${code}`, cachedUrl, "EX", 60);
      expect((await cachedApp.inject(`/${code}`)).headers["x-cache"]).toBe(
        "HIT",
      );

      const locker = new Client({ connectionString: databaseUrl });
      await locker.connect();
      const debug = vi.spyOn(cachedApp.log, "debug");
      const requestCount = 6;
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
        await redis.call("CLIENT", "PAUSE", "500", "ALL");
        try {
          const redirects = Promise.all(
            Array.from({ length: requestCount }, () =>
              cachedApp.inject(`/${code}`),
            ),
          );
          const releaseLookup = (async () => {
            try {
              // Keep the lookup open until all six Redis reads have timed out.
              await expect
                .poll(
                  () =>
                    debug.mock.calls.filter(
                      ([, message]) =>
                        message === "Redis redirect lookup failed",
                    ).length,
                  { interval: 10, timeout: 300 },
                )
                .toBe(requestCount);
            } finally {
              await locker.query("ROLLBACK");
            }
          })();
          const [responses] = await Promise.all([redirects, releaseLookup]);

          const leaders = responses.filter((r) => r.headers["server-timing"]);
          expect(leaders).toHaveLength(1);
          expect(leaders[0]?.headers["server-timing"]).toContain("db_lookup");
          for (const response of responses) {
            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe(targetUrl);
            expect(response.headers["x-cache"]).toBe(
              response === leaders[0] ? undefined : "COALESCED",
            );
          }
        } finally {
          await redis.call("CLIENT", "UNPAUSE");
        }

        await vi.waitFor(async () => {
          const hit = await cachedApp.inject(`/${code}`);
          expect(hit.headers["x-cache"]).toBe("HIT");
          expect(hit.headers.location).toBe(cachedUrl);
        });
      } finally {
        debug.mockRestore();
        await locker.end();
      }
    });

    test("queues distinct codes behind the Postgres pool during Redis read timeouts", async () => {
      const requestCount = 20;
      const codes = await Promise.all(
        Array.from({ length: requestCount }, createLink),
      );
      expect(new Set(codes).size).toBe(requestCount);

      const locker = new Client({ connectionString: databaseUrl });
      await locker.connect();
      const debug = vi.spyOn(cachedApp.log, "debug");
      try {
        // Hold checked-out connections long enough to observe the pool filling.
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
        await redis.call("CLIENT", "PAUSE", "500", "ALL");
        try {
          const redirects = Promise.all(
            codes.map((code) => cachedApp.inject(`/${code}`)),
          );
          const observation = vi
            .waitFor(
              async () => {
                const { rows } = await locker.query<{ blocked: number }>(`
                  SELECT count(*)::int AS blocked
                  FROM pg_locks
                  WHERE relation = 'links'::regclass
                    AND mode = 'AccessShareLock'
                    AND NOT granted
                `);
                const readFailures = debug.mock.calls.filter(
                  ([, message]) => message === "Redis redirect lookup failed",
                ).length;
                expect(readFailures).toBe(requestCount);
                expect(rows[0]?.blocked).toBe(poolMax);
              },
              { interval: 10, timeout: 300 },
            )
            .finally(() => locker.query("ROLLBACK"));
          const [responses] = await Promise.all([redirects, observation]);
          const checkoutTimes = responses.map((response) => {
            expect(response.statusCode).toBe(302);
            expect(response.headers.location).toBe(targetUrl);
            expect(response.headers["x-cache"]).toBeUndefined();
            const timing =
              /^db_pool;dur=(\d+\.\d+), db_lookup;dur=\d+\.\d+$/.exec(
                String(response.headers["server-timing"]),
              );
            expect(timing).not.toBeNull();
            return Number(timing?.[1]);
          });

          if (process.env.REPORT_OUTAGE_POOL_TIMING === "1") {
            console.info(
              `Redis outage burst: ${poolMax} queries reached Postgres, ${requestCount - poolMax} waited for a connection. Pool checkout ranged from ${Math.min(...checkoutTimes)} to ${Math.max(...checkoutTimes)} ms.`,
            );
          }
        } finally {
          await redis.call("CLIENT", "UNPAUSE");
        }
      } finally {
        debug.mockRestore();
        await locker.end();
      }
    });

    test("returns the redirect when a Redis cache fill times out", async () => {
      const code = await createLink();
      const key = `shortlink:redirect:${code}`;

      await redis.call("CLIENT", "PAUSE", "1000", "WRITE");
      try {
        const response = await cachedApp.inject(`/${code}`);

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(targetUrl);
        expect(response.headers["x-cache"]).toBeUndefined();
        expect(response.headers["server-timing"]).toContain("db_lookup");
        expect(await redis.get(key)).toBeNull();
      } finally {
        await redis.call("CLIENT", "UNPAUSE");
      }
    });

    test("keeps the cache hit header disabled by default", async () => {
      const appWithoutHeader = buildApp(databaseUrl, {
        redisUrl,
        reportPoolWait: true,
      });
      appWithoutHeader.log.level = "silent";
      onTestFinished(() => appWithoutHeader.close());
      const code = await createLink();
      await redis.set(`shortlink:redirect:${code}`, targetUrl, "EX", 60);

      await expect
        .poll(async () => {
          const response = await appWithoutHeader.inject(`/${code}`);
          expect(response.statusCode).toBe(302);
          expect(response.headers.location).toBe(targetUrl);
          expect(response.headers["x-cache"]).toBeUndefined();
          return response.headers["server-timing"];
        })
        .toBeUndefined();
    });
  });
});
