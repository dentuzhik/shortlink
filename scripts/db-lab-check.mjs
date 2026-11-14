import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
const directory = resolve(
  ".kind/db-cluster/checks",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
const requireApp = createRequire(
  new URL("../apps/redirect-service/package.json", import.meta.url),
);
const { Client } = requireApp("pg");
const report = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: {},
};
let forward;
let forwardClosed;
let client;

function run(command, args, input) {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // Never include secret-bearing stdout in an error or report.
        if (error)
          reject(
            new Error(
              `${command} failed (${error.code}); inspect the selected lab context`,
            ),
          );
        else resolveOutput(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const kube = (args, input) => run("kubectl", [...ns, ...args], input);
const get = async (args) => JSON.parse(await kube([...args, "-o", "json"]));
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function sql(pod, query) {
  const text = await kube(
    [
      "exec",
      "-i",
      pod,
      "--",
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
    `SET statement_timeout='5s';\n${query}\n`,
  );
  return JSON.parse(text);
}
async function startForward() {
  forward = spawn(
    "kubectl",
    [
      ...ns,
      "port-forward",
      "--address=127.0.0.1",
      "service/shortlink-lab-rw",
      ":5432",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  forwardClosed = new Promise((resolveClosed) =>
    forward.once("close", resolveClosed),
  );
  forward.stderr.resume();
  return new Promise((resolvePort, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Database port-forward did not become ready")),
      10000,
    );
    forward.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    forward.once("close", () => {
      clearTimeout(timeout);
      reject(new Error("Database port-forward exited"));
    });
    let output = "";
    forward.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
  });
}
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  const versions = JSON.parse(
    await readFile("deploy/db-lab/versions.json", "utf8"),
  );
  const nodes = JSON.parse(
    await run("kubectl", [...target, "get", "nodes", "-o", "json"]),
  ).items;
  ensure(
    nodes.length === 4 &&
      nodes.every(
        (node) =>
          node.status.nodeInfo.kubeletVersion === versions.kubernetesVersion &&
          node.status.nodeInfo.architecture === "arm64",
      ),
    "Unexpected database node versions or architectures",
  );
  const operator = JSON.parse(
    await run("kubectl", [
      ...target,
      "--namespace",
      "cnpg-system",
      "get",
      "deployment",
      "cnpg-controller-manager",
      "-o",
      "json",
    ]),
  );
  ensure(
    operator.status.availableReplicas === 1 &&
      operator.spec.template.spec.containers[0].image ===
        versions.operatorImage,
    "Unexpected operator image or readiness",
  );
  report.versions = versions;
  report.checks.pinnedVersions = true;
  const cluster = await get(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3 && cluster.status.instances === 3,
    "Expected three ready database instances",
  );
  ensure(
    cluster.spec.postgresql.synchronous.method === "any" &&
      cluster.spec.postgresql.synchronous.number === 1 &&
      cluster.spec.postgresql.synchronous.dataDurability === "required",
    "Unexpected synchronous replication policy",
  );
  const primary = cluster.status.currentPrimary;
  const pods = (
    await get([
      "get",
      "pods",
      "-l",
      "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
    ])
  ).items;
  ensure(pods.length === 3, "Expected three instance pods");
  ensure(
    new Set(pods.map((p) => p.spec.nodeName)).size === 3,
    "Database instances share a worker",
  );
  ensure(
    pods.every((p) => !p.spec.nodeName.endsWith("control-plane")),
    "A database instance is on the control plane",
  );
  report.instances = pods.map((p) => ({
    name: p.metadata.name,
    node: p.spec.nodeName,
    ready: p.status.containerStatuses.every((c) => c.ready),
    image: p.spec.containers.find((c) => c.name === "postgres").image,
    restarts: p.status.containerStatuses.reduce(
      (n, c) => n + c.restartCount,
      0,
    ),
  }));
  ensure(
    report.instances.every(
      (pod) => pod.ready && pod.image === versions.postgresImage,
    ),
    "Unexpected database image or pod readiness",
  );
  report.primary = primary;
  report.policy = cluster.spec.postgresql.synchronous;
  report.checks.replicaPlacement = true;
  const { items: claims } = await get([
    "get",
    "pvc",
    "-l",
    "cnpg.io/cluster=shortlink-lab",
  ]);
  ensure(
    claims.length === 3 && claims.every((p) => p.status.phase === "Bound"),
    "Expected three bound database volumes",
  );
  ensure(
    new Set(claims.map((p) => p.spec.volumeName)).size === 3,
    "Database instances share a volume",
  );
  report.volumes = claims.map((p) => ({
    name: p.metadata.name,
    volume: p.spec.volumeName,
    capacity: p.status.capacity.storage,
  }));
  report.checks.independentVolumes = true;

  const port = await startForward();
  // Read only this disposable lab's app password and public CA into memory.
  // Neither the Secret objects nor decoded credentials are written to artifacts.
  const appSecret = await get(["get", "secret", "shortlink-lab-app"]);
  const caSecret = await get(["get", "secret", "shortlink-lab-ca"]);
  const decode = (key) => Buffer.from(appSecret.data[key], "base64").toString();
  ensure(
    decode("username") === "shortlink_lab" &&
      decode("dbname") === "shortlink_lab",
    "Unexpected application role/database",
  );
  client = new Client({
    host: "127.0.0.1",
    port,
    user: decode("username"),
    password: decode("password"),
    database: decode("dbname"),
    connectionTimeoutMillis: 5000,
    ssl: {
      ca: Buffer.from(caSecret.data["ca.crt"], "base64").toString(),
      rejectUnauthorized: true,
      servername: "shortlink-lab-rw.database-lab.svc",
    },
    options: "-c statement_timeout=5000",
  });
  await client.connect();
  const {
    rows: [session],
  } = await client.query(
    "SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser, pg_is_in_recovery() AS recovery, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, current_setting('synchronous_commit') AS commit_policy, current_setting('synchronous_standby_names') AS standby_policy",
  );
  ensure(
    session.tls &&
      !session.recovery &&
      session.role === "shortlink_lab" &&
      !session.superuser &&
      session.commit_policy === "on" &&
      session.standby_policy.startsWith("ANY 1"),
    "Primary session is not TLS-protected with the expected commit policy",
  );
  report.session = session;
  report.checks.tlsAndApplicationRole = true;
  const token = `db-lab-${randomUUID()}`;
  const started = performance.now();
  const {
    rows: [written],
  } = await client.query(
    "INSERT INTO replication_probe(token) VALUES($1) RETURNING id::text",
    [token],
  );
  report.writeMs = performance.now() - started;
  const {
    rows: [position],
  } = await client.query("SELECT pg_current_wal_lsn()::text AS lsn");
  ensure(
    /^[0-9A-F]+\/[0-9A-F]+$/i.test(position.lsn),
    "Unexpected WAL position",
  );
  report.probe = { token, id: written.id, barrierLsn: position.lsn };
  const standbys = pods
    .filter((p) => p.metadata.name !== primary)
    .map((p) => p.metadata.name);
  const replicaQuery = `SELECT json_build_object('recovery',pg_is_in_recovery(), 'probe_present',EXISTS(SELECT 1 FROM replication_probe WHERE token='${token}'), 'replayed',pg_last_wal_replay_lsn() >= '${position.lsn}'::pg_lsn, 'replay_lsn',pg_last_wal_replay_lsn()::text);`;
  let observations;
  for (let i = 0; i < 30; i++) {
    observations = await Promise.all(
      standbys.map(async (pod) => ({ pod, ...(await sql(pod, replicaQuery)) })),
    );
    if (observations.every((r) => r.recovery && r.probe_present && r.replayed))
      break;
    await delay(250);
  }
  ensure(
    observations.every((r) => r.recovery && r.probe_present && r.replayed),
    "Both standbys did not replay the acknowledged probe",
  );
  report.standbys = observations;
  const replication = await sql(
    primary,
    "SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT application_name,state,sync_state,flush_lsn::text,replay_lsn::text FROM pg_stat_replication ORDER BY application_name) x;",
  );
  ensure(
    replication.length === 2 &&
      replication.every((r) => r.state === "streaming") &&
      replication.some((r) => ["quorum", "sync"].includes(r.sync_state)),
    "Expected two streaming standbys and an eligible synchronous confirmation",
  );
  report.replication = replication;
  report.checks.synchronousWriteAndStandbyReplay = true;
  report.functionalPassed = true;

  const host = await run("sysctl", [
    "-n",
    "kern.memorystatus_vm_pressure_level",
  ]);
  const guest = await run("colima", [
    "-p",
    "shortlink-db",
    "ssh",
    "--",
    "cat",
    "/proc/meminfo",
  ]);
  const values = Object.fromEntries(
    [...guest.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)/gm)].map((m) => [
      m[1],
      Number(m[2]) * 1024,
    ]),
  );
  report.resources = {
    hostPressureLevel: Number(host.trim()),
    ...values,
    availableFraction: values.MemAvailable / values.MemTotal,
    swap: (await run("sysctl", ["vm.swapusage"])).trim(),
  };
  report.resourceGatePassed =
    report.resources.hostPressureLevel === 1 &&
    report.resources.availableFraction >= 0.2;
  ensure(
    report.resourceGatePassed,
    "Functional checks passed, but the host/guest resource gate failed",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    await client?.end();
  } catch {
    report.passed = false;
    process.exitCode = 1;
  }
  if (forward) {
    forward.kill("SIGTERM");
    await forwardClosed;
  }
  report.completedAt = new Date().toISOString();
  await writeFile(
    resolve(directory, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  assert(
    !client ||
      !forward ||
      forward.exitCode !== null ||
      forward.signalCode !== null,
  );
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        functionalPassed: report.functionalPassed,
        resourceGatePassed: report.resourceGatePassed,
        checks: report.checks,
        resources: report.resources,
        error: report.error,
        directory,
      },
      null,
      2,
    ),
  );
}
