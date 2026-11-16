import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { checkServerIdentity } from "node:tls";
import {
  appGet,
  appKube,
  dbGet,
  directory,
  ensure,
  hash,
  run,
  sourceState,
} from "./lib/db-lab-connectivity.mjs";
import { sequenceRepair } from "./lib/db-restore.mjs";
import { assertSourceStatus } from "./lib/ha-target.mjs";
import {
  acknowledged,
  assertFixture,
  assertResourceBudget,
  assertSwitchGates,
  fenceSql,
  fixtureNamespace,
} from "./lib/handoff.mjs";
import {
  targetSql as liveHaSql,
  state as liveReplication,
  sourceSql as liveSourceSql,
} from "./lib/live-replication.mjs";
import { verifyPrivileges } from "./source-role-probe.cjs";

ensure(
  process.argv.length === 2,
  "Use rehearse-handoff.mjs with no arguments; only disposable targets are supported",
);
process.env.DOCKER_CONTEXT = "colima";
const runId = randomBytes(8).toString("hex");
const namespace = fixtureNamespace(runId);
const path = await directory("handoff-rehearsals");
const labels = { "shortlink.dev/handoff-run": runId };
const report = {
  startedAt: new Date().toISOString(),
  runId,
  namespace,
  passed: false,
  timeline: [],
  checks: {},
};
const save = (name, value) =>
  writeFile(`${path}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
const event = async (phase) => {
  report.phase = phase;
  report.timeline.push({ phase, at: Date.now() });
  await save("timeline.json", report.timeline);
  console.log(phase);
};
const kube = (args, input, timeout) =>
  appKube(["--namespace", namespace, ...args], input, timeout);
const get = async (args) => JSON.parse(await kube([...args, "-o", "json"]));
const docker = (args, input, timeout) =>
  run("docker", ["--context", "colima", ...args], input, timeout);
const create = (object) =>
  kube(
    ["create", "-f", "-"],
    JSON.stringify({
      ...object,
      metadata: {
        ...object.metadata,
        namespace,
        labels: { ...labels, ...object.metadata?.labels },
      },
    }),
  );
const sql = (side, text) =>
  kube(
    [
      "exec",
      "-i",
      `deployment/handoff-${side}`,
      "-c",
      "postgres",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "fixture_admin",
      "-d",
      "shortener",
      ...(side === "target" ? ["-h", "/tmp"] : []),
    ],
    `SET statement_timeout='8s'; SET lock_timeout='2s';\n${text}`,
  );
const require = createRequire(
  new URL("../apps/redirect-service/package.json", import.meta.url),
);
const { Client } = require("pg");
let created = false;
const forwards = [];
let rogue;
let fixturePods = [];
let desired = {
  revision: 1,
  creationMode: "accept",
  activeDatabase: "source",
  prepareDatabase: "ha",
};
let interrupted = false;
let stopMonitor = false;
let monitoring;
let monitorError;
async function resourceSnapshot() {
  const hostPressure = Number(
    (await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim(),
  );
  const guest = await run("colima", [
    "-p",
    "default",
    "ssh",
    "--",
    "sh",
    "-c",
    "cat /proc/meminfo; cat /proc/pressure/memory",
  ]);
  const guestAvailableMiB =
    Number(guest.match(/^MemAvailable:\s+(\d+)/m)?.[1]) / 1024;
  const guestFullAvg10 = Number(guest.match(/^full avg10=(\S+)/m)?.[1]);
  const state = { hostPressure, guestAvailableMiB, guestFullAvg10 };
  assertResourceBudget(state);
  return state;
}
report.liveSamples = [];
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });
async function waitFor(work, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (true) {
    ensure(!interrupted, "Handoff rehearsal interrupted");
    ensure(!monitorError, monitorError);
    if (await work()) return;
    ensure(Date.now() < deadline, message);
    await delay(200);
  }
}
async function liveState() {
  const runtime = JSON.parse(
    await run("node", ["scripts/runtime-maintenance.mjs", "status"]),
  );
  assertSourceStatus(runtime, true);
  return {
    application: await sourceState(),
    runtime,
    control: (await appGet(["get", "configmap", "shortlink-runtime"])).data,
    sourcePostgres: hash(
      (await appGet(["get", "deployment", "postgres"])).spec,
    ),
    cnpg: hash((await dbGet(["get", "cluster", "shortlink-lab"])).spec),
    haSequences: JSON.parse(
      await liveHaSql(
        "SELECT json_build_object('links',(SELECT last_value::text FROM links_id_seq),'linksCalled',(SELECT is_called FROM links_id_seq),'history',(SELECT last_value::text FROM drizzle.__drizzle_migrations_id_seq),'historyCalled',(SELECT is_called FROM drizzle.__drizzle_migrations_id_seq));",
      ),
    ),
    sourceRole: JSON.parse(
      await liveSourceSql(
        "SELECT json_build_object('role',rolname,'oid',oid,'superuser',rolsuper) FROM pg_roles WHERE rolname=current_user;",
      ),
    ),
    replication: await liveReplication(),
  };
}
async function statuses() {
  const pods = (await get(["get", "pods", "-l", "app=handoff-api"])).items;
  return Promise.all(
    pods.map(async (pod) => {
      try {
        const value = JSON.parse(
          await kube([
            "get",
            "--raw",
            `/api/v1/namespaces/${namespace}/pods/http:${pod.metadata.name}:9090/proxy/internal/maintenance`,
          ]),
        );
        return {
          pod: pod.metadata.name,
          uid: pod.metadata.uid,
          terminating: Boolean(pod.metadata.deletionTimestamp),
          ...value,
        };
      } catch {
        return { pod: pod.metadata.name, unavailable: true };
      }
    }),
  );
}
async function control(change, active, applied = true) {
  const cm = await get(["get", "configmap", "shortlink-runtime"]);
  assert.deepEqual(
    JSON.parse(cm.data["control.json"]),
    desired,
    "Fixture control changed concurrently",
  );
  desired = { ...desired, ...change, revision: desired.revision + 1 };
  await kube(
    [
      "patch",
      "configmap",
      "shortlink-runtime",
      "--type=json",
      "--patch-file=/dev/stdin",
    ],
    JSON.stringify([
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: cm.metadata.resourceVersion,
      },
      {
        op: "replace",
        path: "/data/control.json",
        value: JSON.stringify(desired),
      },
    ]),
  );
  let current;
  await waitFor(async () => {
    current = await statuses();
    return acknowledged(
      current,
      desired,
      active ?? desired.activeDatabase,
      applied,
    );
  }, "Fixture replicas did not acknowledge control");
  report.timeline.push({
    phase: "control",
    at: Date.now(),
    desired: { ...desired },
    pods: current,
  });
  await save("timeline.json", report.timeline);
  return current;
}
function service(side) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: `handoff-${side}` },
    spec: {
      selector: { app: `handoff-${side}` },
      ports: [{ port: 5432, targetPort: 5432 }],
    },
  };
}
function postgres(side, image) {
  const target = side === "target";
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: `handoff-${side}` },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: `handoff-${side}` } },
      template: {
        metadata: { labels: { ...labels, app: `handoff-${side}` } },
        spec: {
          ...(target
            ? {
                securityContext: { runAsUser: 26, runAsGroup: 26, fsGroup: 26 },
              }
            : {}),
          automountServiceAccountToken: false,
          containers: [
            {
              name: "postgres",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["/bin/sh", "-c"],
              args: [
                target
                  ? "exec sh /exercise/target-init.sh"
                  : `cp /tls/server.key /tmp/fixture.key; chown postgres:postgres /tmp/fixture.key; chmod 600 /tmp/fixture.key; exec docker-entrypoint.sh postgres -c wal_level=logical -c max_wal_senders=5 -c max_replication_slots=5 -c shared_buffers=16MB -c max_connections=30 -c max_slot_wal_keep_size=64MB -c ssl=on -c ssl_cert_file=/tls/ca.crt -c ssl_key_file=/tmp/fixture.key -c hba_file=/exercise/source-hba.conf -c shortlink.handoff_fixture=${runId}`,
              ],
              env: target
                ? [{ name: "PGDATA", value: "/data/pgdata" }]
                : [
                    { name: "POSTGRES_USER", value: "fixture_admin" },
                    { name: "POSTGRES_DB", value: "shortener" },
                    {
                      name: "POSTGRES_PASSWORD",
                      valueFrom: {
                        secretKeyRef: {
                          name: "handoff-private",
                          key: "adminPassword",
                        },
                      },
                    },
                  ],
              ports: [{ containerPort: 5432 }],
              readinessProbe: {
                exec: {
                  command: [
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "fixture_admin",
                    "-d",
                    target ? "postgres" : "shortener",
                  ],
                },
                periodSeconds: 1,
              },
              resources: {
                requests: { cpu: "25m", memory: "64Mi" },
                limits: { cpu: "500m", memory: "128Mi" },
              },
              volumeMounts: [
                {
                  name: "data",
                  mountPath: target ? "/data" : "/var/lib/postgresql",
                },
                { name: "tls", mountPath: "/tls", readOnly: true },
                { name: "exercise", mountPath: "/exercise", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "data", emptyDir: { sizeLimit: "256Mi" } },
            {
              name: "tls",
              secret: {
                secretName: "handoff-private",
                items: [
                  { key: "ca.crt", path: "ca.crt" },
                  { key: "server.key", path: "server.key" },
                ],
              },
            },
            { name: "exercise", configMap: { name: "handoff-scripts" } },
          ],
        },
      },
    },
  };
}
const digest = `SET timezone='UTC'; SELECT json_build_object(
 'links',(SELECT coalesce(json_agg(x ORDER BY id),'[]'::json) FROM (SELECT * FROM public.links)x),
 'history',(SELECT coalesce(json_agg(x ORDER BY id),'[]'::json) FROM (SELECT * FROM drizzle.__drizzle_migrations)x),
 'barriers',(SELECT coalesce(json_agg(x ORDER BY token),'[]'::json) FROM public.handoff_barrier x));`;
const sequences =
  "SELECT json_build_object('links',(SELECT json_build_object('last_value',last_value::text,'is_called',is_called,'increment','1','max_id',(SELECT coalesce(max(id),0)::text FROM links)) FROM public.links_id_seq),'history',(SELECT json_build_object('last_value',last_value::text,'is_called',is_called,'increment','1','max_id',(SELECT coalesce(max(id),0)::text FROM drizzle.__drizzle_migrations)) FROM drizzle.__drizzle_migrations_id_seq));";
async function databasePort(side) {
  const forward = spawn(
    "kubectl",
    [
      "--kubeconfig",
      ".kind/kubeconfig",
      "--context",
      "kind-shortlink",
      "-n",
      namespace,
      "port-forward",
      `service/handoff-${side}`,
      ":5432",
      "--address=127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  forwards.push(forward);
  forward.stderr.resume();
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("Fixture source forward timed out")),
      10000,
    );
    forward.once("error", reject);
    forward.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Fixture source forward stopped"));
    });
    forward.stdout.on("data", (chunk) => {
      buffer += chunk;
      const port = buffer.match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) {
        clearTimeout(timer);
        resolvePort(Number(port));
      }
    });
  });
}
async function stageImage(upstream, side) {
  const alias = `shortlink-handoff-${runId}-${side}:fixture`;
  await docker(["pull", upstream], undefined, 120000);
  await docker(["tag", upstream, alias]);
  const architecture = (
    await appGet(["get", "node", "shortlink-control-plane"])
  ).status.nodeInfo.architecture;
  const archive = `${path}/${side}.tar`;
  try {
    await docker(
      [
        "image",
        "save",
        "--platform",
        `linux/${architecture}`,
        "--output",
        archive,
        alias,
      ],
      undefined,
      120000,
    );
    const [manifest] = JSON.parse(
      await run("tar", ["-xOf", archive, "manifest.json"]),
    );
    const nativeConfig = await run("tar", ["-xOf", archive, manifest.Config]);
    const configDigest = `sha256:${createHash("sha256").update(nativeConfig).digest("hex")}`;
    await run(
      "kind",
      ["load", "image-archive", "--name", "shortlink", archive],
      undefined,
      120000,
    );
    // Bind the published immutable reference in CRI as well as importing layers.
    // A local alias for an already cached image can be absent from kubelet's lookup.
    await docker(
      ["exec", "shortlink-control-plane", "crictl", "pull", upstream],
      undefined,
      120000,
    );
    const image = JSON.parse(
      await docker([
        "exec",
        "shortlink-control-plane",
        "crictl",
        "inspecti",
        upstream,
      ]),
    );
    assert.equal(
      image.status.id,
      configDigest,
      "The node's published fixture image differs from the native export",
    );
    report.stagedImages ??= [];
    report.stagedImages.push({ upstream, alias, architecture, configDigest });
  } finally {
    await rm(archive, { force: true });
  }
  return upstream;
}
try {
  report.liveBefore = await liveState();
  report.resourceBefore = await resourceSnapshot();
  await event("stage-images");
  const sourceUpstream = JSON.parse(
    await readFile("deploy/migration/rehearsal.json", "utf8"),
  ).publisherImage;
  const targetUpstream = JSON.parse(
    await readFile("deploy/db-lab/versions.json", "utf8"),
  ).postgresImage;
  const currentApiImage = (
    await appGet(["get", "deployment", "redirect-service"])
  ).spec.template.spec.containers.find((c) => c.name === "api").image;
  const apiImage = process.env.HANDOFF_API_IMAGE ?? currentApiImage;
  ensure(
    /^ghcr\.io\/dentuzhik\/shortlink-redirect:[a-f0-9]{40}@sha256:[a-f0-9]{64}$/.test(
      apiImage,
    ),
    "The handoff API image must be an immutable published project revision",
  );
  if (apiImage !== currentApiImage) {
    await run(
      "docker",
      [
        "--context",
        "colima",
        "exec",
        "shortlink-control-plane",
        "crictl",
        "pull",
        apiImage,
      ],
      undefined,
      180000,
    );
  }
  const images = {
    source: await stageImage(sourceUpstream, "source"),
    target: await stageImage(targetUpstream, "target"),
    k6: await stageImage(
      "grafana/k6@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8",
      "k6",
    ),
    api: apiImage,
  };
  report.images = { ...images, sourceUpstream, targetUpstream };
  report.resourceAfterStaging = await resourceSnapshot();
  await appKube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace, labels },
    }),
  );
  created = true;
  assertFixture(await appGet(["get", "namespace", namespace]), runId);
  monitoring = (async () => {
    while (!stopMonitor) {
      try {
        report.liveSamples.push({
          at: Date.now(),
          resources: await resourceSnapshot(),
          source: await sourceState(),
        });
      } catch {
        monitorError = "Live source health monitoring failed";
        return;
      }
      await delay(3000);
    }
  })();
  const sourceHost = `handoff-source.${namespace}.svc.cluster.local`;
  const targetHost = `handoff-target.${namespace}.svc.cluster.local`;
  await mkdir(`${path}/tls`, { mode: 0o700 });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-days",
    "2",
    "-subj",
    `/CN=${targetHost}`,
    "-addext",
    `subjectAltName=DNS:${targetHost},DNS:${sourceHost}`,
    "-keyout",
    `${path}/tls/server.key`,
    "-out",
    `${path}/tls/ca.crt`,
  ]);
  const sourcePassword = randomBytes(24).toString("hex"),
    targetPassword = randomBytes(24).toString("hex"),
    replicationPassword = randomBytes(24).toString("hex");
  const sourceUrl = `postgresql://shortlink_app:${sourcePassword}@${sourceHost}:5432/shortener?sslmode=verify-full&sslrootcert=/db-tls/ca.crt`;
  const targetUrl = `postgresql://shortlink_app:${targetPassword}@${targetHost}:5432/shortener`;
  await create({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "handoff-private" },
    type: "Opaque",
    stringData: {
      sourceUrl,
      targetUrl,
      adminPassword: randomBytes(24).toString("hex"),
      "ca.crt": await readFile(`${path}/tls/ca.crt`, "utf8"),
      "server.key": await readFile(`${path}/tls/server.key`, "utf8"),
    },
  });
  await create({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "handoff-scripts" },
    data: {
      "target-init.sh": await readFile(
        "deploy/migration/handoff/target-init.sh",
        "utf8",
      ),
      "source-hba.conf":
        "local all all trust\nhostssl shortener fixture_repl all scram-sha-256\nhostssl shortener shortlink_app all scram-sha-256\nhost all shortlink_app all reject\nhost all all all reject\n",
      "database-handoff.js": await readFile(
        "benchmarks/database-handoff.js",
        "utf8",
      ),
    },
  });
  await create(service("source"));
  await create(service("target"));
  await create(postgres("source", images.source));
  await create(postgres("target", images.target));
  for (const side of ["source", "target"])
    await kube(
      ["rollout", "status", `deployment/handoff-${side}`, "--timeout=90s"],
      undefined,
      95000,
    );
  await event("bootstrap-logical-replication");
  const schema = await appKube([
    "exec",
    "deployment/postgres",
    "--",
    "pg_dump",
    "-U",
    "shortener",
    "-d",
    "shortener",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--no-subscriptions",
    "--no-publications",
    "--lock-wait-timeout=2s",
  ]);
  await sql(
    "source",
    `CREATE ROLE shortener NOLOGIN NOSUPERUSER; ALTER DATABASE shortener OWNER TO shortener; SET ROLE shortener;\n${schema}\nCREATE TABLE public.handoff_barrier(token text PRIMARY KEY); RESET ROLE;
    INSERT INTO public.links(id,code,target_url) OVERRIDING SYSTEM VALUE VALUES(41,'seedA000','https://example.test/seed/0'),(42,'seedA001','https://example.test/seed/1');
    INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES(7,'handoff-fixture',1);
    SELECT setval('public.links_id_seq',1000,true); SELECT setval('drizzle.__drizzle_migrations_id_seq',2000,true);
    CREATE ROLE fixture_repl LOGIN REPLICATION NOSUPERUSER PASSWORD '${replicationPassword}'; GRANT CONNECT ON DATABASE shortener TO fixture_repl; GRANT USAGE ON SCHEMA public,drizzle TO fixture_repl; GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO fixture_repl;
    CREATE PUBLICATION handoff_publication FOR TABLE public.links,drizzle.__drizzle_migrations,public.handoff_barrier;`,
  );
  await sql(
    "source",
    await readFile("deploy/migration/application-runtime-role.sql", "utf8"),
  );
  await kube(
    [
      "exec",
      "-i",
      "deployment/handoff-source",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "fixture_admin",
      "-d",
      "shortener",
      "-c",
      "\\password shortlink_app",
    ],
    `${sourcePassword}\n${sourcePassword}\n`,
  );
  await sql("source", "ALTER ROLE shortlink_app LOGIN;");
  await kube(
    [
      "exec",
      "-i",
      "deployment/handoff-target",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "/tmp",
      "-U",
      "fixture_admin",
      "-d",
      "postgres",
    ],
    `CREATE ROLE shortlink_lab NOLOGIN NOSUPERUSER; CREATE DATABASE shortener OWNER shortlink_lab TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8';`,
  );
  await sql(
    "target",
    `SET ROLE shortlink_lab;\n${schema}\nCREATE TABLE public.handoff_barrier(token text PRIMARY KEY); RESET ROLE;`,
  );
  await sql(
    "target",
    await readFile("deploy/migration/application-runtime-role.sql", "utf8"),
  );
  await kube(
    [
      "exec",
      "-i",
      "deployment/handoff-target",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "/tmp",
      "-U",
      "fixture_admin",
      "-d",
      "shortener",
      "-c",
      "\\password shortlink_app",
    ],
    `${targetPassword}\n${targetPassword}\n`,
  );
  await sql("target", "ALTER ROLE shortlink_app LOGIN;");
  await kube(
    [
      "exec",
      "-i",
      "deployment/handoff-target",
      "--",
      "sh",
      "-c",
      "umask 077; cat > /data/pgdata/migration.pgpass",
    ],
    `${sourceHost}:5432:shortener:fixture_repl:${replicationPassword}\n`,
  );
  // Pod readiness can precede Service dataplane publication. Verify the same TLS path first.
  await waitFor(
    async () => {
      try {
        return (
          (
            await kube([
              "exec",
              "deployment/handoff-target",
              "--",
              "env",
              "PGPASSFILE=/data/pgdata/migration.pgpass",
              "PGSSLMODE=verify-full",
              "PGSSLROOTCERT=/tls/ca.crt",
              "PGCONNECT_TIMEOUT=2",
              "psql",
              "-X",
              "-qAt",
              "-h",
              sourceHost,
              "-U",
              "fixture_repl",
              "-d",
              "shortener",
              "-c",
              "SELECT 1",
            ])
          ).trim() === "1"
        );
      } catch {
        return false;
      }
    },
    "Fixture TLS publisher path did not become available",
    20000,
  );
  await sql(
    "target",
    `CREATE SUBSCRIPTION handoff_sub CONNECTION 'host=${sourceHost} port=5432 dbname=shortener user=fixture_repl passfile=/data/pgdata/migration.pgpass sslmode=verify-full sslrootcert=/tls/ca.crt application_name=handoff_sub connect_timeout=3' PUBLICATION handoff_publication WITH (copy_data=true,streaming=off);`,
  );
  await waitFor(
    async () =>
      JSON.stringify(JSON.parse(await sql("source", digest))) ===
      JSON.stringify(JSON.parse(await sql("target", digest))),
    "Fixture initial copy did not match",
    30000,
  );
  const rbac = (
    await readFile("deploy/k8s/runtime-maintenance.yaml", "utf8")
  ).replace("namespace: shortlink", `namespace: ${namespace}`);
  await kube(["create", "-f", "-"], rbac);
  await create({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "shortlink-runtime" },
    data: { "control.json": JSON.stringify(desired) },
  });
  await create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "handoff-api" },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "handoff-api" } },
      template: {
        metadata: { labels: { ...labels, app: "handoff-api" } },
        spec: {
          serviceAccountName: "redirect-runtime-control",
          containers: [
            {
              name: "api",
              image: apiImage,
              imagePullPolicy: "IfNotPresent",
              env: [
                ...[
                  ["DATABASE_URL", "sourceUrl"],
                  ["HA_DATABASE_URL", "targetUrl"],
                ].map(([name, key]) => ({
                  name,
                  valueFrom: { secretKeyRef: { name: "handoff-private", key } },
                })),
                { name: "HA_DATABASE_CA_FILE", value: "/db-tls/ca.crt" },
                { name: "HA_DATABASE_SERVERNAME", value: targetHost },
                { name: "MAINTENANCE_CONFIGMAP", value: "shortlink-runtime" },
                { name: "POD_NAMESPACE", value: namespace },
                { name: "REDIS_URL", value: "" },
              ],
              readinessProbe: {
                httpGet: { path: "/readyz", port: 3000 },
                periodSeconds: 1,
              },
              resources: {
                requests: { cpu: "25m", memory: "64Mi" },
                limits: { memory: "160Mi" },
              },
              volumeMounts: [
                { name: "ca", mountPath: "/db-tls", readOnly: true },
              ],
            },
          ],
          volumes: [
            {
              name: "ca",
              secret: {
                secretName: "handoff-private",
                items: [{ key: "ca.crt", path: "ca.crt" }],
              },
            },
          ],
        },
      },
    },
  });
  await kube(
    ["rollout", "status", "deployment/handoff-api", "--timeout=90s"],
    undefined,
    95000,
  );
  await waitFor(
    async () => acknowledged(await statuses(), desired),
    "Initial fixture pools did not acknowledge preparation",
  );
  fixturePods = (await get(["get", "pods", "-l", "app=handoff-api"])).items;
  report.apiPods = fixturePods.map((p) => ({
    name: p.metadata.name,
    uid: p.metadata.uid,
    ip: p.status.podIP,
  }));
  const port = await databasePort("source");
  rogue = new Client({
    host: "127.0.0.1",
    port,
    database: "shortener",
    user: "shortlink_app",
    password: sourcePassword,
    ssl: {
      ca: await readFile(`${path}/tls/ca.crt`, "utf8"),
      servername: sourceHost,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, cert) =>
        checkServerIdentity(sourceHost, cert),
    },
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  rogue.on("error", () => {});
  await rogue.connect();
  report.oldConnection = (
    await rogue.query(
      "SELECT pg_backend_pid() AS pid,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser",
    )
  ).rows[0];
  assert.equal(report.oldConnection.superuser, false);
  report.applicationPrivileges = await verifyPrivileges(rogue, true);
  const targetProbe = new Client({
    host: "127.0.0.1",
    port: await databasePort("target"),
    database: "shortener",
    user: "shortlink_app",
    password: targetPassword,
    ssl: {
      ca: await readFile(`${path}/tls/ca.crt`, "utf8"),
      servername: targetHost,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, cert) =>
        checkServerIdentity(targetHost, cert),
    },
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await targetProbe.connect();
    report.targetApplicationPrivileges = await verifyPrivileges(
      targetProbe,
      true,
    );
  } finally {
    await targetProbe.end();
  }

  await create({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "traffic" },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: 120,
      automountServiceAccountToken: false,
      securityContext: { runAsUser: 12345, fsGroup: 12345 },
      containers: [
        {
          name: "k6",
          image: images.k6,
          imagePullPolicy: "IfNotPresent",
          command: [
            "k6",
            "run",
            "--quiet",
            "--log-format=raw",
            "--no-color",
            "/exercise/database-handoff.js",
          ],
          env: [
            {
              name: "ENDPOINTS",
              value: fixturePods
                .map((p) => `http://${p.status.podIP}:3000`)
                .join(","),
            },
            { name: "RUN_ID", value: runId },
          ],
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { memory: "96Mi" },
          },
          volumeMounts: [
            { name: "script", mountPath: "/exercise", readOnly: true },
            { name: "out", mountPath: "/out" },
          ],
        },
      ],
      volumes: [
        {
          name: "script",
          configMap: {
            name: "handoff-scripts",
            items: [
              { key: "database-handoff.js", path: "database-handoff.js" },
            ],
          },
        },
        { name: "out", emptyDir: {} },
      ],
    },
  });
  await waitFor(
    async () => {
      try {
        return (await kube(["logs", "traffic"])).includes("HANDOFF_READY");
      } catch {
        return false;
      }
    },
    "k6 did not start",
    30000,
  );
  await event("baseline");
  await delay(10000);
  await event("failure-before-fencing");
  report.failureMaintenanceStartedAt = Date.now();
  await control({ creationMode: "reject" });
  // Remove the fixture Service endpoints and invalidate existing candidate sessions.
  await kube([
    "patch",
    "service",
    "handoff-target",
    "--type=merge",
    "-p",
    JSON.stringify({ spec: { selector: { app: "deliberately-unavailable" } } }),
  ]);
  await waitFor(
    async () =>
      (
        await get([
          "get",
          "endpointslices",
          "-l",
          "kubernetes.io/service-name=handoff-target",
        ])
      ).items.every((s) => !(s.endpoints ?? []).length),
    "Target endpoints remained during fault",
  );
  report.invalidatedCandidateSessions = Number(
    (
      await sql(
        "target",
        "WITH candidates AS MATERIALIZED (SELECT pid FROM pg_stat_activity WHERE usename='shortlink_app' AND application_name='redirect-service') SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM candidates;",
      )
    ).trim(),
  );
  ensure(
    report.invalidatedCandidateSessions >= 2,
    "The fault did not terminate both runtime candidate sessions",
  );
  const failed = await control(
    { activeDatabase: "ha", prepareDatabase: null },
    "source",
    false,
  );
  report.checks.failedSwitchRetainedSourceAndClosedWrites = failed;
  await delay(3000);
  await kube([
    "patch",
    "service",
    "handoff-target",
    "--type=merge",
    "-p",
    JSON.stringify({ spec: { selector: { app: "handoff-target" } } }),
  ]);
  await waitFor(
    async () =>
      (
        await get([
          "get",
          "endpointslices",
          "-l",
          "kubernetes.io/service-name=handoff-target",
        ])
      ).items.some((s) => (s.endpoints ?? []).some((e) => e.conditions.ready)),
    "Target endpoints did not recover",
  );
  await control({ activeDatabase: "source", prepareDatabase: "ha" });
  await control({ creationMode: "accept" });
  report.failureMaintenanceEndedAt = Date.now();
  await event("recovered-source-baseline");
  await delay(5000);
  await event("real-fixture-handoff");
  report.handoffMaintenanceStartedAt = Date.now();
  await control({ creationMode: "reject" });
  // Demonstrate that an extra client can still write after the API gate has drained.
  report.outsideGate = (
    await rogue.query(
      "INSERT INTO public.links(code,target_url) VALUES($1,$2) RETURNING id::text,code,target_url",
      ["rogueA01", `https://example.test/rogue/${runId}`],
    )
  ).rows[0];
  assertFixture(await appGet(["get", "namespace", namespace]), runId);
  report.fenceStartedAt = Date.now();
  const lsn = (
    await sql(
      "source",
      fenceSql(
        await readFile("deploy/migration/handoff/fence.sql", "utf8"),
        runId,
      ),
    )
  ).trim();
  assert.match(lsn, /^[A-F0-9]+\/[A-F0-9]+$/);
  report.fenceLsn = lsn;
  report.fencedAt = Date.now();
  try {
    await rogue.query(
      "INSERT INTO public.links(code,target_url) VALUES('rogueB01','https://example.test/must-be-denied')",
    );
    throw new Error("Old writer still inserted after fencing");
  } catch (error) {
    assert.equal(error.code, "42501");
    report.checks.oldConnectionWriteDenied = error.code;
  }
  const oldRead = (
    await rogue.query(
      "SELECT pg_backend_pid() AS pid,(SELECT count(*)::int FROM public.links) AS links",
    )
  ).rows[0];
  assert.equal(oldRead.pid, report.oldConnection.pid);
  report.checks.sameConnectionStillReads = oldRead;
  report.fencedPrivileges = (
    await rogue.query(
      "SELECT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,has_table_privilege(current_user,'public.links','SELECT') AS can_read,has_table_privilege(current_user,'public.links','INSERT') AS can_insert,has_table_privilege(current_user,'public.links','UPDATE') AS can_update,has_table_privilege(current_user,'public.links','DELETE') AS can_delete,has_table_privilege(current_user,'public.links','TRUNCATE') AS can_truncate",
    )
  ).rows[0];
  assert.deepEqual(report.fencedPrivileges, {
    superuser: false,
    can_read: true,
    can_insert: false,
    can_update: false,
    can_delete: false,
    can_truncate: false,
  });
  const gates = { fenced: true };
  await waitFor(async () => {
    const progress = JSON.parse(
      await sql(
        "target",
        `SELECT json_build_object('barrier',EXISTS(SELECT 1 FROM handoff_barrier WHERE token='${runId}'),'applied',(SELECT remote_lsn >= '${lsn}'::pg_lsn FROM pg_replication_origin_status WHERE external_id='pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='handoff_sub')));`,
      ),
    );
    report.barrier = progress;
    return progress.barrier && progress.applied;
  }, "Final source transaction was not applied");
  gates.barrierApplied = true;
  report.barrierAppliedAt = Date.now();
  report.finalSource = JSON.parse(await sql("source", digest));
  assert.deepEqual(JSON.parse(await sql("target", digest)), report.finalSource);
  gates.contentsMatched = true;
  report.finalSourceSequences = JSON.parse(await sql("source", sequences));
  report.targetSequencesBeforeCorrection = JSON.parse(
    await sql("target", sequences),
  );
  for (const [key, table] of [
    ["links", "public.links_id_seq"],
    ["history", "drizzle.__drizzle_migrations_id_seq"],
  ]) {
    const sequence = report.finalSourceSequences[key];
    await sql(
      "target",
      `SELECT setval('${table}',${BigInt(sequence.last_value)},${sequence.is_called});`,
    );
  }
  report.targetSequences = JSON.parse(await sql("target", sequences));
  ensure(
    Object.values(report.targetSequences).every((s) => !sequenceRepair(s)),
    "Target sequence allocation is unsafe",
  );
  gates.sequencesSafe = true;
  await sql("target", "ALTER SUBSCRIPTION handoff_sub DISABLE;");
  await waitFor(
    async () =>
      (
        await sql(
          "target",
          "SELECT count(*) FROM pg_stat_subscription WHERE subname='handoff_sub' AND pid IS NOT NULL;",
        )
      ).trim() === "0",
    "Apply worker did not stop",
  );
  await sql("target", "DROP SUBSCRIPTION handoff_sub;");
  ensure(
    (
      await sql(
        "source",
        "SELECT count(*) FROM pg_replication_slots WHERE slot_name='handoff_sub';",
      )
    ).trim() === "0",
    "Fixture slot was not removed",
  );
  gates.subscriptionStopped = true;
  assertSwitchGates(gates);
  report.gates = gates;
  await control({ activeDatabase: "ha", prepareDatabase: null });
  report.poolsSwitchedAt = Date.now();
  await control({ creationMode: "accept" });
  report.handoffMaintenanceEndedAt = Date.now();
  await event("destination-serving");
  await waitFor(
    async () => {
      const p = await get(["get", "pod", "traffic"]);
      return Boolean(
        p.status.containerStatuses?.find((c) => c.name === "k6")?.state
          .terminated,
      );
    },
    "k6 did not finish",
    100000,
  );
  const traffic = await get(["get", "pod", "traffic"]);
  const logs = await kube(["logs", "traffic", "-c", "k6"]);
  const summaryLine = logs
    .split("\n")
    .find((line) => line.startsWith("HANDOFF_SUMMARY "));
  ensure(summaryLine, "k6 did not produce a complete summary");
  const summary = JSON.parse(summaryLine.slice("HANDOFF_SUMMARY ".length));
  await save("summary.json", summary);
  report.metrics = Object.fromEntries(
    Object.entries(summary.metrics).filter(
      ([key]) => key.startsWith("handoff_") || key === "dropped_iterations",
    ),
  );
  await writeFile(`${path}/k6.log`, logs);
  const journal = logs
    .split("\n")
    .filter((l) => l.startsWith("ACK "))
    .map((l) => JSON.parse(l.slice(4)));
  report.acknowledgedCreations = journal.length;
  assert.equal(
    journal.length,
    summary.metrics.handoff_creations.values.count,
    "Creation acknowledgement journal is incomplete",
  );
  await save("acknowledged-creations.json", journal);
  report.k6ExitCode = traffic.status.containerStatuses?.find(
    (c) => c.name === "k6",
  )?.state.terminated?.exitCode;
  const expected = JSON.stringify(journal).replaceAll("'", "''");
  const cohort = `SELECT count(*)::int FROM jsonb_to_recordset('${expected}'::jsonb) AS e(code text,"targetUrl" text) JOIN public.links l ON l.code=e.code AND l.target_url=e."targetUrl";`;
  report.storedAcknowledgements = Number((await sql("target", cohort)).trim());
  assert.equal(report.storedAcknowledgements, journal.length);
  assert.deepEqual(
    JSON.parse(await sql("source", digest)),
    report.finalSource,
    "Fenced source changed after the handoff",
  );
  const post = journal.filter(
    (e) => e.at > report.handoffMaintenanceEndedAt + 1000,
  );
  ensure(post.length > 5, "No meaningful post-handoff creation cohort");
  report.postHandoffCreations = post.length;
  const final = await statuses();
  ensure(acknowledged(final, desired), "Final replicas are not serving HA");
  report.finalPods = final;
  assert.deepEqual(
    final.map((p) => p.uid).sort(),
    report.apiPods.map((p) => p.uid).sort(),
    "Fixture pods were replaced instead of switching pools",
  );
  ensure(
    report.k6ExitCode === 0,
    "k6 thresholds failed; preserve the failed rehearsal",
  );
  report.liveAfter = await liveState();
  for (const key of [
    "control",
    "sourcePostgres",
    "cnpg",
    "haSequences",
    "sourceRole",
  ])
    assert.deepEqual(
      report.liveAfter[key],
      report.liveBefore[key],
      `Live ${key} changed`,
    );
  assert.equal(
    report.liveAfter.application.deploymentSpecHash,
    report.liveBefore.application.deploymentSpecHash,
  );
  assert.deepEqual(
    report.liveAfter.runtime.pods.map((p) => p.uid).sort(),
    report.liveBefore.runtime.pods.map((p) => p.uid).sort(),
  );
  report.checks.liveApplicationUnchanged = true;
  report.passed = true;
} catch (error) {
  report.error =
    error.code === "ERR_ASSERTION"
      ? "A handoff invariant failed; inspect private evidence"
      : error.message;
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.cleanupErrors = [];
  stopMonitor = true;
  await monitoring;
  if (monitorError) {
    report.passed = false;
    report.error ??= monitorError;
    process.exitCode = 1;
  }
  try {
    await rogue?.end();
  } catch {
    report.cleanupErrors.push("Old client close failed");
  }
  for (const forward of forwards) forward.kill("SIGTERM");
  if (created) {
    for (const [name, args] of [
      ["pods", ["get", "pods", "-o", "json"]],
      ["traffic", ["logs", "traffic"]],
      ...["source", "target", "api"].map((s) => [
        s,
        [
          "logs",
          `deployment/handoff-${s}`,
          "--all-pods=true",
          "--timestamps=true",
        ],
      ]),
    ]) {
      try {
        await writeFile(`${path}/${name}.log`, await kube(args));
      } catch {
        /* A failed bootstrap may not have created this resource. */
      }
    }
    try {
      assertFixture(await appGet(["get", "namespace", namespace]), runId);
      await appKube(
        ["delete", "namespace", namespace, "--wait=true", "--timeout=45s"],
        undefined,
        50000,
      );
      ensure(
        !(await appGet(["get", "namespaces"])).items.some(
          (n) => n.metadata.name === namespace,
        ),
        "Fixture namespace remains",
      );
    } catch {
      report.cleanupErrors.push(
        "Fixture namespace cleanup failed; inspect only the recorded run namespace",
      );
    }
  }
  await rm(`${path}/tls`, { recursive: true, force: true });
  report.cleanupPassed = report.cleanupErrors.length === 0;
  if (!report.cleanupPassed) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await save("result.json", report);
  console.log(
    JSON.stringify({
      passed: report.passed,
      cleanupPassed: report.cleanupPassed,
      evidence: `${path}/result.json`,
    }),
  );
}
