import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import type { buildApp as buildProductionApp } from "../../src/app.js";
import type * as WatchTypes from "../../src/maintenance-watch.js";
import type * as MaintenanceTypes from "../../src/runtime-maintenance.js";
import { maintenanceApi } from "../helpers/maintenance-api.js";

const run = promisify(execFile);
// Use Node's module loader so GraphQL Yoga and the app share one GraphQL runtime.
const { buildApp } = createRequire(import.meta.url)("../../dist/app.js") as {
  buildApp: typeof buildProductionApp;
};

const { RuntimeMaintenance } = createRequire(import.meta.url)(
  "../../dist/runtime-maintenance.js",
) as typeof MaintenanceTypes;
const { kubernetesMaintenanceSource, startMaintenanceWatch } = createRequire(
  import.meta.url,
)("../../dist/maintenance-watch.js") as typeof WatchTypes;

describe("links with Postgres", () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;
  let targetDatabaseUrl: string;
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

    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query("CREATE DATABASE shortener_pool_target");
    } finally {
      await admin.end();
    }
    const targetUrl = new URL(databaseUrl);
    targetUrl.pathname = "/shortener_pool_target";
    targetDatabaseUrl = targetUrl.href;
    await run("pnpm", ["--workspace-root", "run", "db:migrate"], {
      env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
      timeout: 30000,
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

  test("serves metrics separately, observes a real pool queue, and closes both listeners", async () => {
    const monitored = buildApp(databaseUrl, { poolMax: 1 });
    monitored.log.level = "silent";
    onTestFinished(() => monitored.close());
    const applicationUrl = await monitored.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const metrics = monitored.getDecorator<FastifyInstance>("metricsServer");
    const metricsUrl = await metrics.listen({ host: "127.0.0.1", port: 0 });
    const scrape = async () => {
      const response = await fetch(`${metricsUrl}/metrics`);
      expect(response.status).toBe(200);
      return response.text();
    };
    const targetUrl = "https://example.com/metrics";
    const created = await monitored.inject({
      method: "POST",
      url: "/links",
      payload: { targetUrl },
    });
    const code = created.json<{ code: string }>().code;
    expect(created.statusCode).toBe(201);

    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
      const redirect = monitored
        .inject(`/${code}`)
        .then((response) => response);
      pending.push(redirect);
      await vi.waitFor(
        async () => {
          expect(await scrape()).toContain(
            'shortlink_db_pool_connections{state="in_use"} 1',
          );
        },
        { interval: 5, timeout: 250 },
      );
      const write = monitored
        .inject({ method: "POST", url: "/links", payload: { targetUrl } })
        .then((response) => response);
      pending.push(write);
      await vi.waitFor(
        async () => {
          const body = await scrape();
          expect(body).toContain(
            'shortlink_db_pool_connections{state="idle"} 0',
          );
          expect(body).toContain("shortlink_db_pool_waiting_requests 1");
        },
        { interval: 5, timeout: 250 },
      );
      await locker.query("ROLLBACK");
      expect((await redirect).statusCode).toBe(302);
      expect((await write).statusCode).toBe(201);
    } finally {
      await locker.query("ROLLBACK");
      await Promise.allSettled(pending);
      await locker.end();
    }
    const invalidGraphql = await monitored.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query:
          'mutation { createLink(input: { targetUrl: "ftp://example.com" }) { code } }',
      },
    });
    expect(invalidGraphql.statusCode).toBe(200);
    expect(invalidGraphql.json()).toHaveProperty("errors");
    const body = await scrape();
    expect(body).toContain('shortlink_db_pool_connections{state="idle"} 1');
    expect(body).toContain("shortlink_db_pool_waiting_requests 0");
    expect(body).toContain(
      'shortlink_http_requests_total{method="POST",route="/graphql",status_code="200"} 1',
    );
    const publicMetrics = await monitored.inject("/metrics");
    expect(publicMetrics.statusCode).toBe(404);
    expect(publicMetrics.body).not.toContain("shortlink_db_pool_connections");
    await monitored.close();
    expect(monitored.server.listening).toBe(false);
    expect(metrics.server.listening).toBe(false);
    await expect(fetch(`${applicationUrl}/healthz`)).rejects.toThrow();
    await expect(fetch(`${metricsUrl}/metrics`)).rejects.toThrow();
  });

  test("coordinates maintenance across two instances without restarting them or blocking redirects", async () => {
    const api = await maintenanceApi();
    const instances: ReturnType<typeof buildApp>[] = [];
    const start = () => {
      const control = new RuntimeMaintenance();
      const instance = buildApp(databaseUrl, { maintenance: control });
      instance.log.level = "silent";
      const watcher = startMaintenanceWatch(
        control,
        kubernetesMaintenanceSource("shortlink", "shortlink-runtime", api),
        () => {},
        10,
        instance.getDecorator("applyRuntimeConfig"),
      );
      instance.addHook("onClose", watcher.stop);
      instances.push(instance);
      return instance;
    };
    const status = async (instance: ReturnType<typeof buildApp>) =>
      (
        await instance
          .getDecorator<FastifyInstance>("metricsServer")
          .inject("/internal/maintenance")
      ).json();
    const targetUrl = "https://example.test/runtime-maintenance";
    const rest = (instance: ReturnType<typeof buildApp>) =>
      instance
        .inject({ method: "POST", url: "/links", payload: { targetUrl } })
        .then((response) => response);
    const graphql = (instance: ReturnType<typeof buildApp>) =>
      instance
        .inject({
          method: "POST",
          url: "/graphql",
          payload: {
            query:
              "mutation($input:CreateLinkInput!){createLink(input:$input){code}}",
            variables: { input: { targetUrl } },
          },
        })
        .then((response) => response);
    let first = start();
    const second = start();
    const both = async (expected: Record<string, unknown>) => {
      await vi.waitFor(
        async () => {
          for (const instance of [first, second])
            expect(await status(instance)).toMatchObject(expected);
        },
        { interval: 5, timeout: 2000 },
      );
    };
    const locker = new Client({ connectionString: databaseUrl });
    const pending: Promise<unknown>[] = [];
    try {
      await locker.connect();
      expect((await first.inject("/readyz")).statusCode).toBe(503);
      expect((await rest(first)).statusCode).toBe(503);
      expect((await graphql(second)).statusCode).toBe(503);
      api.setWatchAvailable(false);
      api.setAvailable(true);
      await both({
        configurationLoaded: true,
        configurationInitialized: false,
      });
      expect((await first.inject("/readyz")).statusCode).toBe(503);
      expect((await rest(first)).statusCode).toBe(503);
      api.setWatchAvailable(true);
      await both({ observedRevision: 1, acceptingCreations: true });
      const created = await rest(first);
      expect(created.statusCode).toBe(201);
      const code = created.json<{ code: string }>().code;
      expect((await first.inject("/internal/maintenance")).statusCode).toBe(
        404,
      );

      await locker.query("BEGIN");
      // Blocks INSERT but allows redirect SELECTs and readiness probes.
      await locker.query("LOCK TABLE links IN SHARE MODE");
      const admittedRest = rest(first);
      const admittedGraphql = graphql(second);
      pending.push(admittedRest, admittedGraphql);
      await both({ inflightCreations: 1 });
      api.update({ revision: 2, creationMode: "reject" });
      await both({
        observedRevision: 2,
        acceptingCreations: false,
        drained: false,
      });
      for (const response of [await rest(first), await graphql(second)]) {
        expect(response.statusCode).toBe(503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["retry-after"]).toBe("1");
      }
      expect((await graphql(first)).json()).toMatchObject({
        errors: [{ extensions: { code: "MAINTENANCE" } }],
      });
      for (const instance of [first, second]) {
        expect((await instance.inject("/readyz")).statusCode).toBe(200);
        const redirect = await instance.inject(`/${code}`);
        expect(redirect.statusCode).toBe(302);
        expect(redirect.headers.location).toBe(targetUrl);
        const query = await instance.inject({
          method: "POST",
          url: "/graphql",
          payload: { query: "{status}" },
        });
        expect(query.json()).toEqual({ data: { status: "ok" } });
      }
      await locker.query("ROLLBACK");
      expect((await admittedRest).statusCode).toBe(201);
      expect((await admittedGraphql).json()).toHaveProperty(
        "data.createLink.code",
      );
      await both({ drained: true, inflightCreations: 0 });
      const count = await locker.query(
        "SELECT count(*)::int AS count FROM links WHERE target_url=$1",
        [targetUrl],
      );
      expect(count.rows[0].count).toBe(3);

      api.update({ revision: 3, creationMode: "typo" });
      await both({
        observedRevision: 2,
        configurationCurrent: false,
        acceptingCreations: false,
      });
      expect((await first.inject("/readyz")).statusCode).toBe(200);
      api.update({ revision: 4, creationMode: "reject" });
      await both({ observedRevision: 4, drained: true });
      await first.close();
      first = start(); // Fresh process state must load reject rather than default accept.
      expect((await rest(first)).statusCode).toBe(503);
      await both({ observedRevision: 4, drained: true });

      api.update({ revision: 5, creationMode: "accept" });
      await both({ observedRevision: 5, acceptingCreations: true });
      expect((await rest(first)).statusCode).toBe(201);
      expect((await graphql(second)).json()).toHaveProperty(
        "data.createLink.code",
      );
      await api.rotateToken();
      api.expireWatches(); // Normal watch rotation rereads projected token files.
      await both({ observedRevision: 5, acceptingCreations: true });
      api.setAvailable(false);
      await both({ configurationCurrent: false, acceptingCreations: false });
      expect((await rest(first)).statusCode).toBe(503);
      expect((await first.inject("/readyz")).statusCode).toBe(200);
      api.update({ revision: 6, creationMode: "reject" });
      api.setAvailable(true);
      await both({ observedRevision: 6, drained: true });
    } finally {
      await locker.query("ROLLBACK");
      await Promise.allSettled(pending);
      await locker.end();
      await Promise.all(instances.map((instance) => instance.close()));
      await api.close();
    }
  }, 20000);

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
        // These tests deliberately hold database locks while observing overlap.
        redirectCheckoutTimeoutMs: 400,
      });
      cachedApp.log.level = "silent";
    }, 120_000);

    beforeEach(() => waitForCache(cachedApp));

    test("switches both transports, readiness, metrics and cache misses while an old lookup drains", async () => {
      const api = await maintenanceApi();
      const instances: ReturnType<typeof buildApp>[] = [];
      const start = () => {
        const control = new RuntimeMaintenance();
        const instance = buildApp(databaseUrl, {
          maintenance: control,
          redisUrl,
          reportCacheHit: true,
          poolMax: 2,
          redirectCheckoutTimeoutMs: 400,
          databaseTargets: { ha: { connectionString: targetDatabaseUrl } },
        });
        instance.log.level = "silent";
        const watcher = startMaintenanceWatch(
          control,
          kubernetesMaintenanceSource("shortlink", "shortlink-runtime", api),
          () => {},
          10,
          instance.getDecorator("applyRuntimeConfig"),
        );
        instance.addHook("onClose", watcher.stop);
        instances.push(instance);
        return instance;
      };
      const status = async (instance: ReturnType<typeof buildApp>) =>
        (
          await instance
            .getDecorator<FastifyInstance>("metricsServer")
            .inject("/internal/maintenance")
        ).json();
      let instance = start();
      const apply = async (
        config: Record<string, unknown>,
        expected: Record<string, unknown>,
      ) => {
        api.update(config);
        await vi.waitFor(
          async () => expect(await status(instance)).toMatchObject(expected),
          { interval: 5, timeout: 2000 },
        );
      };
      const source = new Client({ connectionString: databaseUrl });
      const target = new Client({ connectionString: targetDatabaseUrl });
      let oldLookup: Promise<unknown> | undefined;
      try {
        await Promise.all([source.connect(), target.connect()]);
        api.setAvailable(true);
        await vi.waitFor(async () =>
          expect(await status(instance)).toMatchObject({
            configurationApplied: true,
            activeDatabase: "source",
          }),
        );
        const targetUrl = "https://example.test/pool-handoff";
        const baseline = await instance.inject({
          method: "POST",
          url: "/links",
          payload: { targetUrl },
        });
        expect(baseline.statusCode).toBe(201);
        const common = baseline.json<{ code: string; createdAt: string }>();
        await target.query(
          "INSERT INTO links(code,target_url,created_at) VALUES($1,$2,$3)",
          [common.code, targetUrl, common.createdAt],
        );
        const onlyTarget = "poolOnly";
        await redis.del(`shortlink:redirect:${onlyTarget}`);
        await target.query("INSERT INTO links(code,target_url) VALUES($1,$2)", [
          onlyTarget,
          targetUrl,
        ]);
        await apply(
          { revision: 2, creationMode: "accept", prepareDatabase: "ha" },
          {
            configurationApplied: true,
            activeDatabase: "source",
            acceptingCreations: true,
            database: {
              preparedDatabase: "ha",
              candidateReady: true,
              appliedRevision: 2,
            },
          },
        );
        expect((await instance.inject(`/${common.code}`)).statusCode).toBe(302);
        await apply(
          { revision: 3, creationMode: "reject", prepareDatabase: "ha" },
          { configurationApplied: true, drained: true },
        );
        await source.query("BEGIN");
        await source.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
        const read = instance
          .inject(`/${onlyTarget}`)
          .then((response) => response);
        oldLookup = read;
        await vi.waitFor(
          async () => {
            const result = await source.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE relation='links'::regclass AND mode='AccessShareLock' AND NOT granted",
            );
            expect(result.rows[0].count).toBe(1);
          },
          { interval: 5, timeout: 150 },
        );
        await apply(
          {
            revision: 4,
            creationMode: "reject",
            activeDatabase: "ha",
            prepareDatabase: null,
          },
          {
            configurationApplied: true,
            activeDatabase: "ha",
            drained: true,
            database: {
              appliedRevision: 4,
              retiringPools: [{ database: "source", inflightOperations: 1 }],
            },
          },
        );
        // A post-switch request must not coalesce onto the old source's missing-row lookup.
        const current = await instance.inject(`/${onlyTarget}`);
        expect(current.statusCode).toBe(302);
        expect(current.headers.location).toBe(targetUrl);
        expect(current.headers["x-cache"]).not.toBe("COALESCED");
        expect((await instance.inject("/readyz")).statusCode).toBe(200);
        const metrics = (
          await instance
            .getDecorator<FastifyInstance>("metricsServer")
            .inject("/metrics")
        ).body;
        expect(metrics).toContain(
          'shortlink_db_pool_connections{state="in_use"} 0',
        );
        expect(
          (
            await instance.inject({
              method: "POST",
              url: "/links",
              payload: { targetUrl },
            })
          ).statusCode,
        ).toBe(503);
        await source.query("ROLLBACK");
        expect((await read).statusCode).toBe(404);
        await vi.waitFor(async () =>
          expect((await status(instance)).database.retiringPools).toEqual([]),
        );
        await apply(
          { revision: 5, creationMode: "accept", activeDatabase: "ha" },
          { configurationApplied: true, acceptingCreations: true },
        );
        const rest = await instance.inject({
          method: "POST",
          url: "/links",
          payload: { targetUrl },
        });
        const graphql = await instance.inject({
          method: "POST",
          url: "/graphql",
          payload: {
            query:
              "mutation($input:CreateLinkInput!){createLink(input:$input){code}}",
            variables: { input: { targetUrl } },
          },
        });
        expect(rest.statusCode).toBe(201);
        expect(graphql.statusCode).toBe(200);
        const codes = [
          rest.json<{ code: string }>().code,
          graphql.json<{ data: { createLink: { code: string } } }>().data
            .createLink.code,
        ];
        expect(
          (
            await source.query(
              "SELECT count(*)::int AS count FROM links WHERE code=ANY($1::text[])",
              [codes],
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await target.query(
              "SELECT count(*)::int AS count FROM links WHERE code=ANY($1::text[])",
              [codes],
            )
          ).rows[0].count,
        ).toBe(2);
        for (const code of codes)
          expect((await instance.inject(`/${code}`)).headers.location).toBe(
            targetUrl,
          );
        await instance.close();
        instance = start();
        await vi.waitFor(async () =>
          expect(await status(instance)).toMatchObject({
            activeDatabase: "ha",
            configurationApplied: true,
            acceptingCreations: true,
          }),
        );
        expect((await instance.inject(`/${common.code}`)).statusCode).toBe(302);
        // Readiness must follow the HA pool, rather than the original source connection.
        const lockTarget = new Client({ connectionString: targetDatabaseUrl });
        await lockTarget.connect();
        try {
          await lockTarget.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='redirect-service'",
          );
          expect((await instance.inject("/readyz")).statusCode).toBe(200); // A replacement HA connection is usable.
        } finally {
          await lockTarget.end();
        }
      } finally {
        await source.query("ROLLBACK");
        if (oldLookup) await oldLookup;
        await Promise.all([source.end(), target.end()]);
        await Promise.all(instances.map((app) => app.close()));
        await api.close();
        await redis.del("shortlink:redirect:poolOnly");
      }
    }, 20000);

    test.each([
      { expectedDatabase: "wrong_database" },
      { expectedRole: "wrong_role" },
      { requireTLS: true },
      { requireNonSuperuser: true },
      { connectionString: "postgres://test:test@127.0.0.1:1/unreachable" },
    ])(
      "failed candidate validation leaves the source serving: %j",
      async (invalidTarget) => {
        const api = await maintenanceApi();
        const control = new RuntimeMaintenance();
        const instance = buildApp(databaseUrl, {
          maintenance: control,
          databaseTargets: {
            ha: { connectionString: targetDatabaseUrl, ...invalidTarget },
          },
        });
        instance.log.level = "silent";
        const watcher = startMaintenanceWatch(
          control,
          kubernetesMaintenanceSource("shortlink", "shortlink-runtime", api),
          () => {},
          10,
          instance.getDecorator("applyRuntimeConfig"),
        );
        instance.addHook("onClose", watcher.stop);
        const status = async () =>
          (
            await instance
              .getDecorator<FastifyInstance>("metricsServer")
              .inject("/internal/maintenance")
          ).json();
        try {
          api.setAvailable(true);
          await vi.waitFor(async () =>
            expect(await status()).toMatchObject({
              configurationApplied: true,
            }),
          );
          api.update({
            revision: 2,
            creationMode: "accept",
            prepareDatabase: "ha",
          });
          await vi.waitFor(
            async () =>
              expect(await status()).toMatchObject({
                observedRevision: 2,
                configurationApplied: false,
                activeDatabase: "source",
                acceptingCreations: true,
                database: {
                  preparedDatabase: null,
                  error: "database_configuration_failed",
                },
              }),
            { interval: 5, timeout: 2000 },
          );
          expect((await instance.inject("/readyz")).statusCode).toBe(200);
          expect(
            (
              await instance.inject({
                method: "POST",
                url: "/links",
                payload: {
                  targetUrl: "https://example.test/failed-pool-preparation",
                },
              })
            ).statusCode,
          ).toBe(201);
          api.update({
            revision: 3,
            creationMode: "accept",
            prepareDatabase: null,
          });
          await vi.waitFor(async () =>
            expect(await status()).toMatchObject({
              configurationApplied: true,
              database: { error: null },
            }),
          );
        } finally {
          await instance.close();
          await api.close();
        }
      },
    );

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

    async function readRedisMisses() {
      return Number(
        /^keyspace_misses:(\d+)\r?$/m.exec(await redis.info("stats"))?.[1],
      );
    }

    async function waitForCache(app: ReturnType<typeof buildApp>) {
      // Also wait for recovery after a preceding test has opened the circuit.
      await redis.set("shortlink:redirect:cache-ready", targetUrl, "EX", 60);
      await vi.waitFor(
        async () => {
          expect((await app.inject("/cache-ready")).headers["x-cache"]).toBe(
            "HIT",
          );
        },
        { timeout: 2500 },
      );
      await redis.del("shortlink:redirect:cache-ready");
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

    test("opens the Redis read circuit and recovers through a successful miss", async () => {
      const breakerApp = buildApp(databaseUrl, {
        redisUrl,
        reportCacheHit: true,
        reportPoolWait: true,
      });
      breakerApp.log.level = "silent";
      onTestFinished(() => breakerApp.close());
      await waitForCache(breakerApp);
      const code = await createLink();
      const key = `shortlink:redirect:${code}`;
      await redis.set(key, targetUrl, "EX", 60);
      const debug = vi.spyOn(breakerApp.log, "debug");
      onTestFinished(() => debug.mockRestore());
      const readFailures = () =>
        debug.mock.calls.filter(
          ([, message]) => message === "Redis redirect lookup failed",
        ).length;

      await redis.call("CLIENT", "PAUSE", "500", "ALL");
      try {
        for (let i = 0; i < 5; i++) {
          const response = await breakerApp.inject(`/${code}`);
          expect(response.statusCode).toBe(302);
          expect(response.headers.location).toBe(targetUrl);
          expect(response.headers["server-timing"]).toContain("db_lookup");
        }
        expect(readFailures()).toBe(5);

        const bypassed = await breakerApp.inject(`/${code}`);
        expect(bypassed.statusCode).toBe(302);
        expect(bypassed.headers["x-cache"]).toBeUndefined();
        expect(bypassed.headers["server-timing"]).toContain("db_lookup");
        expect(readFailures()).toBe(5);
      } finally {
        await redis.call("CLIENT", "UNPAUSE");
      }

      // Recovery must also work when the probe finds an expired cache entry.
      await redis.del(key);
      await vi.waitFor(
        async () => {
          const response = await breakerApp.inject(`/${code}`);
          expect(response.statusCode).toBe(302);
          expect(await redis.get(key)).toBe(targetUrl);
        },
        { timeout: 2500 },
      );
      const hit = await breakerApp.inject(`/${code}`);
      expect(hit.statusCode).toBe(302);
      expect(hit.headers["x-cache"]).toBe("HIT");
      expect(hit.headers["server-timing"]).toBeUndefined();
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

    test("sheds new Postgres lookups when the redirect queue fills or expires", async () => {
      const guardedApp = buildApp(databaseUrl, {
        poolMax: 1,
        redisUrl,
        reportCacheHit: true,
        redirectMaxWaiters: 1,
        redirectCheckoutTimeoutMs: 150,
      });
      guardedApp.log.level = "silent";
      onTestFinished(() => guardedApp.close());

      const [activeCode, queuedCode, overflowCode] = await Promise.all([
        createLink(),
        createLink(),
        createLink(),
      ]);
      await redis.set("shortlink:redirect:guard-hit", targetUrl, "EX", 60);
      await vi.waitFor(async () => {
        expect((await guardedApp.inject("/guard-hit")).headers["x-cache"]).toBe(
          "HIT",
        );
      });

      const locker = new Client({ connectionString: databaseUrl });
      await locker.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE links IN ACCESS EXCLUSIVE MODE");
        const active = guardedApp
          .inject(`/${activeCode}`)
          .then((response) => response);
        await vi.waitFor(
          async () => {
            const { rows } = await locker.query<{ blocked: number }>(`
            SELECT count(*)::int AS blocked
            FROM pg_locks
            WHERE relation = 'links'::regclass
              AND mode = 'AccessShareLock'
              AND NOT granted
          `);
            expect(rows[0]?.blocked).toBe(1);
          },
          { interval: 5, timeout: 150 },
        );

        const missesBefore = await readRedisMisses();
        const queued = guardedApp
          .inject(`/${queuedCode}`)
          .then((response) => response);
        await expect
          .poll(readRedisMisses, { interval: 5, timeout: 75 })
          .toBe(missesBefore + 1);

        const overflow = await Promise.race([
          guardedApp.inject(`/${overflowCode}`),
          queued.then(() => undefined),
        ]);
        expect(overflow?.statusCode).toBe(503);
        expect(overflow?.headers["cache-control"]).toBe("no-store");
        expect(overflow?.json()).toEqual({
          error: "Redirect temporarily unavailable",
        });

        const [hit, expired] = await Promise.all([
          guardedApp.inject("/guard-hit"),
          queued,
        ]);
        expect(hit.statusCode).toBe(302);
        expect(hit.headers["x-cache"]).toBe("HIT");
        expect(expired.statusCode).toBe(503);
        expect(expired.headers["cache-control"]).toBe("no-store");

        const guardMetrics =
          guardedApp.getDecorator<FastifyInstance>("metricsServer");
        const diagnosticBody = (await guardMetrics.inject("/metrics")).body;
        expect(diagnosticBody).toContain(
          'shortlink_redirect_db_checkout_rejections_total{reason="queue_full"} 1',
        );
        expect(diagnosticBody).toContain(
          'shortlink_redirect_db_checkout_rejections_total{reason="timeout"} 1',
        );
        expect(diagnosticBody).toContain(
          'shortlink_redirect_redis_reads_total{outcome="hit"}',
        );

        // A follower can still join the active lookup. A write can use the
        // connection once the expired checkout releases it.
        const shared = guardedApp
          .inject(`/${activeCode}`)
          .then((response) => response);
        await expect
          .poll(readRedisMisses, { interval: 5, timeout: 75 })
          .toBe(missesBefore + 3);
        const created = guardedApp.inject({
          method: "POST",
          url: "/links",
          payload: { targetUrl },
        });
        await locker.query("ROLLBACK");
        const [redirect, coalesced, write] = await Promise.all([
          active,
          shared,
          created,
        ]);
        expect(redirect.statusCode).toBe(302);
        expect(coalesced.statusCode).toBe(302);
        expect(coalesced.headers["x-cache"]).toBe("COALESCED");
        expect(write.statusCode).toBe(201);
        expect(await redis.get(`shortlink:redirect:${queuedCode}`)).toBeNull();
      } finally {
        await locker.end();
        await redis.del("shortlink:redirect:guard-hit");
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
