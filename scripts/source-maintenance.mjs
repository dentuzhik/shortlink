import { execFile } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appGet,
  appKube,
  dbGet,
  dbKube,
  directory,
  ensure,
  network,
  run,
  sourceState,
  vmAddresses,
} from "./lib/db-lab-connectivity.mjs";

const cfg = JSON.parse(
  await readFile("deploy/migration/source-network.json", "utf8"),
);
const mode = process.argv[2];
ensure(
  ["prepare", "rehearse", "apply", "resume", "check"].includes(mode),
  "Use prepare, rehearse, apply or check",
);
const root = ".kind/db-cluster/source-maintenance";
await mkdir(root, { recursive: true, mode: 0o700 });
const dk = (args, input, timeout) =>
  run("docker", ["--context", "colima", ...args], input, timeout);
const sqlArgs = (database = "shortener", user = "shortener") => [
  "psql",
  "-X",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  user,
  "-d",
  database,
];
const srcSql = (sql, pod = "deployment/postgres") =>
  appKube(
    ["exec", "-i", pod, "--", ...sqlArgs()],
    `SET statement_timeout='10s';\n${sql}`,
  );
const dbPods = async () =>
  (
    await dbGet([
      "get",
      "pods",
      "-l",
      "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
    ])
  ).items;
const pubLabels = { "shortlink.dev/exercise": "source-maintenance" };
const b64 = (value) => Buffer.from(value).toString("base64");
const decode = (value) => Buffer.from(value, "base64").toString();
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const current = async () =>
  JSON.parse(await readFile(`${root}/current.json`, "utf8"));
async function oneSecret(get, kube, name, data, type = "Opaque") {
  const found = (
    await get([
      "get",
      "secret",
      "-l",
      `shortlink.dev/exercise=source-maintenance`,
    ])
  ).items.find((s) => s.metadata.name === name);
  if (found) return found;
  await kube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, labels: pubLabels },
      type,
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, b64(v)]),
      ),
    }),
  );
  return get(["get", "secret", name]);
}
async function put(kube, object) {
  await kube(["apply", "-f", "-"], JSON.stringify(object));
}
const trustPath = `/controller/external/${cfg.externalCluster}/${cfg.clientSecret}_ca.crt`;
const passPath = `/controller/external/${cfg.externalCluster}/pgpass`;
const conn = `host=${cfg.hostname} port=5432 dbname=shortener user=shortlink_migrator sslmode=verify-full sslrootcert=${trustPath} passfile=${passPath} connect_timeout=3`;
async function remote(pod, query) {
  return dbKube(
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
      "--dbname",
      conn,
    ],
    query,
  );
}
async function rejection(pod, override, pattern, wrongPassword = false) {
  const args = [
    "--kubeconfig",
    ".kind/db-cluster/kubeconfig",
    "--context",
    "kind-shortlink-db",
    "-n",
    "database-lab",
    "exec",
    pod,
    "--",
    ...(wrongPassword ? ["env", "PGPASSWORD=deliberately-wrong-password"] : []),
    "psql",
    "-X",
    "-qAt",
    `${conn} ${override}`,
    "-c",
    "SELECT 1",
  ];
  const result = await new Promise((res, rej) =>
    execFile(
      "kubectl",
      args,
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err?.code === "ENOENT") rej(err);
        else res({ failed: !!err, error: stderr });
      },
    ),
  );
  ensure(
    result.failed && pattern.test(result.error),
    "Negative source authentication check failed or had an unexpected cause",
  );
}
async function role(pod = "deployment/postgres") {
  const secret = await appGet(["get", "secret", "source-replication-login"]);
  const exists = (
    await srcSql(
      "SELECT count(*) FROM pg_roles WHERE rolname='shortlink_migrator';",
      pod,
    )
  ).trim();
  ensure(
    exists === "0",
    "Replication role already exists; inspect it instead of overwriting its password",
  );
  await srcSql(await readFile("deploy/migration/source-role.sql", "utf8"), pod);
  const password = decode(secret.data.password);
  ensure(
    /^[a-f0-9]{48}$/.test(password),
    "Unexpected generated replication password format",
  );
  await srcSql(`ALTER ROLE shortlink_migrator PASSWORD '${password}';`, pod);
}
async function selectPublisher(selector) {
  await appKube([
    "patch",
    "service",
    cfg.sourceService,
    "--type=json",
    "-p",
    JSON.stringify([
      { op: "replace", path: "/spec/selector", value: selector },
    ]),
  ]);
  await delay(2200);
}
async function checkRemote() {
  const pods = await dbPods();
  const sessions = [];
  for (const pod of pods) {
    const value = JSON.parse(
      await remote(
        pod.metadata.name,
        "SELECT json_build_object('role',current_user,'database',current_database(),'tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'replication',(SELECT rolreplication FROM pg_roles WHERE rolname=current_user),'canInsert',has_table_privilege(current_user,'public.links','INSERT'),'wal_level',current_setting('wal_level'),'slots',(SELECT count(*) FROM pg_replication_slots));",
      ),
    );
    ensure(
      value.role === "shortlink_migrator" &&
        value.database === "shortener" &&
        value.tls &&
        !value.superuser &&
        value.replication &&
        !value.canInsert &&
        value.wal_level === "logical",
      "Unexpected remote publisher session",
    );
    const permission = (
      await dbKube([
        "exec",
        pod.metadata.name,
        "--",
        "stat",
        "-c",
        "%a",
        passPath,
      ])
    ).trim();
    ensure(
      permission === "600",
      "CNPG password file permissions are not private",
    );
    sessions.push({
      pod: pod.metadata.name,
      ...value,
      passwordFileMode: permission,
    });
  }
  const pod = pods[0].metadata.name;
  const service = await dbGet(["get", "service", cfg.serviceName]);
  await rejection(
    pod,
    "sslmode=disable",
    /pg_hba.conf rejects|no pg_hba.conf entry/i,
  );
  await rejection(
    pod,
    `host=incorrect.publisher.invalid hostaddr=${service.spec.clusterIP}`,
    /does not match host name|does not match.*host/i,
  );
  await rejection(
    pod,
    "sslrootcert=/etc/ssl/certs/ca-certificates.crt",
    /certificate verify failed|self-signed/i,
  );
  await rejection(pod, "", /password authentication failed/i, true);
  return {
    sessions,
    negativeChecks: {
      plaintext: true,
      wrongHostname: true,
      untrustedCA: true,
      wrongPassword: true,
    },
  };
}
const digest = `SET timezone='UTC'; SELECT json_build_object('links_count',(SELECT count(*) FROM links),'links',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text COLLATE "C"),''),'UTF8')),'hex') FROM links x),'history',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text COLLATE "C"),''),'UTF8')),'hex') FROM drizzle.__drizzle_migrations x));`;

async function ensureNotCompleted() {
  const recorded = (
    await appGet([
      "get",
      "configmap",
      "-l",
      "shortlink.dev/exercise=source-maintenance",
    ])
  ).items.find((c) => c.metadata.name === "source-maintenance-state");
  ensure(
    !recorded,
    "Source maintenance is already recorded; use db:source:check instead of reconfiguring its endpoint",
  );
}
async function prepare() {
  await ensureNotCompleted();
  await sourceState();
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host pressure is not normal",
  );
  ensure(
    (await srcSql("SELECT count(*) FROM pg_replication_slots;")).trim() === "0",
    "Source already has replication slots",
  );
  const path = await directory("source-maintenance");
  const info = {
    id: randomUUID(),
    path,
    preparedAt: new Date().toISOString(),
    addresses: await vmAddresses(),
    status: "prepared",
  };
  await save(
    `${path}/source-deployment-before.json`,
    await appGet(["get", "deployment", "postgres"]),
  );
  await save(
    `${path}/source-data-before.json`,
    JSON.parse(await srcSql(digest)),
  );
  const keyDir = resolve(path, "issuer");
  await mkdir(keyDir, { mode: 0o700 });
  try {
    const previous = (
      await appGet([
        "get",
        "secret",
        "-l",
        "shortlink.dev/exercise=source-maintenance",
      ])
    ).items;
    if (!previous.some((s) => s.metadata.name === "source-publisher-tls")) {
      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-days",
        "730",
        "-subj",
        "/CN=Shortlink source migration CA",
        "-keyout",
        `${keyDir}/ca.key`,
        "-out",
        `${keyDir}/ca.crt`,
      ]);
      await run("openssl", [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-subj",
        `/CN=${cfg.hostname}`,
        "-keyout",
        `${keyDir}/tls.key`,
        "-out",
        `${keyDir}/server.csr`,
      ]);
      await writeFile(
        `${keyDir}/extensions.cnf`,
        `subjectAltName=DNS:${cfg.hostname},DNS:postgres.shortlink.svc.cluster.local\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      );
      await run("openssl", [
        "x509",
        "-req",
        "-in",
        `${keyDir}/server.csr`,
        "-CA",
        `${keyDir}/ca.crt`,
        "-CAkey",
        `${keyDir}/ca.key`,
        "-CAcreateserial",
        "-days",
        "365",
        "-extfile",
        `${keyDir}/extensions.cnf`,
        "-out",
        `${keyDir}/tls.crt`,
      ]);
      await oneSecret(appGet, appKube, "source-publisher-ca", {
        "ca.crt": await readFile(`${keyDir}/ca.crt`, "utf8"),
        "ca.key": await readFile(`${keyDir}/ca.key`, "utf8"),
      });
      await oneSecret(
        appGet,
        appKube,
        "source-publisher-tls",
        {
          "tls.crt": await readFile(`${keyDir}/tls.crt`, "utf8"),
          "tls.key": await readFile(`${keyDir}/tls.key`, "utf8"),
        },
        "kubernetes.io/tls",
      );
    }
    const ca = await appGet(["get", "secret", "source-publisher-ca"]);
    const tls = await appGet(["get", "secret", "source-publisher-tls"]);
    const cert = new X509Certificate(decode(tls.data["tls.crt"]));
    ensure(
      cert.checkHost(cfg.hostname),
      "Source TLS certificate hostname does not match",
    );
    info.certificate = {
      fingerprint: cert.fingerprint256,
      validTo: cert.validTo,
    };
    const login = await oneSecret(appGet, appKube, "source-replication-login", {
      username: "shortlink_migrator",
      password: randomBytes(24).toString("hex"),
      dbname: "shortener",
    });
    const existing = (
      await dbGet([
        "get",
        "secret",
        "-l",
        "shortlink.dev/exercise=source-maintenance",
      ])
    ).items.find((s) => s.metadata.name === cfg.clientSecret);
    if (existing)
      ensure(
        existing.data.password === login.data.password &&
          existing.data["ca.crt"] === ca.data["ca.crt"],
        "Destination credential/trust differs; inspect instead of rotating automatically",
      );
    await oneSecret(dbGet, dbKube, cfg.clientSecret, {
      username: decode(login.data.username),
      password: decode(login.data.password),
      "ca.crt": decode(ca.data["ca.crt"]),
    });
    await put(appKube, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "source-publisher-hba", labels: pubLabels },
      data: {
        "pg_hba.conf": await readFile("deploy/migration/pg_hba.conf", "utf8"),
      },
    });
  } finally {
    await rm(keyDir, { recursive: true, force: true });
  }
  const external = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "shortlink-lab", namespace: "database-lab" },
    spec: {
      externalClusters: [
        {
          name: cfg.externalCluster,
          connectionParameters: {
            host: cfg.hostname,
            port: "5432",
            dbname: "shortener",
            user: "shortlink_migrator",
            sslmode: "verify-full",
            connect_timeout: "3",
          },
          sslRootCert: { name: cfg.clientSecret, key: "ca.crt" },
          password: { name: cfg.clientSecret, key: "password" },
        },
      ],
    },
  };
  await writeFile(
    "deploy/migration/destination-external.json",
    `${JSON.stringify(external, null, 2)}\n`,
  );
  await dbKube([
    "apply",
    "--server-side",
    "--field-manager=shortlink-source-maintenance",
    "-f",
    "deploy/migration/destination-external.json",
  ]);
  const existingService = (await appGet(["get", "services"])).items.find(
    (s) => s.metadata.name === cfg.sourceService,
  );
  if (!existingService)
    await put(appKube, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: cfg.sourceService, labels: pubLabels },
      spec: {
        type: "NodePort",
        selector: { "shortlink.dev/publisher-state": "unconfigured" },
        ports: [
          {
            name: "postgres",
            port: 5432,
            targetPort: 5432,
            nodePort: cfg.nodePort,
          },
        ],
      },
    });
  await put(dbKube, {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: cfg.serviceName, labels: pubLabels },
    spec: { ports: [{ name: "postgres", port: 5432 }] },
  });
  await put(dbKube, {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: {
      name: "migration-source-vm",
      labels: {
        ...pubLabels,
        "kubernetes.io/service-name": cfg.serviceName,
        "endpointslice.kubernetes.io/managed-by":
          "source-maintenance.shortlink.dev",
      },
    },
    addressType: "IPv4",
    ports: [{ name: "postgres", port: cfg.listenPort, protocol: "TCP" }],
    endpoints: [
      { addresses: [info.addresses.application], conditions: { ready: true } },
    ],
  });
  const bridge = `global\n  log stdout format raw local0\n  maxconn 128\ndefaults\n  log global\n  mode tcp\n  option tcplog\n  timeout connect 2s\n  timeout client 1h\n  timeout server 1h\nfrontend publisher\n  bind :5432\n  acl database_vm src ${info.addresses.database}/32\n  tcp-request connection reject unless database_vm\n  default_backend source_node\nbackend source_node\n  server source shortlink-control-plane:${cfg.nodePort} check inter 1s rise 1 fall 2\n`;
  const bridgePath = resolve(path, "publisher-haproxy.cfg");
  await writeFile(bridgePath, bridge);
  await chmod(bridgePath, 0o644);
  const old = (
    await dk([
      "ps",
      "-a",
      "--filter",
      `name=^/${cfg.bridgeName}$`,
      "--format",
      "{{.Names}}",
    ])
  ).trim();
  if (old) {
    const [c] = JSON.parse(await dk(["inspect", cfg.bridgeName]));
    ensure(
      c.Config.Labels["shortlink.dev/exercise"] === "source-maintenance",
      "Unrelated bridge occupies publisher name",
    );
    await dk(["rm", "-f", cfg.bridgeName]);
  }
  await dk([
    "create",
    "--name",
    cfg.bridgeName,
    "--label",
    "shortlink.dev/exercise=source-maintenance",
    "--network",
    "kind",
    "--publish",
    `${info.addresses.application}:${cfg.listenPort}:5432`,
    "--memory",
    "64m",
    "--cpus",
    "0.25",
    "--restart",
    "unless-stopped",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    network.bridgeImage,
  ]);
  await dk([
    "cp",
    bridgePath,
    `${cfg.bridgeName}:/usr/local/etc/haproxy/haproxy.cfg`,
  ]);
  await dk(["start", cfg.bridgeName]);
  for (let i = 0; i < 30; i++) {
    try {
      for (const p of await dbPods())
        await dbKube(["exec", p.metadata.name, "--", "test", "-r", passPath]);
      break;
    } catch (e) {
      if (i === 29) throw e;
      await delay(500);
    }
  }
  await appKube([
    "patch",
    "deployment",
    "postgres",
    "--type=strategic",
    "--patch-file=deploy/migration/source-settings.patch.yaml",
    "--dry-run=server",
    "-o",
    "name",
  ]);
  info.sourceStillHealthy = await sourceState();
  await save(`${root}/current.json`, info);
  await save(`${path}/preparation.json`, info);
  return info;
}

async function rehearse() {
  await ensureNotCompleted();
  const info = await current();
  const name = `source-maint-${info.id.slice(0, 8)}`;
  const result = { startedAt: new Date().toISOString(), passed: false };
  let created = false;
  try {
    await sourceState();
    const dry = JSON.parse(
      await appKube([
        "patch",
        "deployment",
        "postgres",
        "--type=strategic",
        "--patch-file=deploy/migration/source-settings.patch.yaml",
        "--dry-run=server",
        "-o",
        "json",
      ]),
    );
    const spec = dry.spec.template.spec;
    spec.volumes = spec.volumes.map((v) =>
      v.name === "data" ? { name: "data", emptyDir: {} } : v,
    );
    spec.restartPolicy = "Never";
    spec.automountServiceAccountToken = false;
    spec.activeDeadlineSeconds = 180;
    spec.containers[0].envFrom = [{ secretRef: { name } }];
    await appKube(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, labels: pubLabels },
        stringData: {
          POSTGRES_USER: "shortener",
          POSTGRES_DB: "shortener",
          POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
        },
      }),
    );
    created = true;
    await appKube(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name, labels: { app: name, ...pubLabels } },
        spec,
      }),
    );
    await appKube(
      ["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=90s"],
      undefined,
      100000,
    );
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
    ]);
    await srcSql(schema, name);
    await role(name);
    await selectPublisher({ app: name });
    result.remote = await checkRemote();
    const sizes = JSON.parse(
      await srcSql(
        "SELECT json_build_object('maxBytes',(SELECT max(octet_length(target_url)) FROM links),'p95Bytes',(SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY octet_length(target_url)) FROM links));",
      ),
    );
    result.walSamples = [];
    for (let window = 0; window < 2; window++) {
      await srcSql("CHECKPOINT;", name);
      const lsn = (await srcSql("SELECT pg_current_wal_lsn();", name)).trim();
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        const begin = performance.now();
        await srcSql(
          `INSERT INTO links(code,target_url) VALUES('wal${window}_${i}','https://example.test/'||repeat('x',${Math.max(128, Number(sizes.maxBytes) || 128)}));`,
          name,
        );
        await delay(Math.max(0, 100 - (performance.now() - begin)));
      }
      const elapsed = (performance.now() - start) / 1000;
      const bytes = Number(
        (
          await srcSql(
            `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'${lsn}');`,
            name,
          )
        ).trim(),
      );
      result.walSamples.push({
        writes: 50,
        seconds: elapsed,
        bytes,
        bytesPerSecond: bytes / elapsed,
      });
    }
    const peak = Math.max(...result.walSamples.map((s) => s.bytesPerSecond));
    result.retention = {
      capMiB: cfg.retentionMiB,
      planningPauseMinutes: cfg.planningPauseMinutes,
      peakSampleBytesPerSecond: peak,
      planningBytesAt4xSample: peak * 4 * cfg.planningPauseMinutes * 60,
      sourceUrlSize: sizes,
    };
    ensure(
      result.retention.planningBytesAt4xSample < cfg.retentionMiB * 1024 * 1024,
      "Retention candidate does not cover the chosen planning window at the sampled multiplier",
    );
    result.mountPermissions = (
      await appKube([
        "exec",
        name,
        "--",
        "stat",
        "-Lc",
        "%u:%g %a",
        "/etc/postgresql/publisher-tls/tls.key",
      ])
    ).trim();
    ensure(
      result.mountPermissions === "0:999 440",
      "Unexpected resolved TLS private-key ownership or permissions",
    );
    result.passed = true;
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
    await selectPublisher({ "shortlink.dev/publisher-state": "unconfigured" });
    if (created)
      await appKube(
        [
          "delete",
          "pod,secret",
          name,
          "--ignore-not-found=true",
          "--wait=true",
          "--timeout=30s",
        ],
        undefined,
        40000,
      );
    result.completedAt = new Date().toISOString();
    await save(`${info.path}/rehearsal.json`, result);
  }
  return result;
}

function httpProbe(host, path) {
  return new Promise((resolveProbe) => {
    const begin = new Date().toISOString();
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 8080,
        path,
        headers: { Host: host },
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolveProbe({
          time: begin,
          host,
          path,
          status: res.statusCode,
          location: res.headers.location,
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", (error) =>
      resolveProbe({
        time: begin,
        host,
        path,
        error: error.code ?? error.name,
      }),
    );
    req.end();
  });
}
async function apply(resume = false) {
  const info = await current();
  ensure(
    info.status !== "completed",
    "Source maintenance is already completed; use db:source:check",
  );
  const rehearsal = JSON.parse(
    await readFile(`${info.path}/rehearsal.json`, "utf8"),
  );
  ensure(
    rehearsal.passed,
    "Exact source bundle rehearsal must pass before maintenance",
  );
  const backups = JSON.parse(
    await run("python3", [
      "-c",
      "import pathlib,json; print(json.dumps(sorted([str(p) for p in pathlib.Path('.kind/backups').glob('*/result.json')],reverse=True)))",
    ]),
  );
  const backup = JSON.parse(await readFile(backups[0], "utf8"));
  ensure(
    backup.passed && Date.now() - Date.parse(backup.startedAt) < 3600000,
    "A fresh passing restore rehearsal is required",
  );
  const archive = resolve(backups[0], "..", "shortener.dump");
  ensure(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") === backup.archive.sha256,
    "Verified backup archive no longer matches its recorded checksum",
  );
  if (resume) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await appKube(["get", "--raw=/readyz"]);
        break;
      } catch (error) {
        if (attempt === 59) throw error;
        await delay(1000);
      }
    }
  }
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host memory pressure is not normal",
  );
  if (!resume) await sourceState();
  ensure(
    (await srcSql("SELECT count(*) FROM pg_replication_slots;")).trim() === "0",
    "Unexpected source slots before restart",
  );
  const deployment = await appGet(["get", "deployment", "postgres"]);
  const state = (await appGet(["get", "configmap"])).items.find(
    (c) => c.metadata.name === "source-maintenance-state",
  );
  ensure(
    !state,
    "This maintenance window has already been recorded; use check instead of replaying it",
  );
  const publicBridge = "shortlink-edge-bridge-1";
  const [bridge] = JSON.parse(await dk(["inspect", publicBridge]));
  ensure(
    resume ? !bridge.State.Running : bridge.State.Running,
    "Unexpected public bridge state for this maintenance phase",
  );
  const rows = JSON.parse(
    await srcSql(
      "SELECT json_agg(x) FROM (SELECT code,target_url FROM links ORDER BY id LIMIT 10)x;",
    ),
  );
  const baseline = JSON.parse(await srcSql(digest));
  const result = resume
    ? JSON.parse(await readFile(`${info.path}/maintenance.json`, "utf8"))
    : {
        startedAt: new Date().toISOString(),
        passed: false,
        backup: backups[0],
        before: baseline,
        events: [],
        capacity: { cpus: cfg.vmCpus, memoryGiB: cfg.vmMemoryGiB },
      };
  if (resume)
    ensure(
      result.entrypointClosed === true && result.passed === false,
      "Only a recorded failed, gated window may be resumed",
    );
  ensure(
    JSON.stringify(baseline) === JSON.stringify(result.before),
    "Source data differs from the original pre-window snapshot; stop and investigate before resuming",
  );
  const observations = resume
    ? JSON.parse(await readFile(`${info.path}/http-observations.json`, "utf8"))
    : [];
  let stopMonitor = false;
  let closed = resume;
  const record = async (event) => {
    result.events.push({ time: new Date().toISOString(), event });
    await save(`${info.path}/maintenance.json`, result);
    console.log(event);
  };
  const monitor = (async () => {
    while (!stopMonitor) {
      observations.push(
        await Promise.all([
          httpProbe("go.localhost", "/readyz"),
          httpProbe("app.localhost", "/"),
          httpProbe("go.localhost", `/${rows[0].code}`),
        ]),
      );
      await delay(1000);
    }
  })();
  try {
    if (!resume) {
      await delay(2200);
      await record("Closing public bridge: planned downtime begins");
      result.bridgeCloseRequestedAt = new Date().toISOString();
      await dk(["update", "--restart=no", publicBridge]);
      await dk(["stop", "-t", "5", publicBridge]);
      closed = true;
      await record("Stopping application VM");
      await run("colima", ["stop", "default"], undefined, 180000);
      await record("Starting application VM with 6 CPUs and 6 GiB");
      await run(
        "colima",
        [
          "start",
          "default",
          "--cpus",
          String(cfg.vmCpus),
          "--memory",
          String(cfg.vmMemoryGiB),
          "--activate=false",
          "--ssh-config=false",
        ],
        undefined,
        240000,
      );
    } else {
      await record("Resuming the same gated window after API startup retry");
      delete result.error;
      delete result.entrypointClosed;
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await appKube(["get", "--raw=/readyz"]);
        break;
      } catch (error) {
        if (attempt === 59) throw error;
        await delay(1000);
      }
    }
    const afterIPs = await vmAddresses();
    ensure(
      JSON.stringify(afterIPs) === JSON.stringify(info.addresses),
      "Private VM addresses changed; refresh mappings while traffic remains gated",
    );
    const [gated] = JSON.parse(await dk(["inspect", publicBridge]));
    ensure(
      !gated.State.Running,
      "Public bridge unexpectedly reopened during VM startup",
    );
    await appKube(
      ["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=180s"],
      undefined,
      190000,
    );
    await record(
      "Applying logical-WAL and TLS/HBA configuration to source Postgres",
    );
    await appKube([
      "patch",
      "deployment",
      "postgres",
      "--type=strategic",
      "--patch-file=deploy/migration/source-settings.patch.yaml",
    ]);
    await appKube(
      ["rollout", "status", "deployment/postgres", "--timeout=180s"],
      undefined,
      190000,
    );
    await role();
    await selectPublisher({ app: "postgres" });
    result.remote = await checkRemote();
    result.after = JSON.parse(await srcSql(digest));
    ensure(
      JSON.stringify(result.after) === JSON.stringify(result.before),
      "Source table data changed during the maintenance window",
    );
    const pods = (await appGet(["get", "pods", "-l", "app=redirect-service"]))
      .items;
    for (const p of pods) {
      const script = `(async()=>{const ready=await fetch('http://127.0.0.1:3000/readyz');if(ready.status!==200)throw Error('not ready');for(const row of ${JSON.stringify(rows)}){const r=await fetch('http://127.0.0.1:3000/'+row.code,{redirect:'manual'});if(r.status!==302||r.headers.get('location')!==row.target_url||r.headers.get('cache-control')!=='no-store')throw Error('redirect mismatch')}console.log('verified')})().catch(()=>process.exit(1))`;
      await appKube(["exec", p.metadata.name, "--", "node", "-e", script]);
    }
    result.redirectsChecked = pods.length * rows.length;
    ensure(
      (
        await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
      ).trim() === "1",
      "Host pressure is not normal after resize",
    );
    result.vmProfiles = (await run("colima", ["list", "--json"]))
      .trim()
      .split("\n")
      .map(JSON.parse);
    ensure(
      result.vmProfiles.some(
        (p) =>
          p.name === "default" &&
          p.cpus === cfg.vmCpus &&
          p.memory === cfg.vmMemoryGiB * 1024 ** 3,
      ),
      "Unexpected resized VM allocation",
    );
    await record(
      "Source, reverse path, data and per-pod redirects verified; reopening public bridge",
    );
    result.bridgeOpenRequestedAt = new Date().toISOString();
    await dk(["update", "--restart=unless-stopped", publicBridge]);
    await dk(["start", publicBridge]);
    closed = false;
    for (let i = 0; i < 30; i++) {
      try {
        result.sourceAfter = await sourceState();
        break;
      } catch (e) {
        if (i === 29) throw e;
        await delay(500);
      }
    }
    await delay(2500);
    await put(appKube, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "source-maintenance-state", labels: pubLabels },
      data: {
        status: "completed",
        evidence: info.path,
        completedAt: new Date().toISOString(),
      },
    });
    result.passed = true;
    info.status = "completed";
    info.completedAt = new Date().toISOString();
    await save(`${root}/current.json`, info);
  } catch (error) {
    result.error = error.message;
    result.entrypointClosed = closed;
    await save(`${info.path}/source-template-rollback.json`, [
      {
        op: "replace",
        path: "/spec/template",
        value: deployment.spec.template,
      },
    ]);
    console.error(
      "Maintenance failed; inspect the recorded state and restore service before further migration work.",
    );
    throw error;
  } finally {
    stopMonitor = true;
    await monitor;
    result.completedAt = new Date().toISOString();
    if (result.bridgeCloseRequestedAt && result.bridgeOpenRequestedAt)
      result.controlledWindowSeconds =
        (Date.parse(result.bridgeOpenRequestedAt) -
          Date.parse(result.bridgeCloseRequestedAt)) /
        1000;
    if (!result.passed) {
      const failedAt = Date.now();
      await save(`${info.path}/maintenance-failed-${failedAt}.json`, result);
      await save(
        `${info.path}/http-observations-failed-${failedAt}.json`,
        observations,
      );
    }
    await save(`${info.path}/http-observations.json`, observations);
    await save(`${info.path}/maintenance.json`, result);
  }
  return result;
}

try {
  let output;
  if (mode === "prepare") output = await prepare();
  if (mode === "rehearse") output = await rehearse();
  if (mode === "apply") output = await apply();
  if (mode === "resume") output = await apply(true);
  if (mode === "check")
    output = {
      passed: true,
      ...(await checkRemote()),
      source: await sourceState(),
    };
  console.log(
    JSON.stringify({
      mode,
      passed: output?.passed ?? true,
      evidence: (await current()).path,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
