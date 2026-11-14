// Runs inside one disposable Pod. It connects to the real primary Service.
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = createRequire("/app/apps/redirect-service/package.json")(
  "pg",
);
const started = performance.now();
const runId = process.env.PROBE_RUN;
const duration = Number(process.env.PROBE_DURATION_MS);
const clients = { writer: null, reader: null };
const totals = {
  writer: { ok: 0, ambiguous: 0, not_sent: 0 },
  reader: { ok: 0, failed: 0 },
};
let stop = false;
const emit = (event) =>
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      ...event,
    }),
  );
process.on("SIGTERM", () => {
  stop = true;
});
const options = {
  host: process.env.PGHOST,
  port: 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: {
    ca: readFileSync("/exercise-ca/ca.crt", "utf8"),
    rejectUnauthorized: true,
  },
  connectionTimeoutMillis: 1000,
  query_timeout: 2500,
  options: "-c statement_timeout=2000",
};
async function discard(role, client) {
  if (!client) return;
  if (clients[role] === client) clients[role] = null;
  await client.end().catch(() => {});
}
async function connection(role) {
  if (clients[role]) return clients[role];
  const client = new Client({
    ...options,
    application_name: `switchover-${role}`,
  });
  client.on("error", (error) => {
    emit({
      type: "connection",
      role,
      event: "error",
      code: error.code ?? error.name,
    });
    void discard(role, client);
  });
  try {
    await client.connect();
  } catch (error) {
    await discard(role, client);
    throw error;
  }
  clients[role] = client;
  emit({ type: "connection", role, event: "connected" });
  return client;
}
async function operation(role, sequence) {
  const token = `${runId}:${sequence}`;
  const begin = performance.now();
  let client;
  let sent = false;
  try {
    client = await connection(role);
    sent = true;
    const query =
      role === "writer"
        ? {
            text: "INSERT INTO replication_probe(token) VALUES($1) RETURNING token,id::text,host(inet_server_addr()) AS server",
            values: [token],
          }
        : {
            text: "SELECT host(inet_server_addr()) AS server,pg_is_in_recovery() AS recovery,(SELECT count(*)::text FROM replication_probe WHERE token LIKE $1) AS observed",
            values: [`${runId}:%`],
          };
    const {
      rows: [row],
    } = await client.query(query);
    if (role === "reader" && row.recovery) {
      const error = new Error(
        "Reader is still connected to the former primary",
      );
      error.code = "READ_ONLY_TARGET";
      throw error;
    }
    totals[role].ok++;
    emit({
      type: "operation",
      role,
      sequence,
      status: "ok",
      token: role === "writer" ? token : undefined,
      server: row.server,
      durationMs: performance.now() - begin,
    });
  } catch (error) {
    const status =
      role === "writer" ? (sent ? "ambiguous" : "not_sent") : "failed";
    totals[role][status]++;
    emit({
      type: "operation",
      role,
      sequence,
      status,
      token: role === "writer" ? token : undefined,
      code: error.code ?? error.name,
      durationMs: performance.now() - begin,
    });
    // No write is retried. Resolve ambiguous tokens against the final database.
    await discard(role, client);
  }
}
async function loop(role) {
  let sequence = 0;
  while (!stop && performance.now() - started < duration) {
    const begin = performance.now();
    await operation(role, sequence++);
    // Closed-loop pacing: stalls reduce attempts; this is not an arrival-rate benchmark.
    await delay(Math.max(0, 100 - (performance.now() - begin)));
  }
}
(async () => {
  if (
    !/^[a-f0-9-]{36}$/.test(runId) ||
    !Number.isFinite(duration) ||
    duration < 20000 ||
    duration > 120000
  )
    throw new Error("Invalid probe configuration");
  await Promise.all([connection("writer"), connection("reader")]);
  emit({ type: "ready", host: options.host, durationMs: duration });
  await Promise.all([loop("writer"), loop("reader")]);
  await Promise.all(
    Object.entries(clients).map(([role, client]) => discard(role, client)),
  );
  emit({ type: "finished", totals });
})().catch((error) => {
  emit({ type: "fatal", code: error.code ?? error.name });
  process.exitCode = 1;
});
