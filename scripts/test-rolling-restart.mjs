import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertSourceConfiguration,
  assertSourcePods,
  fastifyRolloutPlan,
} from "./lib/fastify-rollout.mjs";

import { assertSourceStatus } from "./lib/ha-target.mjs";

const execute = promisify(execFile);
const plan = fastifyRolloutPlan(process.argv.slice(2));
process.env.DOCKER_CONTEXT = "colima";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const redirectRate = Number(process.env.RATE ?? 1000);
const createRate = Number(process.env.CREATE_RATE ?? 10);
const redirectWorkers = Number(process.env.REDIRECT_WORKERS ?? 350);
const createWorkers = Number(process.env.CREATE_WORKERS ?? 50);
if (
  !Number.isSafeInteger(redirectRate) ||
  redirectRate < 1 ||
  !Number.isSafeInteger(createRate) ||
  createRate < 0 ||
  !Number.isSafeInteger(redirectWorkers) ||
  redirectWorkers < 1 ||
  !Number.isSafeInteger(createWorkers) ||
  createWorkers < 1
) {
  throw new Error(
    "RATE must be a positive integer; CREATE_RATE must be nonnegative",
  );
}
const kubeArgs = [
  "--kubeconfig",
  ".kind/kubeconfig",
  "--context",
  "kind-shortlink",
  "--namespace",
  "shortlink",
];
const kube = async (...args) =>
  (await execute("kubectl", [...kubeArgs, ...args])).stdout;
const deployment = JSON.parse(
  await kube("get", "deployment", "redirect-service", "-o", "json"),
);
const strategy = deployment.spec.strategy;
if (
  deployment.spec.replicas !== 2 ||
  deployment.status.availableReplicas !== 2 ||
  strategy.type !== "RollingUpdate" ||
  strategy.rollingUpdate.maxUnavailable !== 0 ||
  strategy.rollingUpdate.maxSurge !== 1
) {
  throw new Error(
    "Apply deploy/k8s/apps.yaml first: this test requires two available replicas, maxUnavailable: 0 and maxSurge: 1.",
  );
}

let imagePreparation;
if (plan.action === "application-roles") {
  const staged = await execute(
    "node",
    ["scripts/prepare-application-roles.mjs", "stage", plan.revision],
    { timeout: 420000, maxBuffer: 8 * 1024 * 1024 },
  );
  imagePreparation = {
    mode: "Both runtime roles and published image staged",
    log: staged.stdout,
  };
  process.stdout.write(staged.stdout);
}
if (plan.action === "ha-target") {
  const staged = await execute(
    "node",
    ["scripts/prepare-ha-target.mjs", "stage"],
    { timeout: 45000 },
  );
  imagePreparation = {
    mode: "HA credentials staged; same image",
    log: staged.stdout,
  };
  process.stdout.write(staged.stdout);
}
if (["deploy", "deploy-local"].includes(plan.action)) {
  const maps = JSON.parse(await kube("get", "configmaps", "-o", "json")).items;
  const control = maps.find((map) => map.metadata.name === "shortlink-runtime");
  if (control)
    assertSourceConfiguration(JSON.parse(control.data["control.json"]));
  const previous =
    deployment.spec.template.metadata.annotations?.[
      "shortlink.dev/git-revision"
    ];
  if (previous === plan.revision)
    throw new Error(
      "Select a different image revision for a versioned rollout test",
    );
  if (plan.action === "deploy") {
    const startedAt = Date.now();
    const prepared = await execute(
      "node",
      ["scripts/release-redirect.mjs", "stage", plan.revision],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    imagePreparation = {
      startedAt,
      finishedAt: Date.now(),
      mode: "published image staged in kind node",
      log: prepared.stdout,
    };
    process.stdout.write(prepared.stdout);
  }
  if (plan.action === "deploy-local") {
    // Build before starting load; the deployment command will reuse the SHA image.
    const prepared = await execute(
      "node",
      ["scripts/release-redirect.mjs", "build", plan.revision],
      { timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(prepared.stdout);
  }
}
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runDir = resolve(".kind/rolling-restart", stamp);
await mkdir(runDir, { recursive: true });
const report = {
  createdAt: Date.now(),
  operation: plan,
  imagePreparation,
  runDir,
  rate: redirectRate,
  createRate,
  redirectWorkers,
  createWorkers,
  durationSeconds: 90,
  phases: { baselineSeconds: 20, restartWindowSeconds: 40, afterSeconds: 30 },
  image: deployment.spec.template.spec.containers[0].image,
  lifecycle: deployment.spec.template.spec.containers[0].lifecycle ?? null,
  terminationGracePeriodSeconds:
    deployment.spec.template.spec.terminationGracePeriodSeconds ?? 30,
};
const timeline = createWriteStream(`${runDir}/timeline.ndjson`);
const samples = [];
const followers = [];
const followedPods = new Set();
function followPod(pod) {
  if (followedPods.has(pod)) return;
  followedPods.add(pod);
  const output = createWriteStream(`${runDir}/${pod}.log`);
  const child = spawn("kubectl", [
    ...kubeArgs,
    "logs",
    "--follow",
    "--timestamps",
    `--since-time=${new Date(report.createdAt - 5000).toISOString()}`,
    pod,
  ]);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.once("close", () => output.end());
  followers.push(child);
}
async function snapshot() {
  const resources = JSON.parse(
    await kube("get", "pods,deployments,endpointslices", "-o", "json"),
  ).items;
  const pods = resources
    .filter(
      (item) =>
        item.kind === "Pod" && item.metadata.labels?.app === "redirect-service",
    )
    .map((pod) => ({
      name: pod.metadata.name,
      ip: pod.status.podIP,
      ready: pod.status.conditions?.some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ),
      terminating: Boolean(pod.metadata.deletionTimestamp),
      deletionTimestamp: pod.metadata.deletionTimestamp,
      deletionGracePeriodSeconds: pod.metadata.deletionGracePeriodSeconds,
      phase: pod.status.phase,
      imageID: pod.status.containerStatuses?.[0]?.imageID,
    }));
  const current = resources.find(
    (item) =>
      item.kind === "Deployment" && item.metadata.name === "redirect-service",
  );
  const endpoints = resources
    .filter(
      (item) =>
        item.kind === "EndpointSlice" &&
        item.metadata.labels?.["kubernetes.io/service-name"] ===
          "redirect-service",
    )
    .flatMap((slice) =>
      slice.endpoints.map((endpoint) => ({
        pod: endpoint.targetRef?.name,
        ...endpoint.conditions,
      })),
    );
  const sample = {
    at: Date.now(),
    availableReplicas: current.status.availableReplicas ?? 0,
    pods,
    endpoints,
  };
  samples.push(sample);
  timeline.write(`${JSON.stringify(sample)}\n`);
  // Follow replacement pods too: their request logs can rotate before the
  // trial ends, losing short post-restart rejection bursts on a later fetch.
  if (report.originalPods) {
    for (const pod of pods) {
      if (pod.phase === "Running") followPod(pod.name);
    }
  }
  return sample;
}
const before = await snapshot();
if (before.pods.length !== 2 || before.pods.some((pod) => !pod.ready)) {
  timeline.end();
  throw new Error(
    "Start with exactly two ready Fastify pods and no active rollout",
  );
}
report.originalPods = before.pods.map((pod) => pod.name);
report.containerImageIDs = [...new Set(before.pods.map((pod) => pod.imageID))];
for (const pod of report.originalPods) followPod(pod);

let monitoring = true;
const monitor = (async () => {
  while (monitoring) {
    await pause(1000);
    if (!monitoring) break;
    try {
      await snapshot();
    } catch (error) {
      timeline.write(
        `${JSON.stringify({ at: Date.now(), error: error.message })}\n`,
      );
    }
  }
})();
const log = createWriteStream(`${runDir}/k6.log`);
let nativeRunner = process.env.K6_BIN;
if (!nativeRunner) {
  try {
    await execute("k6", ["version"]);
    nativeRunner = "k6";
  } catch {
    // Match load:demo's portable fallback when k6 is not installed on the Mac.
  }
}
const containerName = `shortlink-rolling-k6-${process.pid}`;
const command = nativeRunner ?? "docker";
const args = nativeRunner
  ? [
      "run",
      "--log-format",
      "raw",
      "--no-color",
      "--quiet",
      "--summary-export",
      `${runDir}/summary.json`,
      "-e",
      "BASE_URL=http://127.0.0.1:8080",
      "-e",
      `RATE=${redirectRate}`,
      "-e",
      `CREATE_RATE=${createRate}`,
      "-e",
      `REDIRECT_WORKERS=${redirectWorkers}`,
      "-e",
      `CREATE_WORKERS=${createWorkers}`,
      "benchmarks/rolling-restart.js",
    ]
  : [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "kind",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "K6_NO_USAGE_REPORT=true",
      "-v",
      `${resolve("benchmarks")}:/benchmarks:ro`,
      "-v",
      `${runDir}:/results`,
      "grafana/k6:2.3.0",
      "run",
      "--log-format",
      "raw",
      "--no-color",
      "--quiet",
      "--summary-export",
      "/results/summary.json",
      "-e",
      "BASE_URL=http://shortlink-edge-bridge-1:8080",
      "-e",
      `RATE=${redirectRate}`,
      "-e",
      `CREATE_RATE=${createRate}`,
      "-e",
      `REDIRECT_WORKERS=${redirectWorkers}`,
      "-e",
      `CREATE_WORKERS=${createWorkers}`,
      "/benchmarks/rolling-restart.js",
    ];
report.runner = nativeRunner ? "native" : "docker (shares the Colima VM)";
console.log(`Artifacts: ${runDir}\nRunner: ${report.runner}`);
console.log(
  `${redirectRate} redirects/s + ${createRate} creations/s for 90s; requesting Fastify ${plan.action} after 20s.`,
);
const child = spawn(command, args, {
  env: { ...process.env, K6_NO_USAGE_REPORT: "true" },
});
const exited = new Promise((done, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => done({ code, signal }));
});
let ready;
const started = new Promise((done) => {
  ready = done;
});
const buffers = new Map();
const acknowledged = [];
let acknowledgementError;
let warningLines = 0;
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    const buffered = (buffers.get(stream) ?? "") + chunk;
    const lines = buffered.split("\n");
    buffers.set(stream, lines.pop());
    for (const line of lines) {
      const marker = line.match(/ROLLING_RESTART_READY (\d+)/);
      if (marker && !report.startedAt) {
        report.startedAt = Number(marker[1]);
        ready();
      }
      if (line.startsWith("CREATION_ACK ")) {
        try {
          acknowledged.push(JSON.parse(line.slice("CREATION_ACK ".length)));
        } catch {
          acknowledgementError = true;
        }
        continue;
      }
      const warning =
        line.includes("Request Failed") ||
        line.includes("REDIRECT_FAILURE") ||
        line.includes("CREATION_FAILURE");
      if (!warning || ++warningLines <= 5) process.stdout.write(`${line}\n`);
    }
  });
}
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  child.kill("SIGINT");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let startTimeout;
try {
  await Promise.race([
    started,
    exited.then(() => {
      throw new Error("k6 exited before fixture setup completed");
    }),
    new Promise((_, reject) => {
      startTimeout = setTimeout(
        () => reject(new Error("k6 fixture setup exceeded 60s")),
        60_000,
      );
    }),
  ]);
  clearTimeout(startTimeout);
  await pause(Math.max(0, report.startedAt + 20_000 - Date.now()));
  if (interrupted || child.exitCode !== null || child.signalCode !== null)
    throw new Error("k6 stopped before the scheduled restart");
  report.restartRequestedAt = Date.now();
  console.log(`Requesting Fastify ${plan.action}; k6 traffic continues.`);
  if (plan.action === "restart")
    await kube("rollout", "restart", "deployment/redirect-service");
  else if (plan.action === "application-roles") {
    const prepared = await execute(
      "node",
      ["scripts/prepare-application-roles.mjs", "rollout", plan.revision],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(`${runDir}/application-roles.log`, prepared.stdout);
    process.stdout.write(prepared.stdout);
  } else if (plan.action === "ha-target") {
    const prepared = await execute(
      "node",
      ["scripts/prepare-ha-target.mjs", "rollout"],
      { timeout: 150000, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(`${runDir}/ha-target.log`, prepared.stdout);
    process.stdout.write(prepared.stdout);
  } else {
    const released = await execute(
      "node",
      [
        "scripts/release-redirect.mjs",
        plan.action,
        plan.revision,
        "--runtime-control",
      ],
      { timeout: 150000, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(`${runDir}/release.log`, released.stdout);
    process.stdout.write(released.stdout);
  }
  console.log(
    await kube(
      "rollout",
      "status",
      "deployment/redirect-service",
      "--timeout=120s",
    ),
  );
  report.rolloutCompletedAt = Date.now();
  const after = await snapshot();
  report.replacementPods = after.pods
    .filter((pod) => !pod.terminating && pod.ready)
    .map((pod) => pod.name);
  if (
    report.replacementPods.length !== 2 ||
    report.replacementPods.some((pod) => report.originalPods.includes(pod))
  ) {
    throw new Error("Rollout did not replace both original pods");
  }
  if (plan.action !== "restart") {
    const result = JSON.parse(
      (
        await execute("node", ["scripts/runtime-maintenance.mjs", "status"], {
          timeout: 15000,
        })
      ).stdout,
    );
    if (["ha-target", "application-roles"].includes(plan.action))
      assertSourceStatus(result, true);
    else assertSourceConfiguration(result.desired);
    report.runtimeStatus = result.pods.filter((pod) =>
      report.replacementPods.includes(pod.pod),
    );
    assertSourcePods(report.runtimeStatus);
  }
  report.rolloutWithinWindow =
    report.rolloutCompletedAt < report.startedAt + 60_000;
  report.k6Exit = await exited;
  if (report.k6Exit.code !== 0)
    throw new Error("k6 failed; inspect thresholds");
  if (acknowledgementError)
    throw new Error("Creation acknowledgement journal was malformed");
  const summary = JSON.parse(await readFile(`${runDir}/summary.json`, "utf8"));
  const completedCreations =
    summary.metrics["iterations{scenario:creations}"]?.count ?? 0;
  if (acknowledged.length !== completedCreations)
    throw new Error(
      "Creation acknowledgement count differs from completed iterations",
    );
  if (acknowledged.length) {
    const expected = JSON.stringify(acknowledged).replaceAll("'", "''");
    const sql = `SELECT count(*)::int FROM jsonb_to_recordset('${expected}'::jsonb) AS e(code text, "targetUrl" text) JOIN public.links l ON l.code=e.code AND l.target_url=e."targetUrl";`;
    const stored = await new Promise((resolve, reject) => {
      const check = spawn("kubectl", [
        ...kubeArgs,
        "exec",
        "-i",
        "deployment/postgres",
        "--",
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "shortener",
        "-d",
        "shortener",
      ]);
      let output = "";
      check.stderr.resume();
      check.stdin.on("error", reject);
      check.stdout.on("data", (chunk) => {
        output += chunk;
      });
      check.once("error", reject);
      check.once("close", (code) =>
        code === 0
          ? resolve(Number(output.trim()))
          : reject(new Error("Source cohort verification failed")),
      );
      check.stdin.end(`SET statement_timeout=5000; ${sql}`);
    });
    report.storedAcknowledgedCreations = stored;
    if (stored !== acknowledged.length)
      throw new Error(
        "An acknowledged creation is missing or has a different destination in source Postgres",
      );
  }
  if (!report.rolloutWithinWindow)
    throw new Error("Rollout exceeded the 40-second restart window");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  clearTimeout(startTimeout);
  if (child.exitCode === null && child.signalCode === null) {
    if (nativeRunner) child.kill("SIGINT");
    else
      await execute("docker", ["kill", "--signal=SIGINT", containerName]).catch(
        () => {},
      );
    // Give k6 time to export summaries before resorting to forced cleanup.
    let stopTimer;
    await Promise.race([
      exited.catch(() => {}),
      new Promise((resolve) => {
        stopTimer = setTimeout(resolve, 10000);
      }),
    ]);
    clearTimeout(stopTimer);
    if (child.exitCode === null && child.signalCode === null) {
      if (nativeRunner) child.kill("SIGKILL");
      else await execute("docker", ["rm", "-f", containerName]).catch(() => {});
    }
  }
  report.k6Exit = await exited.catch((error) => ({ error: error.message }));
  monitoring = false;
  await monitor;
  await snapshot().catch((error) => {
    report.diagnosticsError = error.message;
  });
  timeline.end();
  for (const follower of followers) follower.kill("SIGTERM");
  log.end();
  report.acknowledgedCreationCount = acknowledged.length;
  report.acknowledgementJournalError = Boolean(acknowledgementError);
  await writeFile(
    `${runDir}/acknowledged-creations.json`,
    `${JSON.stringify(acknowledged, null, 2)}\n`,
  );
  report.finishedAt = Date.now();
  report.warningLines = warningLines;
  report.minSampledAvailable = Math.min(
    ...samples.map((sample) => sample.availableReplicas),
  );
  report.maxSampledPods = Math.max(
    ...samples.map((sample) => sample.pods.length),
  );
  report.minSampledReadyEndpoints = Math.min(
    ...samples.map(
      (sample) => sample.endpoints.filter((endpoint) => endpoint.ready).length,
    ),
  );
  if (report.minSampledAvailable < 2) {
    report.passed = false;
    report.error ??=
      "Sampled Deployment availability dropped below two replicas";
    process.exitCode = 1;
  }
  await writeFile(
    `${runDir}/events.txt`,
    await kube("get", "events", "--sort-by=.lastTimestamp").catch(
      (error) => error.message,
    ),
  );
  const url = new URL(
    "http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview",
  );
  url.searchParams.set("from", String(report.createdAt - 10_000));
  url.searchParams.set("to", String(report.finishedAt + 10_000));
  url.searchParams.set("var-pod", "$__all");
  report.dashboardUrl = url.href;
  await writeFile(`${runDir}/run.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    ".kind/rolling-restart/last-run.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  try {
    const summary = JSON.parse(
      await readFile(`${runDir}/summary.json`, "utf8"),
    );
    console.log("Redirect metrics:", summary.metrics.redirect_correct);
    if (createRate > 0) {
      console.log("Creation metrics:", summary.metrics.link_creation_correct);
    }
  } catch {
    console.error("No k6 summary was produced; inspect k6.log.");
  }
  console.log(`Recorded dashboard: ${report.dashboardUrl}`);
  if (warningLines > 5)
    console.log("Full k6 warnings are preserved in k6.log.");
  console.log(`Result: ${report.passed ? "PASS" : "FAIL"}`);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
