// Benchmark-only Node preload. No diagnostic endpoint or per-request logging.
import { createRequire } from "node:module";
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} from "node:perf_hooks";

const { Redis } = createRequire(
  new URL("../apps/redirect-service/package.json", import.meta.url),
)("ioredis");
const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastUtilization = performance.eventLoopUtilization();
let lastSampleAt = performance.now();
let gcMaxMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
});
observer.observe({ entryTypes: ["gc"] });
const clients = [
  [
    "direct",
    new Redis("redis://redis:6379", {
      commandTimeout: 1000,
      enableOfflineQueue: false,
    }),
  ],
  [
    "proxy",
    new Redis(process.env.REDIS_URL, {
      commandTimeout: 1000,
      enableOfflineQueue: false,
    }),
  ],
];
for (const [, client] of clients) client.on("error", () => {});
function log(fields) {
  console.log(
    JSON.stringify({
      time: Date.now(),
      msg: "Benchmark runtime diagnostics",
      ...fields,
    }),
  );
}
const probing = new Set();
const timer = setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const utilization = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(utilization, lastUtilization);
  log({
    kind: "runtime",
    windowMs: now - lastSampleAt,
    eventLoopDelayMaxMs: loop.max / 1e6,
    eventLoopDelayP99Ms: loop.percentile(99) / 1e6,
    eventLoopUtilization: delta.utilization,
    cpuPct:
      ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) /
        ((now - lastSampleAt) * 1000)) *
      100,
    gcMaxMs,
    heapUsedBytes: process.memoryUsage().heapUsed,
  });
  lastSampleAt = now;
  lastCpu = cpu;
  lastUtilization = utilization;
  gcMaxMs = 0;
  loop.reset();
  for (const [path, client] of clients) {
    if (client.status !== "ready" || probing.has(path)) continue;
    probing.add(path);
    const startedAt = performance.now();
    client
      .ping()
      .then(
        () =>
          log({
            kind: "probe",
            path,
            startedAtMs: performance.timeOrigin + startedAt,
            elapsedMs: performance.now() - startedAt,
            ok: true,
          }),
        () =>
          log({
            kind: "probe",
            path,
            startedAtMs: performance.timeOrigin + startedAt,
            elapsedMs: performance.now() - startedAt,
            ok: false,
          }),
      )
      .finally(() => probing.delete(path));
  }
}, 250);
timer.unref();
// A controller may deliberately block this benchmark process to check whether
// client-side deadlines alone can produce the same breaker trip.
function stall() {
  log({ kind: "injected-stall", stage: "start" });
  const startedAt = performance.now();
  while (performance.now() - startedAt < 50) {
    // Deliberate 50ms synchronous work in this diagnostic process only.
  }
  log({
    kind: "injected-stall",
    stage: "end",
    elapsedMs: performance.now() - startedAt,
  });
}
process.on("SIGUSR2", stall);
function stop() {
  clearInterval(timer);
  loop.disable();
  observer.disconnect();
  process.off("SIGUSR2", stall);
  for (const [, client] of clients) client.disconnect();
}
process.once("exit", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
