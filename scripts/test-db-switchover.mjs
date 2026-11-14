import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.umask(0o077);
const target = [
  "--kubeconfig",
  ".kind/db-cluster/kubeconfig",
  "--context",
  "kind-shortlink-db",
];
const ns = [...target, "--namespace", "database-lab"];
const runId = randomUUID();
const name = `db-switch-${runId.slice(0, 8)}`;
const directory = resolve(
  ".kind/db-cluster/switchovers",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
const report = {
  passed: false,
  runId,
  startedAt: new Date().toISOString(),
  directory,
};
const timeline = [];
let created = false;
let observer;
let stopObserver = false;
let pods;
let promotionAt;
function run(command, args, input, timeout = 30000) {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      command,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error(`${command} failed (${error.code})`));
        else resolveOutput(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const kube = (args, input, timeout) =>
  run("kubectl", [...ns, ...args], input, timeout);
const get = async (args) => JSON.parse(await kube([...args, "-o", "json"]));
const save = async (name, data) =>
  writeFile(resolve(directory, name), `${JSON.stringify(data, null, 2)}\n`);
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function sql(pod, query) {
  return JSON.parse(
    await kube(
      [
        "exec",
        "-i",
        pod,
        "--",
        "env",
        "PGCONNECT_TIMEOUT=1",
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "shortlink_lab",
      ],
      `SET statement_timeout='1s';\n${query}\n`,
    ),
  );
}
async function observe() {
  const row = { time: new Date().toISOString() };
  try {
    const cluster = await get(["get", "cluster", "shortlink-lab"]);
    row.cluster = {
      primary: cluster.status.currentPrimary,
      target: cluster.status.targetPrimary,
      phase: cluster.status.phase,
      ready: cluster.status.readyInstances,
    };
    const slices = (
      await get([
        "get",
        "endpointslices",
        "-l",
        "kubernetes.io/service-name=shortlink-lab-rw",
      ])
    ).items;
    row.endpoints = slices.flatMap((s) =>
      (s.endpoints ?? []).map((e) => ({
        pod: e.targetRef?.name,
        ready: e.conditions.ready,
        addresses: e.addresses,
      })),
    );
    row.roles = await Promise.all(
      pods.map(async (p) => {
        try {
          return {
            pod: p.metadata.name,
            ...(await sql(
              p.metadata.name,
              "SELECT json_build_object('recovery',pg_is_in_recovery(),'read_only',current_setting('transaction_read_only'));",
            )),
          };
        } catch {
          return { pod: p.metadata.name, unavailable: true };
        }
      }),
    );
    row.hostPressure = Number(
      (
        await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
      ).trim(),
    );
    row.swap = (await run("sysctl", ["vm.swapusage"])).trim();
    row.source = [];
    for (const [host, path] of [
      ["go.localhost", "/healthz"],
      ["go.localhost", "/readyz"],
      ["app.localhost", "/"],
    ]) {
      const status = await run("curl", [
        "--silent",
        "--show-error",
        "--max-time",
        "3",
        "--resolve",
        `${host}:8080:127.0.0.1`,
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        `http://${host}:8080${path}`,
      ]);
      row.source.push({ host, path, status });
    }
  } catch (error) {
    row.observationError = error.message;
  }
  timeline.push(row);
  await save("timeline.json", timeline);
  return row;
}
async function logs() {
  const text = await kube(["logs", name]);
  await writeFile(resolve(directory, "probe.ndjson"), text);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function stats(events, role, oldIp, newIp) {
  const operations = events.filter(
    (e) => e.type === "operation" && e.role === role,
  );
  const successes = operations.filter((e) => e.status === "ok");
  const failures = operations.filter((e) => e.status !== "ok");
  const firstNew = successes.find((e) => e.server?.split("/")[0] === newIp);
  const lastOld = successes
    .filter(
      (e) =>
        e.server?.split("/")[0] === oldIp &&
        (!firstNew || e.elapsedMs <= firstNew.elapsedMs),
    )
    .at(-1);
  const maxGap = Math.max(
    0,
    ...successes.slice(1).map((e, i) => e.elapsedMs - successes[i].elapsedMs),
  );
  return {
    attempts: operations.length,
    successful: successes.length,
    failed: failures.length,
    errorCodes: Object.fromEntries(
      [...new Set(failures.map((e) => e.code))].map((code) => [
        code,
        failures.filter((e) => e.code === code).length,
      ]),
    ),
    maxSuccessGapMs: maxGap,
    lastOldToFirstNewSuccessMs:
      firstNew && lastOld ? firstNew.elapsedMs - lastOld.elapsedMs : null,
    successesOnNewPrimary: successes.filter(
      (e) => e.server?.split("/")[0] === newIp,
    ).length,
  };
}
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  const versions = JSON.parse(
    await readFile("deploy/db-lab/versions.json", "utf8"),
  );
  report.sourceCommit = (await run("git", ["rev-parse", "HEAD"])).trim();
  report.goal =
    "Data-preserving planned switchover with measured interruption; not a zero-error availability SLO";
  report.workload = {
    durationMs: 60000,
    baselineMs: 10000,
    pacingMs: 100,
    writerLoops: 1,
    readerLoops: 1,
    retainedConnections: true,
    automaticWriteRetries: false,
  };
  report.clientImage = versions.switchoverProbeImage;
  const cluster = await get(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3 &&
      cluster.status.currentPrimary === cluster.status.targetPrimary,
    "Expected a stable three-instance lab",
  );
  ensure(
    cluster.spec.postgresql.synchronous.dataDurability === "required" &&
      cluster.spec.postgresql.synchronous.number === 1,
    "Unexpected durability policy",
  );
  pods = (
    await get([
      "get",
      "pods",
      "-l",
      "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
    ])
  ).items;
  ensure(
    pods.length === 3 &&
      pods.every((p) => p.status.containerStatuses.every((c) => c.ready)),
    "Instance pods are not all ready",
  );
  report.oldPrimary = cluster.status.currentPrimary;
  report.newPrimary = pods
    .map((p) => p.metadata.name)
    .sort()
    .find((p) => p !== report.oldPrimary);
  report.podsBefore = pods.map((p) => ({
    name: p.metadata.name,
    uid: p.metadata.uid,
    ip: p.status.podIP,
    node: p.spec.nodeName,
  }));
  report.initialPolicy = {
    switchoverDelay: cluster.spec.switchoverDelay,
    smartShutdownTimeout: cluster.spec.smartShutdownTimeout,
    synchronous: cluster.spec.postgresql.synchronous,
  };
  const preflight = await observe();
  ensure(
    preflight.hostPressure === 1 &&
      preflight.source.every((r) => r.status === "200"),
    "Source/host preflight failed",
  );
  ensure(
    preflight.roles.filter((r) => r.recovery === false).length === 1,
    "Expected one writable primary",
  );
  await mkdir(".kind/db-cluster/tools", { recursive: true });
  const archive = resolve(".kind/db-cluster/tools/kubectl-cnpg.tar.gz");
  await run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    versions.cnpgPluginUrl,
    "--output",
    archive,
  ]);
  ensure(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") === versions.cnpgPluginSha256,
    "CNPG plugin checksum mismatch",
  );
  await run("tar", [
    "-xzf",
    archive,
    "-C",
    ".kind/db-cluster/tools",
    "kubectl-cnpg",
  ]);
  const plugin = resolve(".kind/db-cluster/tools/kubectl-cnpg");
  await chmod(plugin, 0o700);
  const labels = { "shortlink.dev/switchover-run": runId };
  const config = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: "database-lab", labels },
    data: { "probe.cjs": await readFile("scripts/db-lab-probe.cjs", "utf8") },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "database-lab", labels },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      activeDeadlineSeconds: 150,
      terminationGracePeriodSeconds: 5,
      nodeSelector: { "shortlink.dev/workload": "database" },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: versions.switchoverProbeImage,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "--max-old-space-size=64", "/exercise/probe.cjs"],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "25m", memory: "64Mi" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
          env: [
            { name: "PROBE_RUN", value: runId },
            { name: "PROBE_DURATION_MS", value: "60000" },
            { name: "PGHOST", value: "shortlink-lab-rw.database-lab.svc" },
            ...[
              ["PGUSER", "username"],
              ["PGPASSWORD", "password"],
              ["PGDATABASE", "dbname"],
            ].map(([name, key]) => ({
              name,
              valueFrom: { secretKeyRef: { name: "shortlink-lab-app", key } },
            })),
          ],
          volumeMounts: [
            { name: "code", mountPath: "/exercise", readOnly: true },
            { name: "ca", mountPath: "/exercise-ca", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "code", configMap: { name } },
        {
          name: "ca",
          secret: {
            secretName: "shortlink-lab-ca",
            items: [{ key: "ca.crt", path: "ca.crt" }],
          },
        },
      ],
    },
  };
  created = true;
  await kube(
    ["apply", "-f", "-"],
    JSON.stringify({ apiVersion: "v1", kind: "List", items: [config, pod] }),
  );
  console.log(
    "Probe Pod starting; the live application database is unchanged.",
  );
  observer = (async () => {
    while (!stopObserver) {
      await observe();
      await delay(1000);
    }
  })();
  await kube(
    ["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=90s"],
    undefined,
    100000,
  );
  const baselineDeadline = Date.now() + 20000;
  let events;
  while (Date.now() < baselineDeadline) {
    events = await logs();
    const ready = events.find((e) => e.type === "ready");
    if (
      ready &&
      events.at(-1).elapsedMs - ready.elapsedMs >= 10000 &&
      events.filter(
        (e) =>
          e.type === "operation" && e.role === "writer" && e.status === "ok",
      ).length >= 50
    )
      break;
    await delay(500);
  }
  ensure(
    events.some(
      (e) =>
        e.type === "ready" && events.at(-1).elapsedMs - e.elapsedMs >= 10000,
    ) &&
      events.filter(
        (e) =>
          e.type === "operation" && e.role === "writer" && e.status === "ok",
      ).length >= 50,
    "Probe did not establish a healthy baseline",
  );
  ensure(
    !events.some(
      (e) =>
        e.type === "fatal" || (e.type === "operation" && e.status !== "ok"),
    ),
    "Probe baseline contained errors; no promotion requested",
  );
  ensure(
    timeline.at(-1).hostPressure === 1 &&
      timeline.at(-1).source.every((r) => r.status === "200"),
    "Resource/source gate failed before promotion",
  );
  promotionAt = new Date().toISOString();
  report.promotionRequestedAt = promotionAt;
  console.log(
    `Requesting a planned switchover: ${report.oldPrimary} -> ${report.newPrimary}`,
  );
  report.promotionCommandOutput = (
    await run(plugin, [...ns, "promote", "shortlink-lab", report.newPrimary])
  ).trim();
  await kube(
    [
      "wait",
      "--for=jsonpath={.status.phase}=Succeeded",
      `pod/${name}`,
      "--timeout=80s",
    ],
    undefined,
    90000,
  );
  events = await logs();
  ensure(
    events.some((e) => e.type === "finished") &&
      !events.some((e) => e.type === "fatal"),
    "Probe did not finish cleanly",
  );
  await kube(
    ["wait", "--for=condition=Ready", "cluster/shortlink-lab", "--timeout=60s"],
    undefined,
    70000,
  );
  const final = await get(["get", "cluster", "shortlink-lab"]);
  ensure(
    final.status.currentPrimary === report.newPrimary &&
      final.status.readyInstances === 3,
    "Requested primary did not become healthy",
  );
  const roles = await Promise.all(
    pods.map(async (p) => ({
      pod: p.metadata.name,
      ...(await sql(
        p.metadata.name,
        "SELECT json_build_object('recovery',pg_is_in_recovery(),'read_only',current_setting('transaction_read_only'));",
      )),
    })),
  );
  ensure(
    roles.filter((r) => r.recovery === false).length === 1 &&
      roles.find((r) => r.pod === report.oldPrimary).recovery === true,
    "Former primary did not rejoin as a standby",
  );
  report.finalRoles = roles;
  const stored = await sql(
    report.newPrimary,
    `SELECT coalesce(json_agg(token ORDER BY token),'[]'::json) FROM replication_probe WHERE token LIKE '${runId}:%';`,
  );
  const writes = events.filter(
    (e) => e.type === "operation" && e.role === "writer",
  );
  const ack = writes.filter((e) => e.status === "ok");
  const ambiguous = writes.filter((e) => e.status === "ambiguous");
  const persisted = new Set(stored);
  const expectedTokens = new Set(
    writes.filter((e) => e.status !== "not_sent").map((e) => e.token),
  );
  report.data = {
    attempted: writes.length,
    acknowledged: ack.length,
    missingAcknowledged: ack
      .filter((e) => !persisted.has(e.token))
      .map((e) => e.token),
    ambiguous: ambiguous.length,
    ambiguousPresent: ambiguous.filter((e) => persisted.has(e.token)).length,
    ambiguousAbsent: ambiguous.filter((e) => !persisted.has(e.token)).length,
    notSent: writes.filter((e) => e.status === "not_sent").length,
    persisted: stored.length,
    unknownPersistedTokens: stored.filter(
      (token) => !expectedTokens.has(token),
    ),
  };
  ensure(
    report.data.missingAcknowledged.length === 0 &&
      report.data.unknownPersistedTokens.length === 0 &&
      stored.length === persisted.size,
    "Write ledger verification failed",
  );
  const oldIp = report.podsBefore.find((p) => p.name === report.oldPrimary).ip;
  const newIp = report.podsBefore.find((p) => p.name === report.newPrimary).ip;
  report.writer = stats(events, "writer", oldIp, newIp);
  report.reader = stats(events, "reader", oldIp, newIp);
  report.connections = Object.fromEntries(
    ["writer", "reader"].map((role) => [
      role,
      {
        connected: events.filter(
          (e) =>
            e.type === "connection" &&
            e.role === role &&
            e.event === "connected",
        ).length,
        errors: events.filter(
          (e) =>
            e.type === "connection" && e.role === role && e.event === "error",
        ).length,
      },
    ]),
  );
  ensure(
    report.writer.successesOnNewPrimary >= 20 &&
      report.reader.successesOnNewPrimary >= 20,
    "Insufficient successful reads/writes after promotion",
  );
  const last = await observe();
  ensure(
    timeline.every(
      (s) =>
        !s.roles || s.roles.filter((r) => r.recovery === false).length <= 1,
    ),
    "Role samples observed more than one primary",
  );
  ensure(
    timeline.every((s) => s.source?.every((r) => r.status === "200")) &&
      timeline.every((s) => s.hostPressure === 1),
    "Source availability or host-pressure observations failed",
  );
  ensure(
    last.endpoints.filter((e) => e.ready).length === 1 &&
      last.endpoints
        .filter((e) => e.ready)
        .every((e) => e.pod === report.newPrimary),
    "Primary Service does not target the promoted instance",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  stopObserver = true;
  await observer;
  report.completedAt = new Date().toISOString();
  try {
    if (created) {
      try {
        await logs();
      } catch (error) {
        report.logCaptureError = error.message;
      }
      await kube([
        "delete",
        "pod,configmap",
        "-l",
        `shortlink.dev/switchover-run=${runId}`,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=30s",
      ]);
    }
    report.cleanupPassed = true;
  } catch (error) {
    report.cleanupPassed = false;
    report.cleanupError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  await save("result.json", report);
  await save("timeline.json", timeline);
  console.log(JSON.stringify(report, null, 2));
}
