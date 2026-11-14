import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Explicit targets: this exercise must never infer a destination from DATABASE_URL.
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
process.umask(0o077);
const kube = [
  "--kubeconfig",
  ".kind/kubeconfig",
  "--context",
  "kind-shortlink",
  "-n",
  "shortlink",
];
const docker = ["--context", "colima"];
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const directory = resolve(".kind/backups", stamp);
const container = `shortlink-restore-${stamp.toLowerCase()}`;
const volume = `${container}-data`;
const archive = resolve(directory, "shortener.dump");
const label = "shortlink.exercise=db-restore";
const runLabel = `shortlink.rehearsal=${stamp}`;
const children = new Set();
let interrupted = false;
let cleaningUp = false;
let snapshotProcess;
let snapshotDone;
let containerCreated = false;
let volumeCreated = false;
let sourcePod;
let app;
let client;
let monitor;
let finishMonitor = false;
const observations = [];
const report = {
  passed: false,
  startedAt: new Date().toISOString(),
  directory,
  checks: {},
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function launch(command, args, options = {}) {
  ensure(!interrupted || cleaningUp, "Rehearsal interrupted");
  const child = spawn(command, args, {
    cwd: root,
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const done = new Promise((resolveDone, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      if (code === 0) resolveDone();
      else
        reject(
          new Error(`${command} exited ${code ?? signal}; see local artifacts`),
        );
    });
  });
  // Attach immediately, including while another stream is being awaited.
  done.catch(() => {});
  return { child, done };
}
async function run(command, args, { input, output, env } = {}) {
  const { child, done } = launch(command, args, { env: env ?? process.env });
  const chunks = [];
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const stdout = output
    ? pipeline(
        child.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      )
    : (async () => {
        for await (const chunk of child.stdout) chunks.push(chunk);
      })();
  const stdin =
    typeof input === "string" || Buffer.isBuffer(input)
      ? new Promise((resolveInput, reject) => {
          child.stdin.on("error", reject);
          child.stdin.end(input, resolveInput);
        })
      : input
        ? pipeline(input, child.stdin)
        : Promise.resolve(child.stdin.end());
  try {
    await Promise.all([done, stdout, stdin]);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.allSettled([done, stdout, stdin]);
    await writeFile(
      resolve(directory, "last-command.stderr"),
      Buffer.concat(errors),
    );
    throw error;
  }
  const stderr = Buffer.concat(errors).toString();
  if (stderr.trim())
    await writeFile(resolve(directory, `${command}-warnings.txt`), stderr);
  return Buffer.concat(chunks).toString();
}
const dk = (args, options) => run("docker", [...docker, ...args], options);
function sourceArgs(tool, args = []) {
  return [
    ...kube,
    "exec",
    "-i",
    sourcePod,
    "--",
    "sh",
    "-c",
    'tool="$1"; shift; exec "$tool" "$@" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
    "restore-rehearsal",
    tool,
    ...args,
  ];
}
const psqlOptions = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-P", "pager=off"];
const sourceSql = (sql) =>
  run("kubectl", sourceArgs("psql", psqlOptions), { input: sql });
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
function snapshotSql(snapshot, sql) {
  ensure(/^[0-9A-Fa-f-]+$/.test(snapshot), "Unexpected snapshot identifier");
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '${snapshot}';\nSET LOCAL timezone='UTC';\nSET LOCAL statement_timeout='30s';\n${sql}\nCOMMIT;\n`;
}
function digestSql(tables) {
  // Current database is small: compare every column of every user-table row.
  const selections = tables.map(({ schema, name }) => {
    const key = JSON.stringify([schema, name]).replaceAll("'", "''");
    return `SELECT '${key}'::text AS table_key, count(*)::text AS rows,
      encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text, E'\\n'
        ORDER BY to_jsonb(t)::text COLLATE "C"), ''), 'UTF8')), 'hex') AS sha256
      FROM ${quote(schema)}.${quote(name)} AS t`;
  });
  ensure(selections.length > 0, "No user tables found");
  return `SELECT coalesce(json_agg(x ORDER BY table_key), '[]'::json) FROM (${selections.join(" UNION ALL ")}) x;`;
}
function canonicalSchema(text) {
  // pg_dump 18 emits a fresh psql restriction token for each plain-text export.
  return text
    .split("\n")
    .filter((line) => !/^\\(?:un)?restrict\s/.test(line))
    .join("\n");
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function save(name, value) {
  await writeFile(
    resolve(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}
async function checkSource() {
  const result = { time: new Date().toISOString(), responses: [] };
  for (const [host, path] of [
    ["go.localhost", "/healthz"],
    ["go.localhost", "/readyz"],
    ["app.localhost", "/"],
  ]) {
    try {
      const started = performance.now();
      // Use HTTP directly: fetch may discard an overridden Host header.
      const status = await new Promise((resolveStatus, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: 8080,
            path,
            headers: { host: `${host}:8080` },
            signal: AbortSignal.timeout(3000),
          },
          (res) => {
            res.resume();
            res.once("end", () => resolveStatus(res.statusCode));
            res.once("error", reject);
          },
        );
        req.once("error", reject);
        req.end();
      });
      result.responses.push({
        host,
        path,
        status,
        ms: performance.now() - started,
      });
    } catch {
      result.responses.push({ host, path, status: null });
    }
  }
  observations.push(result);
  return result.responses.every((response) => response.status === 200);
}
async function exportSnapshot() {
  const { child, done } = launch("kubectl", sourceArgs("psql", psqlOptions));
  snapshotProcess = child;
  child.stdin.on("error", () => {});
  snapshotDone = done;
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const snapshot = await new Promise((resolveSnapshot, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Snapshot export timed out")),
      10000,
    );
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolveSnapshot(line.trim());
    });
    done.catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      "SET idle_in_transaction_session_timeout='60s';\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n",
    );
  });
  ensure(/^[0-9A-Fa-f-]+$/.test(snapshot), "Unexpected exported snapshot");
  return snapshot;
}
async function releaseSnapshot() {
  if (!snapshotProcess) return;
  if (snapshotProcess.exitCode === null && !snapshotProcess.killed)
    snapshotProcess.stdin.end("ROLLBACK;\n\\q\n");
  await snapshotDone;
  snapshotProcess = undefined;
}
async function sequenceState() {
  const {
    rows: [row],
  } = await client.query(`SELECT
    (SELECT coalesce(max(id),0)::text FROM public.links) AS max_id,
    pg_get_serial_sequence('public.links','id') AS sequence`);
  // Resolve and quote through pg_class instead of accepting a SQL fragment.
  const {
    rows: [seq],
  } = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name,
    s.seqincrement::text AS increment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=$1::regclass`,
    [row.sequence],
  );
  ensure(
    seq && BigInt(seq.increment) > 0n,
    "Expected an increasing identity sequence",
  );
  const {
    rows: [state],
  } = await client.query(
    `SELECT last_value::text, is_called FROM ${quote(seq.schema)}.${quote(seq.name)}`,
  );
  const next =
    BigInt(state.last_value) + (state.is_called ? BigInt(seq.increment) : 0n);
  return {
    ...row,
    ...state,
    next: next.toString(),
    safe: next > BigInt(row.max_id),
  };
}
async function verifyApplication() {
  const requireApp = createRequire(
    new URL("../apps/redirect-service/package.json", import.meta.url),
  );
  const { Client } = requireApp("pg");
  const { buildApp } = requireApp("./dist/app.js");
  const port = (await dk(["port", container, "5432/tcp"])).trim();
  ensure(/^127\.0\.0\.1:\d+$/.test(port), "Restore port must be loopback-only");
  const password = process.env.SHORTLINK_RESTORE_PASSWORD;
  const url = new URL(`postgresql://${port}/restore_test`);
  url.username = "restore_user";
  url.password = password;
  client = new Client({ connectionString: url.href });
  await client.connect();
  await client.query("SET timezone='UTC'");
  const {
    rows: [restored],
  } = await client.query(report.digestSql);
  assert.deepEqual(
    restored.coalesce,
    report.sourceTables,
    "Restored table contents differ from the source snapshot",
  );
  report.checks.allTableContents = true;
  const state = await sequenceState();
  ensure(state.safe, "Restored identity sequence could reuse an existing ID");
  report.sequenceBeforeTest = state;

  // Negative control: prove a changed destination row is detected, then roll it back.
  await client.query("BEGIN");
  await client.query(
    "UPDATE public.links SET target_url='https://example.com/restore-negative-control' WHERE id=(SELECT min(id) FROM public.links)",
  );
  const {
    rows: [changed],
  } = await client.query(report.digestSql);
  ensure(
    JSON.stringify(changed.coalesce) !== JSON.stringify(report.sourceTables),
    "Content verification failed to detect the negative control",
  );
  await client.query("ROLLBACK");
  report.checks.detectsChangedData = true;

  // Sequence state is not transactional: change and restore it explicitly on the clone.
  await client.query("SELECT setval($1::regclass, 1, false)", [state.sequence]);
  try {
    ensure(
      !(await sequenceState()).safe,
      "Sequence verification missed the negative control",
    );
  } finally {
    await client.query("SELECT setval($1::regclass, $2::bigint, $3::boolean)", [
      state.sequence,
      state.last_value,
      state.is_called,
    ]);
  }
  report.checks.detectsUnsafeSequence = true;

  app = buildApp(url.href, { poolMax: 2, redisUrl: "" });
  app.log.level = "silent";
  const { rows: existing } = await client.query(
    "SELECT code,target_url FROM public.links ORDER BY id LIMIT 10",
  );
  ensure(existing.length > 0, "Expected existing links in this exercise");
  for (const row of existing) {
    const response = await app.inject(`/${row.code}`);
    ensure(
      response.statusCode === 302 &&
        response.headers.location === row.target_url &&
        response.headers["cache-control"] === "no-store",
      "An existing restored link did not redirect correctly",
    );
  }
  report.checks.existingRedirects = existing.length;
  const creations = [
    await app.inject({
      method: "POST",
      url: "/links",
      payload: { targetUrl: "https://example.com/restored-rest" },
    }),
    await app.inject({
      method: "POST",
      url: "/graphql",
      payload: {
        query:
          'mutation { createLink(input: { targetUrl: "https://example.com/restored-graphql" }) { code } }',
      },
    }),
  ];
  ensure(
    creations[0].statusCode === 201,
    "REST creation on restored database failed",
  );
  const graphql = creations[1].json();
  ensure(
    creations[1].statusCode === 200 &&
      !graphql.errors &&
      graphql.data?.createLink?.code,
    "GraphQL creation on restored database failed",
  );
  const codes = [creations[0].json().code, graphql.data.createLink.code];
  for (let i = 0; i < codes.length; i++) {
    ensure(
      /^[A-Za-z0-9_-]{8}$/.test(codes[i]),
      "New code has an unexpected format",
    );
    const response = await app.inject(`/${codes[i]}`);
    ensure(
      response.statusCode === 302 &&
        response.headers.location ===
          `https://example.com/restored-${i ? "graphql" : "rest"}` &&
        response.headers["cache-control"] === "no-store",
      "A newly created restored link did not redirect correctly",
    );
  }
  const { rows: written } = await client.query(
    "SELECT id::text FROM public.links WHERE code=ANY($1::text[])",
    [codes],
  );
  ensure(
    written.length === 2 &&
      written.every((row) => BigInt(row.id) > BigInt(state.max_id)),
    "Creation did not advance beyond restored identities",
  );
  const {
    rows: [count],
  } = await client.query("SELECT count(*)::text AS count FROM public.links");
  const sourceLinks = report.sourceTables.find(
    (row) => row.table_key === JSON.stringify(["public", "links"]),
  );
  ensure(
    BigInt(count.count) === BigInt(sourceLinks.rows) + 2n,
    "Unexpected restored link count after creation",
  );
  report.checks.restAndGraphqlCreation = true;
  report.checks.identityAdvances = true;
  try {
    await client.query(
      "INSERT INTO public.links(code,target_url) VALUES($1,$2)",
      [codes[0], "https://example.com/duplicate"],
    );
    throw new Error(
      "Restored code uniqueness constraint did not reject a duplicate",
    );
  } catch (error) {
    ensure(
      error.code === "23505" && error.constraint === "links_code_unique",
      "Unexpected duplicate-code result",
    );
  }
  report.checks.uniqueCodeConstraint = true;
  ensure(
    (await app.inject("/restore-missing-code")).statusCode === 404,
    "Missing-code behavior changed",
  );
  ensure(
    (await app.inject("/readyz")).statusCode === 200,
    "Restored application readiness failed",
  );
  report.checks.missingCodeAndReadiness = true;
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try {
  report.sourceCommit = (await run("git", ["rev-parse", "HEAD"])).trim();
  const pods = JSON.parse(
    await run("kubectl", [
      ...kube,
      "get",
      "pods",
      "-l",
      "app=postgres",
      "-o",
      "json",
    ]),
  ).items;
  ensure(
    pods.length === 1 && pods[0].status.containerStatuses?.[0]?.ready,
    "Expected one ready source Postgres pod",
  );
  sourcePod = pods[0].metadata.name;
  report.source = {
    context: "kind-shortlink",
    namespace: "shortlink",
    pod: sourcePod,
    uid: pods[0].metadata.uid,
  };
  const digest = pods[0].status.containerStatuses[0].imageID;
  ensure(
    /^sha256:[a-f0-9]{64}$/.test(digest),
    "Unexpected source image identity",
  );
  report.source.runtimeImageID = digest;
  const tag = pods[0].spec.containers[0].image;
  ensure(
    /^postgres:\d+\.\d+$/.test(tag),
    "Expected the official source Postgres image",
  );
  const reference = `docker.io/library/${tag}`;
  // CRI imageID can be a configuration hash, not a pullable registry manifest.
  // Resolve the actual manifest from the source kind node's containerd metadata.
  const images = await dk([
    "exec",
    pods[0].spec.nodeName,
    "ctr",
    "--namespace",
    "k8s.io",
    "images",
    "list",
    `name==${reference}`,
  ]);
  const entry = images
    .split("\n")
    .find((line) => line.startsWith(`${reference} `));
  const manifest = entry?.trim().split(/\s+/)[2];
  ensure(
    /^sha256:[a-f0-9]{64}$/.test(manifest ?? ""),
    "Could not resolve the source registry manifest",
  );
  report.postgresImage = `docker.io/library/postgres@${manifest}`;
  // Pull/resolve the clone image before opening a source transaction.
  await dk(["pull", report.postgresImage]);
  ensure(
    await checkSource(),
    "Existing service was unhealthy before rehearsal",
  );
  monitor = (async () => {
    while (!finishMonitor && !interrupted) {
      await checkSource();
      await delay(1000);
    }
  })();
  console.log(
    "Exporting a source snapshot and backup; existing requests keep running.",
  );
  const snapshot = await exportSnapshot();
  report.snapshot = snapshot;
  const tableQuery = `SELECT coalesce(json_agg(x ORDER BY schema,name),'[]'::json) FROM
    (SELECT schemaname AS schema,tablename AS name FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname !~ '^pg_toast') x;`;
  const tables = JSON.parse(await sourceSql(snapshotSql(snapshot, tableQuery)));
  report.digestSql = digestSql(tables);
  report.sourceTables = JSON.parse(
    await sourceSql(snapshotSql(snapshot, report.digestSql)),
  );
  const schemaArgs = [
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--quote-all-identifiers",
    `--snapshot=${snapshot}`,
    "--lock-wait-timeout=5s",
  ];
  const sourceSchema = await run("kubectl", sourceArgs("pg_dump", schemaArgs));
  await writeFile(resolve(directory, "source-schema.sql"), sourceSchema, {
    mode: 0o600,
  });
  report.sourceSchemaSha256 = hash(canonicalSchema(sourceSchema));
  const backupStarted = performance.now();
  const partial = `${archive}.partial`;
  await run(
    "kubectl",
    sourceArgs("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--snapshot=${snapshot}`,
      "--lock-wait-timeout=5s",
    ]),
    { output: partial },
  );
  await rename(partial, archive);
  report.backupMs = performance.now() - backupStarted;
  const data = await readFile(archive);
  ensure(
    data.subarray(0, 5).toString() === "PGDMP",
    "Backup is not a custom-format Postgres archive",
  );
  report.archive = {
    name: "shortener.dump",
    bytes: (await stat(archive)).size,
    sha256: hash(data),
  };
  await save("source-manifest.json", {
    snapshot,
    tables: report.sourceTables,
    schemaSha256: report.sourceSchemaSha256,
    archive: report.archive,
  });
  await releaseSnapshot();

  console.log(
    "Restoring into a fresh, memory-limited container; all test writes target the clone.",
  );
  // Track attempts too: Docker may create a resource before its CLI fails.
  volumeCreated = true;
  await dk(["volume", "create", "--label", label, "--label", runLabel, volume]);
  const password = randomBytes(24).toString("hex");
  process.env.SHORTLINK_RESTORE_PASSWORD = password;
  containerCreated = true;
  await dk(
    [
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--label",
      runLabel,
      "--memory=512m",
      "--cpus=1",
      "--publish",
      "127.0.0.1::5432",
      "--mount",
      `type=volume,source=${volume},target=/var/lib/postgresql`,
      "--env",
      "POSTGRES_USER=restore_user",
      "--env",
      "POSTGRES_DB=restore_test",
      "--env",
      "POSTGRES_PASSWORD",
      report.postgresImage,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ensure(!interrupted, "Rehearsal interrupted");
    // initdb briefly starts a socket-only server: wait for the final TCP listener.
    try {
      await dk([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "restore_user",
        "-d",
        "restore_test",
      ]);
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  ensure(ready, "Restore container did not become ready");
  const startedRestore = performance.now();
  await dk(
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      "--username=restore_user",
      "--dbname=restore_test",
    ],
    { input: createReadStream(archive) },
  );
  report.restoreMs = performance.now() - startedRestore;
  const restoredSchema = await dk([
    "exec",
    container,
    "pg_dump",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--quote-all-identifiers",
    "--username=restore_user",
    "--dbname=restore_test",
  ]);
  await writeFile(resolve(directory, "restored-schema.sql"), restoredSchema, {
    mode: 0o600,
  });
  report.restoredSchemaSha256 = hash(canonicalSchema(restoredSchema));
  ensure(
    report.restoredSchemaSha256 === report.sourceSchemaSha256,
    "Restored schema differs from the source snapshot",
  );
  report.checks.schema = true;
  await verifyApplication();
  ensure(
    await checkSource(),
    "Existing service was unhealthy after verification",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  cleaningUp = true;
  finishMonitor = true;
  await monitor;
  if (
    observations.some((sample) =>
      sample.responses.some((response) => response.status !== 200),
    )
  ) {
    report.passed = false;
    report.error ??= "Source health observations failed during rehearsal";
    process.exitCode = 1;
  }
  const cleanup = [];
  for (const [name, action] of [
    ["application", () => app?.close()],
    ["verificationClient", () => client?.end()],
    ["sourceSnapshot", releaseSnapshot],
    [
      "restoreContainer",
      async () => {
        if (containerCreated) {
          const owner = (
            await dk([
              "inspect",
              "--format",
              '{{index .Config.Labels "shortlink.rehearsal"}}',
              container,
            ])
          ).trim();
          ensure(
            owner === stamp,
            "Refusing to remove a container not owned by this rehearsal",
          );
          try {
            await dk(["logs", container], {
              output: resolve(directory, "restore-container.log"),
            });
          } finally {
            await dk(["rm", "--force", container]);
          }
        }
      },
    ],
    [
      "restoreVolume",
      async () => {
        if (volumeCreated) {
          const owner = (
            await dk([
              "volume",
              "inspect",
              "--format",
              '{{index .Labels "shortlink.rehearsal"}}',
              volume,
            ])
          ).trim();
          ensure(
            owner === stamp,
            "Refusing to remove a volume not owned by this rehearsal",
          );
          await dk(["volume", "rm", volume]);
        }
      },
    ],
  ]) {
    try {
      await action();
      cleanup.push({ name, passed: true });
    } catch (error) {
      cleanup.push({ name, passed: false, error: error.message });
      report.passed = false;
      process.exitCode = 1;
    }
  }
  delete process.env.SHORTLINK_RESTORE_PASSWORD;
  report.cleanup = cleanup;
  report.completedAt = new Date().toISOString();
  report.sourceHealthSamples = observations.length;
  delete report.digestSql;
  await save("source-health.json", observations);
  await save("result.json", report);
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        directory,
        backup: report.archive,
        backupMs: report.backupMs,
        restoreMs: report.restoreMs,
        checks: report.checks,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
