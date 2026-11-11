import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";
import { registerLinkRoutes } from "../src/links.js";
import { registerMetrics } from "../src/metrics.js";
import { registerRedirectRoute } from "../src/redirect.js";
import { RedirectPoolBusyError } from "../src/redirect-admission.js";

function setup() {
  const app = Fastify();
  const pool = { totalCount: 3, idleCount: 1, waitingCount: 4 };
  const metrics = registerMetrics(app, pool);
  onTestFinished(async () => {
    await app.close();
    await metrics.close();
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  registerRedirectRoute(app, async (code) => {
    if (code === "missing") return undefined;
    if (code === "busy") throw new RedirectPoolBusyError("queue full");
    if (code === "failed") throw new Error("database unavailable");
    return "https://example.com/private-destination";
  });
  registerLinkRoutes(app, {
    insert: async (code, targetUrl) => ({
      code,
      targetUrl,
      createdAt: new Date(),
    }),
  });
  const scrape = async () => {
    const response = await metrics.inject("/metrics");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("version=0.0.4");
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.body;
  };
  return { app, pool, scrape };
}

function sample(
  body: string,
  name: string,
  labels: Record<string, string> = {},
) {
  const line = body
    .split("\n")
    .find(
      (line) =>
        line.split(/[ {]/, 1)[0] === name &&
        Object.entries(labels).every(([key, value]) =>
          line.includes(`${key}="${value}"`),
        ),
    );
  expect(
    line,
    `Missing metric sample: ${name} ${JSON.stringify(labels)}`,
  ).toBeDefined();
  return Number(line?.split(" ").at(-1));
}

describe("application metrics", () => {
  test("aggregates codes into one route and counts actual HTTP response statuses", async () => {
    const { app, scrape } = setup();
    for (const url of [
      "/alpha123?token=private-query",
      "/bravo123",
      "/missing",
      "/busy",
      "/failed",
      "/not/a/route",
      "/another/unknown/path",
    ]) {
      await app.inject(url);
    }
    await app.inject({
      method: "POST",
      url: "/links",
      payload: { targetUrl: "https://example.com/private-input" },
    });
    const body = await scrape();
    const redirect = { method: "GET", route: "/:code" };
    expect(
      sample(body, "shortlink_http_requests_total", {
        ...redirect,
        status_code: "302",
      }),
    ).toBe(2);
    for (const status_code of ["404", "500", "503"]) {
      expect(
        sample(body, "shortlink_http_requests_total", {
          ...redirect,
          status_code,
        }),
      ).toBe(1);
    }
    expect(
      sample(body, "shortlink_http_requests_total", {
        method: "POST",
        route: "/links",
        status_code: "201",
      }),
    ).toBe(1);
    expect(
      sample(body, "shortlink_http_requests_total", {
        method: "GET",
        route: "unmatched",
        status_code: "404",
      }),
    ).toBe(2);
    for (const privateValue of [
      "alpha123",
      "bravo123",
      "private-query",
      "private-destination",
      "private-input",
      "/not/a/route",
    ]) {
      expect(body).not.toContain(privateValue);
    }
  });

  test("converts milliseconds to seconds and separates the 100ms histogram bucket", async () => {
    const { app, scrape } = setup();
    // Supply deterministic elapsed times rather than relying on wall-clock sleeps.
    app.addHook("onSend", async (request, reply, payload) => {
      Object.defineProperty(reply, "elapsedTime", {
        value: request.url === "/fastcode" ? 75 : 125,
      });
      return payload;
    });
    await app.inject("/fastcode");
    await app.inject("/slowcode");
    const body = await scrape();
    const labels = { method: "GET", route: "/:code", status_code: "302" };
    expect(
      sample(body, "shortlink_http_request_duration_seconds_bucket", {
        ...labels,
        le: "0.1",
      }),
    ).toBe(1);
    expect(
      sample(body, "shortlink_http_request_duration_seconds_bucket", {
        ...labels,
        le: "+Inf",
      }),
    ).toBe(2);
    expect(
      sample(body, "shortlink_http_request_duration_seconds_count", labels),
    ).toBe(2);
    expect(
      sample(body, "shortlink_http_request_duration_seconds_sum", labels),
    ).toBeCloseTo(0.2);
  });

  test("samples pool state on scrape without counting probes or scrapes as traffic", async () => {
    const { app, pool, scrape } = setup();
    await app.inject("/healthz");
    await app.inject("/readyz");
    const first = await scrape();
    expect(
      sample(first, "shortlink_db_pool_connections", { state: "in_use" }),
    ).toBe(2);
    expect(
      sample(first, "shortlink_db_pool_connections", { state: "idle" }),
    ).toBe(1);
    expect(sample(first, "shortlink_db_pool_waiting_requests")).toBe(4);
    Object.assign(pool, { totalCount: 3, idleCount: 3, waitingCount: 0 });
    const second = await scrape();
    expect(
      sample(second, "shortlink_db_pool_connections", { state: "in_use" }),
    ).toBe(0);
    expect(
      sample(second, "shortlink_db_pool_connections", { state: "idle" }),
    ).toBe(3);
    expect(sample(second, "shortlink_db_pool_waiting_requests")).toBe(0);
    expect(second).not.toContain("shortlink_http_requests_total{");
  });

  test("keeps registries isolated between application instances", async () => {
    const first = setup();
    const second = setup();
    await first.app.inject("/first123");
    expect(
      sample(await first.scrape(), "shortlink_http_requests_total", {
        route: "/:code",
      }),
    ).toBe(1);
    expect(await second.scrape()).not.toContain(
      "shortlink_http_requests_total{",
    );
  });
});
