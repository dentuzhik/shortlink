import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const [project, baseUrl, rate] = process.argv.slice(2);
assert(Number.isInteger(Number(rate)) && Number(rate) > 0);
const run = promisify(execFile);
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  "benchmarks/.env.example",
  "-f",
  "compose.yaml",
  "-f",
  "benchmarks/compose.yaml",
  "-f",
  "benchmarks/compose.host.yaml",
  "-f",
  "benchmarks/compose.budget.yaml",
];
async function compose(...args) {
  return (
    await run("docker", [...composeArgs, ...args], {
      maxBuffer: 256 * 1024 * 1024,
    })
  ).stdout;
}
// Resolve containers before the timed run, avoiding Compose discovery at each
// transition while the VM is busy serving traffic.
const [redisId, proxyId] = await Promise.all(
  ["redis", "redis-proxy"].map(async (service) =>
    (await compose("ps", "-q", service)).trim(),
  ),
);
assert(redisId && proxyId, "Recovery benchmark containers are missing");
async function containerExec(id, ...args) {
  return (await run("docker", ["exec", id, ...args])).stdout;
}
function proxy(...args) {
  return containerExec(proxyId, "/toxiproxy-cli", ...args);
}
async function getCalls() {
  const stats = await containerExec(
    redisId,
    "redis-cli",
    "-e",
    "INFO",
    "commandstats",
  );
  const match = /^cmdstat_get:calls=(\d+),/m.exec(stats);
  assert(match, "Redis GET statistics are missing");
  return Number(match[1]);
}

const directory = await mkdtemp(join(tmpdir(), "shortlink-recovery-"));
const summaryPath = join(directory, "summary.json");
// Both the native load generator and this controller use the host clock.
const startAt = Date.now() + 5000;
const child = spawn(
  "k6",
  [
    "run",
    "--quiet",
    "--no-color",
    "-e",
    `BASE_URL=${baseUrl}`,
    "-e",
    `RATE=${rate}`,
    "-e",
    `BENCH_VUS=${process.env.BENCH_VUS || 400}`,
    "-e",
    `BENCH_START_AT_MS=${startAt}`,
    "-e",
    `BENCH_SUMMARY_PATH=${summaryPath}`,
    "benchmarks/redis-recovery.js",
  ],
  { stdio: "inherit", env: { ...process.env, K6_NO_USAGE_REPORT: "true" } },
);
const finished = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
async function until(offsetMs) {
  await setTimeout(Math.max(0, startAt + offsetMs - Date.now()));
  assert(
    child.exitCode === null && child.signalCode === null,
    "k6 exited before the transition",
  );
}
async function transition(offsetMs, action) {
  await until(offsetMs);
  await action();
  const lag = Date.now() - startAt - offsetMs;
  console.log(
    `Redis fault control at +${offsetMs / 1000}s completed ${lag}ms after boundary`,
  );
  assert(
    lag >= 0 && lag <= 500,
    "Fault control missed its phase boundary by more than 500ms",
  );
}

let toxicInstalled = false;
try {
  console.log(
    `\nContinuous recovery trial: ${rate} redirects/s + 10 creations/s; 15s healthy → 15s delayed → 15s recovery`,
  );
  await transition(15000, async () => {
    await proxy("toxic", "add", "-t", "latency", "-a", "latency=75", "redis");
    toxicInstalled = true;
  });
  await until(18000);
  const sampleStart = Date.now();
  const before = await getCalls();
  await until(27000);
  const after = await getCalls();
  const sampleSeconds = (Date.now() - sampleStart) / 1000;
  const attempts = after - before;
  console.log(
    `Stable fault window: ${attempts} actual Redis GETs in ${sampleSeconds.toFixed(3)}s, with about ${Math.round(Number(rate) * sampleSeconds)} offered redirects`,
  );
  assert(
    attempts > 0 && attempts <= Math.ceil(sampleSeconds) * 2 + 2,
    "Stable fault reads should be limited to roughly one half-open probe per second",
  );
  await transition(30000, async () => {
    await proxy("toxic", "remove", "-n", "latency_downstream", "redis");
    toxicInstalled = false;
  });
  const result = await finished;
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const value = (name, phase, field) =>
    summary.metrics[`${name}{phase:${phase}}`].values[field];
  for (const phase of ["healthy", "timeout", "recovery"]) {
    console.log(
      JSON.stringify({
        phase,
        redirects: value("redirect_starts", phase, "count"),
        correctWithin100msPct:
          value("correct_redirect_within_100ms", phase, "rate") * 100,
        redirectP99Ms: value("redirect_elapsed", phase, "p(99)"),
        overloads: value("redirect_overload_responses", phase, "count"),
        cacheHitPct: value("redis_hit", phase, "rate") * 100,
        creations: value("creation_starts", phase, "count"),
        creationSuccessPct: value("link_creation_success", phase, "rate") * 100,
        creationP99Ms: value("link_creation_elapsed", phase, "p(99)"),
      }),
    );
  }
  console.log(
    `Dropped starts: ${summary.metrics.dropped_iterations.values.count}`,
  );
  const failures = Object.entries(summary.metrics).flatMap(([metric, data]) =>
    Object.entries(data.thresholds ?? {})
      .filter(([, threshold]) => !threshold.ok)
      .map(([threshold]) => `${metric}: ${threshold}`),
  );
  console.log(
    `Failed thresholds: ${failures.length ? failures.join(", ") : "none"}`,
  );
  const logs = await compose(
    "logs",
    "--no-color",
    "--no-log-prefix",
    "--since",
    new Date(startAt).toISOString(),
    "redirect-service",
  );
  const events = logs
    .split("\n")
    .filter((line) => line.includes('"msg":"Redis read circuit '))
    .map((line) => JSON.parse(line));
  for (const event of events)
    console.log(
      `Breaker at +${((event.time - startAt) / 1000).toFixed(3)}s: ${event.msg}`,
    );
  assert(
    events.some(
      (event) => event.msg.endsWith("opened") && event.time < startAt + 30000,
    ),
    "Circuit did not open during the fault",
  );
  assert(
    events.some(
      (event) => event.msg.endsWith("closed") && event.time >= startAt + 30000,
    ),
    "Circuit did not close after Redis recovered",
  );
  assert.equal(result.code, 0, `k6 failed: ${JSON.stringify(result)}`);
} finally {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  await finished;
  if (toxicInstalled)
    await proxy("toxic", "remove", "-n", "latency_downstream", "redis");
  await rm(directory, { recursive: true, force: true });
}
