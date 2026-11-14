import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import {
  createAndFollow,
  destinationServer,
  observePage,
  openCreator,
} from "../tests/e2e/web-flow.mjs";
import { servingPods, templateRelease } from "./lib/redirect-release.mjs";
import { webTestTarget } from "./lib/web-test-target.mjs";

const [commit, ...extra] = process.argv.slice(2);
if (extra.length)
  throw new Error(
    "Usage: test-web-rollout.mjs [published-commit]; no commit means restart the current web image",
  );
const rate = Number(process.env.RATE ?? 100);
const createRate = Number(process.env.CREATE_RATE ?? 2);
if (
  ![rate, createRate].every((value) => Number.isSafeInteger(value) && value > 0)
)
  throw new Error("RATE and CREATE_RATE must be positive integers");
const execute = promisify(execFile);
const output = async (cmd, args) =>
  (await execute(cmd, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024 }))
    .stdout;
const target = webTestTarget(process.env, commit);
const kubeArgs = target.kubeArgs;
const kube = (...args) => output("kubectl", [...kubeArgs, ...args]);
const json = async (...args) => JSON.parse(await kube(...args, "-o", "json"));
const before = await json("get", "deployment", "web");
const baseline = templateRelease(before.spec.template, "web");
const initialPods = (await json("get", "pods", "-l", "app=web")).items;
const original = servingPods(
  initialPods,
  baseline,
  before.spec.replicas,
  "web",
);
if (
  initialPods.length !== before.spec.replicas ||
  before.spec.template.spec.containers.find((c) => c.name === "web")?.lifecycle
    ?.preStop?.sleep?.seconds !== 5
)
  throw new Error(
    "Start with a stable versioned web Deployment and its five-second drain hook",
  );
const appOrigin = "http://app.localhost:8080";
const shortOrigin = "http://go.localhost:8080";
const directory = target.directory;
await mkdir(directory, { recursive: true });
const report = {
  directory,
  context: target.context,
  commit,
  rate,
  createRate,
  createdAt: Date.now(),
  baseline,
  originalPods: original.map((p) => p.metadata.name),
  windows: { baseline: 10, rollout: 60, after: 15 },
  browserFlows: [],
};
console.log(`Web rollout evidence: ${directory}`);
const timeline = createWriteStream(`${directory}/timeline.ndjson`);
const browserLog = createWriteStream(`${directory}/browser.ndjson`);
let monitoring = true;
const availability = [];
async function snapshot() {
  const resources = (await json("get", "pods,deployments,endpointslices"))
    .items;
  const deployment = resources.find(
    (item) => item.kind === "Deployment" && item.metadata.name === "web",
  );
  const pods = resources.filter(
    (item) => item.kind === "Pod" && item.metadata.labels?.app === "web",
  );
  availability.push(deployment.status.availableReplicas ?? 0);
  timeline.write(
    `${JSON.stringify({ at: Date.now(), available: deployment.status.availableReplicas ?? 0, pods: pods.map((p) => ({ name: p.metadata.name, terminating: Boolean(p.metadata.deletionTimestamp), ready: p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"), imageID: p.status.containerStatuses?.find((c) => c.name === "web")?.imageID })), endpoints: resources.filter((item) => item.kind === "EndpointSlice" && item.metadata.labels?.["kubernetes.io/service-name"] === "web").flatMap((item) => item.endpoints) })}\n`,
  );
}
const monitor = (async () => {
  while (monitoring) {
    await snapshot().catch((error) =>
      timeline.write(
        `${JSON.stringify({ at: Date.now(), error: error.message })}\n`,
      ),
    );
    await pause(1000);
  }
})();
let browser, destination, k6, k6Done, k6Log, browserFailure;
let initialContext, initialPage;
let running = true;
const browserTasks = [];
const interrupt = () => {
  running = false;
  report.interrupted = true;
  k6?.kill("SIGINT");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const currentPhase = () => {
  const ms = Date.now() - report.startedAt;
  return ms < 10000 ? "baseline" : ms < 70000 ? "rollout_window" : "after";
};
async function visitor(mode, warm) {
  let warmContext, warmPage, warmWatch;
  try {
    if (warm) {
      warmContext = warm.context;
      warmPage = warm.page;
      warmWatch = warm.observed;
    }
    while (running && Date.now() < report.startedAt + 85000) {
      const context = warmContext ?? (await browser.newContext());
      const page = warmPage ?? (await context.newPage());
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(10000);
      const observed = warmWatch ?? observePage(page, appOrigin);
      if (!warmContext)
        await context.tracing.start({ screenshots: true, snapshots: true });
      const sample = { mode, phase: currentPhase(), startedAt: Date.now() };
      try {
        if (!warmPage) await openCreator(page, appOrigin);
        sample.link = await createAndFollow(
          page,
          appOrigin,
          shortOrigin,
          `${destination.origin}/${randomUUID()}`,
        );
        assert.deepEqual(
          observed.errors,
          [],
          "Browser recorded application or asset failures",
        );
        sample.passed = true;
      } catch (error) {
        sample.passed = false;
        sample.error = error.message;
        sample.browserErrors = observed.errors;
        browserFailure ??= error;
        running = false;
        const prefix = `${directory}/${mode}-${sample.startedAt}`;
        await page.screenshot({ path: `${prefix}.png` }).catch(() => {});
        await context.tracing
          .stop({ path: `${prefix}-trace.zip` })
          .catch(() => {});
      } finally {
        sample.finishedAt = Date.now();
        report.browserFlows.push(sample);
        browserLog.write(`${JSON.stringify(sample)}\n`);
        if (!warmContext) {
          observed.dispose();
          await context.close();
        }
      }
      await pause(500);
    }
  } catch (error) {
    browserFailure ??= error;
    running = false;
  } finally {
    if (warmContext) {
      if (warmWatch.errors.length)
        browserFailure ??= new Error(
          "Existing browser session recorded errors",
        );
      warmWatch.dispose();
      await warmContext.close();
    }
  }
}
async function waitUntil(time) {
  while (Date.now() < time) {
    if (!running || browserFailure)
      throw browserFailure ?? new Error("Test interrupted");
    if (
      (k6.exitCode !== null &&
        (k6.exitCode !== 0 || Date.now() < report.startedAt + 84000)) ||
      k6.signalCode !== null
    )
      throw new Error("k6 exited before the observation window finished");
    await pause(100);
  }
}
try {
  destination = await destinationServer();
  browser = await chromium.launch();
  const context = await browser.newContext();
  initialContext = context;
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  initialPage = page;
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  const observed = observePage(page, appOrigin);
  await openCreator(page, appOrigin);
  assert.deepEqual(observed.errors, []);
  let native = process.env.K6_BIN;
  if (!native) {
    try {
      await output("k6", ["version"]);
      native = "k6";
    } catch {}
  }
  const container = `shortlink-web-k6-${process.pid}`;
  report.k6Container = native ? undefined : container;
  report.runner = native ?? "docker (shares Colima resources)";
  const args = native
    ? [
        "run",
        "--quiet",
        "--no-color",
        "--summary-export",
        `${directory}/k6-summary.json`,
        "-e",
        "BASE_URL=http://127.0.0.1:8080",
        "-e",
        `RATE=${rate}`,
        "-e",
        `CREATE_RATE=${createRate}`,
        "benchmarks/web-rollout.js",
      ]
    : [
        "run",
        "--rm",
        "--name",
        container,
        "--network",
        "kind",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-e",
        "K6_NO_USAGE_REPORT=true",
        "-v",
        `${resolve("benchmarks")}:/benchmarks:ro`,
        "-v",
        `${directory}:/results`,
        "grafana/k6:2.3.0",
        "run",
        "--quiet",
        "--no-color",
        "--summary-export",
        "/results/k6-summary.json",
        "-e",
        "BASE_URL=http://shortlink-edge-bridge-1:8080",
        "-e",
        `RATE=${rate}`,
        "-e",
        `CREATE_RATE=${createRate}`,
        "/benchmarks/web-rollout.js",
      ];
  k6Log = createWriteStream(`${directory}/k6.log`);
  k6 = spawn(native ?? "docker", args, {
    env: { ...process.env, K6_NO_USAGE_REPORT: "true" },
  });
  k6Done = new Promise((done) => {
    k6.once("error", (error) => done({ error: error.message }));
    k6.once("close", (code, signal) => done({ code, signal }));
  });
  let marker = "";
  const ready = new Promise((done) => {
    for (const stream of [k6.stdout, k6.stderr])
      stream.on("data", (chunk) => {
        k6Log.write(chunk);
        marker = `${marker}${chunk}`.slice(-8192);
        const match = marker.match(/WEB_ROLLOUT_READY (\d+)/);
        if (match && !report.startedAt) {
          report.startedAt = Number(match[1]);
          done();
        }
      });
  });
  let setupTimer;
  try {
    await Promise.race([
      ready,
      k6Done.then((result) => {
        throw new Error(`k6 exited before setup: ${JSON.stringify(result)}`);
      }),
      new Promise((_, reject) => {
        setupTimer = setTimeout(
          () => reject(new Error("k6 setup exceeded 60s")),
          60000,
        );
      }),
    ]);
  } finally {
    clearTimeout(setupTimer);
  }
  browserTasks.push(
    visitor("fresh", null),
    visitor("existing", { context, page, observed }),
  );
  await waitUntil(report.startedAt + 10000);
  for (const mode of ["fresh", "existing"])
    assert.ok(
      report.browserFlows.some(
        (flow) =>
          flow.mode === mode && flow.phase === "baseline" && flow.passed,
      ),
      `Missing ${mode} baseline coverage`,
    );
  report.rolloutRequestedAt = Date.now();
  console.log(
    commit
      ? `Deploying published web commit ${commit}`
      : "Restarting web pods; browser sessions and k6 continue",
  );
  if (commit)
    await writeFile(
      `${directory}/deployment.log`,
      await output("node", [
        "scripts/release-redirect.mjs",
        "web",
        "deploy",
        commit,
      ]),
    );
  else {
    await kube("rollout", "restart", "deployment/web");
    await writeFile(
      `${directory}/deployment.log`,
      await kube("rollout", "status", "deployment/web", "--timeout=60s"),
    );
  }
  report.rolloutCompletedAt = Date.now();
  assert.ok(
    report.rolloutCompletedAt < report.startedAt + 70000,
    "Rollout exceeded its 60-second window",
  );
  const after = await json("get", "deployment", "web");
  report.release = templateRelease(after.spec.template, "web");
  const serving = servingPods(
    (await json("get", "pods", "-l", "app=web")).items,
    report.release,
    after.spec.replicas,
    "web",
  );
  assert.ok(
    serving.every((p) => !report.originalPods.includes(p.metadata.name)),
    "Original web pods were not replaced",
  );
  report.replacementStartedAt = Math.max(
    report.rolloutRequestedAt,
    Math.min(...serving.map((p) => Date.parse(p.metadata.creationTimestamp))),
  );
  if (!commit)
    assert.equal(
      report.release.image,
      baseline.image,
      "A restart must retain the image",
    );
  await waitUntil(report.startedAt + 85000);
  running = false;
  await Promise.all(browserTasks);
  report.k6Exit = await k6Done;
  if (browserFailure) throw browserFailure;
  assert.equal(
    report.k6Exit.code,
    0,
    "k6 correctness, latency or throughput thresholds failed",
  );
  for (const mode of ["fresh", "existing"]) {
    for (const phase of ["baseline", "rollout_window", "after"])
      assert.ok(
        report.browserFlows.some(
          (flow) => flow.mode === mode && flow.phase === phase && flow.passed,
        ),
        `Missing ${mode}/${phase} browser coverage`,
      );
    assert.ok(
      report.browserFlows.some(
        (flow) =>
          flow.mode === mode &&
          flow.finishedAt >= report.replacementStartedAt &&
          flow.startedAt < report.rolloutCompletedAt &&
          flow.passed,
      ),
      `No ${mode} flow overlapped pod replacement`,
    );
  }
  report.minSampledAvailable = Math.min(...availability);
  assert.ok(
    report.minSampledAvailable >= 1,
    "A sample had no available web replica",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  if (initialPage && !initialPage.isClosed()) {
    await initialPage
      .screenshot({ path: `${directory}/failure.png` })
      .catch(() => {});
    await initialContext.tracing
      .stop({ path: `${directory}/failure-trace.zip` })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  running = false;
  if (k6 && k6.exitCode === null && k6.signalCode === null) k6.kill("SIGINT");
  if (report.k6Container)
    await output("docker", ["rm", "--force", report.k6Container]).catch(
      () => {},
    );
  await Promise.allSettled(browserTasks);
  if (k6Done) report.k6Exit = await k6Done;
  k6Log?.end();
  for (const cleanup of [() => browser?.close(), () => destination?.close()]) {
    try {
      await cleanup();
    } catch (error) {
      report.cleanupError = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  monitoring = false;
  await monitor;
  await snapshot().catch(() => {});
  timeline.end();
  browserLog.end();
  try {
    await writeFile(
      `${directory}/events.json`,
      await kube("get", "events", "-o", "json"),
    );
    await writeFile(
      `${directory}/web.log`,
      await kube("logs", "deployment/web", "--timestamps", "--since=5m"),
    );
  } catch (error) {
    report.diagnosticsError = error.message;
  }
  report.finishedAt = Date.now();
  report.minSampledAvailable = Math.min(...availability);
  if (!target.isCI)
    report.dashboardUrl = `http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview?from=${report.createdAt}&to=${report.finishedAt}`;
  report.browser = {
    flows: report.browserFlows.length,
    failures: report.browserFlows.filter((flow) => !flow.passed).length,
  };
  await writeFile(
    `${directory}/run.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!target.isCI)
    await writeFile(
      resolve(".kind/web-rollout/last-run.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        error: report.error,
        browser: report.browser,
        k6: report.k6Exit,
        evidence: directory,
      },
      null,
      2,
    ),
  );
}
