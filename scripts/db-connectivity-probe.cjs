// Runs only in a disposable Pod in the existing application cluster.
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { rootCertificates } = require("node:tls");
const { Client } = createRequire("/app/apps/redirect-service/package.json")(
  "pg",
);
const ca = readFileSync("/exercise-ca/ca.crt", "utf8");
const options = {
  host: process.env.PGHOST,
  port: 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  application_name: "cross-vm-connectivity-probe",
  connectionTimeoutMillis: 3000,
  query_timeout: 3500,
  options: "-c statement_timeout=3000",
  ssl: { ca, rejectUnauthorized: true, servername: process.env.PGHOST },
};
const report = { passed: false, checks: {} };
async function rejected(name, overrides, acceptedCodes) {
  const client = new Client({ ...options, ...overrides });
  client.on("error", () => {});
  let errorCode;
  try {
    await client.connect();
  } catch (error) {
    errorCode = error.code ?? error.name;
  } finally {
    await client.end().catch(() => {});
  }
  if (!acceptedCodes.includes(errorCode))
    throw new Error(
      `${name} did not fail as expected (${errorCode ?? "connected"})`,
    );
  report.checks[name] = { rejected: true, code: errorCode };
}
(async () => {
  await rejected("plaintext", { ssl: false }, ["28000"]);
  await rejected("wrongHostname", { host: "incorrect.database.invalid" }, [
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]);
  await rejected(
    "untrustedCA",
    {
      ssl: {
        ca: rootCertificates[0],
        rejectUnauthorized: true,
        servername: options.host,
      },
    },
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    ],
  );
  await rejected(
    "wrongPassword",
    { password: `invalid-${process.env.PROBE_RUN}` },
    ["28P01"],
  );
  const client = new Client(options);
  client.on("error", () => {});
  try {
    await client.connect();
    const {
      rows: [session],
    } = await client.query(
      "SELECT current_user AS role, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser, pg_is_in_recovery() AS recovery, host(inet_server_addr()) AS server, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, current_setting('synchronous_commit') AS commit_policy, current_setting('synchronous_standby_names') AS standby_policy",
    );
    if (
      !session.tls ||
      session.superuser ||
      session.recovery ||
      session.role !== "shortlink_lab" ||
      session.commit_policy !== "on" ||
      !session.standby_policy.startsWith("ANY 1")
    )
      throw new Error("Unexpected primary session properties");
    report.session = session;
    const token = `connectivity-${process.env.PROBE_RUN}`;
    const {
      rows: [written],
    } = await client.query(
      "INSERT INTO replication_probe(token) VALUES($1) RETURNING id::text",
      [token],
    );
    const {
      rows: [read],
    } = await client.query("SELECT token FROM replication_probe WHERE id=$1", [
      written.id,
    ]);
    if (read?.token !== token)
      throw new Error("Written token did not read back");
    report.token = token;
    report.checks.tlsPrimaryWriteRead = true;
    report.passed = true;
  } finally {
    await client.end().catch(() => {});
  }
})()
  .catch((error) => {
    report.error = error.code ?? error.message;
    process.exitCode = 1;
  })
  .finally(() => console.log(JSON.stringify(report)));
