import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

type PoolState = Pick<Pool, "totalCount" | "idleCount" | "waitingCount">;

export function registerMetrics(app: FastifyInstance, pool: PoolState) {
  // Each app owns a registry, just as it owns its database pool.
  const registry = new Registry();
  const labels = ["method", "route", "status_code"] as const;
  const requests = new Counter({
    name: "shortlink_http_requests_total",
    help: "Completed application HTTP responses, excluding health probes.",
    labelNames: labels,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "shortlink_http_request_duration_seconds",
    help: "Fastify response duration in seconds, excluding health probes.",
    labelNames: labels,
    // The 0.1s boundary records the server-side fraction within 100ms exactly.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.2, 0.3, 0.5, 1, 2],
    registers: [registry],
  });
  new Gauge({
    name: "shortlink_db_pool_connections",
    help: "Pool clients by state; in_use includes clients still connecting.",
    labelNames: ["state"] as const,
    registers: [registry],
    collect() {
      this.set({ state: "in_use" }, pool.totalCount - pool.idleCount);
      this.set({ state: "idle" }, pool.idleCount);
    },
  });
  new Gauge({
    name: "shortlink_db_pool_waiting_requests",
    help: "Checkouts currently waiting in the pg pool queue.",
    registers: [registry],
    collect() {
      this.set(pool.waitingCount);
    },
  });

  app.addHook("onResponse", async (request, reply) => {
    // Use the registered template, never a raw URL, code, or query string.
    const route = request.routeOptions.url ?? "unmatched";
    if (route === "/healthz" || route === "/readyz") return;
    const method = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ].includes(request.method)
      ? request.method
      : "OTHER";
    const values = { method, route, status_code: String(reply.statusCode) };
    requests.inc(values);
    duration.observe(values, reply.elapsedTime / 1000);
  });

  // This listener has its own port; Gateway traffic uses the application port.
  const metricsServer = Fastify({ logger: false });
  metricsServer.get("/metrics", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.type(registry.contentType);
    return registry.metrics();
  });
  return metricsServer;
}
