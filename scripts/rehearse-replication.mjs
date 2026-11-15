import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  appGet,
  appKube,
  dbGet,
  dbKube,
  directory,
  ensure,
  hash,
  run,
  sourceState,
  vmAddresses,
} from "./lib/db-lab-connectivity.mjs";

const id = randomUUID().replaceAll("-", "");
const name = `replication-fixture-${id.slice(0, 12)}`;
const database = `migration_rehearsal_${id.slice(0, 12)}`;
const subscription = `fixture_${id.slice(0, 12)}`;
const label = `shortlink.dev/replication-run=${id}`;
const path = await directory("replication-rehearsals");
const config = JSON.parse(
  await readFile("deploy/migration/rehearsal.json", "utf8"),
);
const report = {
  startedAt: new Date().toISOString(),
  runId: id,
  passed: false,
  checks: {},
};
let publisherCreated = false;
let volumeCreated = false;
let databaseCreated = false;
let primary;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });
const sourceDocker = (args, input) =>
  run("docker", ["--context", "colima", ...args], input);
const sourceSql = (text) =>
  appKube(
    [
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
    ],
    text,
  );
const publisherSql = (text) =>
  sourceDocker(
    [
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "fixture_admin",
      "-d",
      "migration_fixture",
    ],
    `SET statement_timeout='8s';\n${text}`,
  );
const destinationSql = (text, db = database) =>
  dbKube(
    [
      "exec",
      "-i",
      primary,
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      db,
    ],
    `SET statement_timeout='10s';\n${text}`,
  );
const sourceReplicationState = async () =>
  JSON.parse(
    await sourceSql(
      "SELECT json_build_object('wal_level',current_setting('wal_level'),'ssl',current_setting('ssl'),'slots',(SELECT count(*) FROM pg_replication_slots),'publications',(SELECT count(*) FROM pg_publication),'subscriptions',(SELECT count(*) FROM pg_subscription));",
    ),
  );
const digestSql = `SET timezone='UTC'; SELECT json_build_object(
  'links_count',(SELECT count(*) FROM public.links),
  'links',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') FROM public.links t),
  'history_count',(SELECT count(*) FROM drizzle.__drizzle_migrations),
  'history',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),''),'UTF8')),'hex') FROM drizzle.__drizzle_migrations t));`;
async function compare(phase) {
  const expected = JSON.parse(await publisherSql(digestSql));
  let actual;
  for (let i = 0; i < 80; i++) {
    ensure(!interrupted, "Replication rehearsal interrupted");
    actual = JSON.parse(await destinationSql(digestSql));
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      report.checks[phase] = { passed: true, digest: actual };
      return;
    }
    await delay(250);
  }
  throw new Error(`Fixture content mismatch during ${phase}`);
}
try {
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host memory pressure is not normal",
  );
  report.sourceBefore = await sourceState();
  report.sourceReplicationBefore = await sourceReplicationState();
  report.sourcePostgresSpecHash = hash(
    (await appGet(["get", "deployment", "postgres"])).spec,
  );
  report.addresses = await vmAddresses();
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three healthy destination instances",
  );
  primary = cluster.status.currentPrimary;
  report.primary = primary;
  report.publisherImage = config.publisherImage;
  const staged = JSON.parse(
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
  const publisherArgs = staged.spec.template.spec.containers.find(
    (c) => c.name === "postgres",
  ).args;
  ensure(
    publisherArgs[0] === "postgres" &&
      publisherArgs.includes("wal_level=logical"),
    "Unexpected staged publisher arguments",
  );
  report.rehearsedPublisherArgs = publisherArgs;

  report.stage = "publisher-bootstrap";
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
    "--quote-all-identifiers",
    "--lock-wait-timeout=2s",
  ]);
  await writeFile(`${path}/fixture-schema.sql`, schema);
  const tlsDir = resolve(path, "tls");
  await mkdir(tlsDir, { mode: 0o700 });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-days",
    "2",
    "-subj",
    `/CN=${config.tlsHostname}`,
    "-addext",
    `subjectAltName=DNS:${config.tlsHostname}`,
    "-keyout",
    `${tlsDir}/server.key`,
    "-out",
    `${tlsDir}/server.crt`,
  ]);
  const password = randomBytes(24).toString("hex");
  const adminPassword = randomBytes(24).toString("hex");
  const envFile = resolve(path, "publisher.env");
  await writeFile(
    envFile,
    `POSTGRES_USER=fixture_admin\nPOSTGRES_DB=migration_fixture\nPOSTGRES_PASSWORD=${adminPassword}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${tlsDir}/pg_hba.conf`,
    "local all all trust\nhostssl migration_fixture fixture_repl all scram-sha-256\nhost all all all reject\n",
  );
  await sourceDocker(["volume", "create", "--label", label, `${name}-data`]);
  volumeCreated = true;
  await sourceDocker([
    "create",
    "--name",
    name,
    "--label",
    label,
    "--publish",
    `${report.addresses.application}:${config.privatePort}:5432`,
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--env-file",
    envFile,
    "--mount",
    `type=volume,src=${name}-data,dst=/var/lib/postgresql`,
    config.publisherImage,
    "sh",
    "-c",
    'chown postgres:postgres /tmp/fixture.key; chmod 600 /tmp/fixture.key; exec docker-entrypoint.sh "$@"',
    "--",
    ...publisherArgs,
    "-c",
    "ssl=on",
    "-c",
    "ssl_cert_file=/tmp/fixture.crt",
    "-c",
    "ssl_key_file=/tmp/fixture.key",
    "-c",
    "hba_file=/tmp/fixture-hba.conf",
  ]);
  publisherCreated = true;
  await rm(envFile);
  for (const [local, remote] of [
    ["server.key", "fixture.key"],
    ["server.crt", "fixture.crt"],
    ["pg_hba.conf", "fixture-hba.conf"],
  ]) {
    await chmod(`${tlsDir}/${local}`, local === "server.key" ? 0o600 : 0o644);
    await sourceDocker(["cp", `${tlsDir}/${local}`, `${name}:/tmp/${remote}`]);
  }
  await sourceDocker(["start", name]);
  let available = false;
  for (let i = 0; i < 40; i++) {
    ensure(!interrupted, "Replication rehearsal interrupted");
    try {
      available = (await publisherSql("SELECT 1;")).trim() === "1";
      if (available) break;
    } catch {
      /* The newly initialized disposable server is not ready yet. */
    }
    await delay(500);
  }
  ensure(available, "Disposable publisher did not become ready");
  await publisherSql(schema);
  await publisherSql(`
    INSERT INTO links(id,code,target_url,created_at) OVERRIDING SYSTEM VALUE VALUES
      (41,'fixtureA','https://example.test/a','2026-11-14T00:00:00Z'),
      (42,'fixtureB','https://example.test/b','2026-11-14T00:00:00Z');
    INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES (7,'fixture-history',1);
    SELECT setval('public.links_id_seq',1000,true);
    SELECT setval('drizzle.__drizzle_migrations_id_seq',2000,true);

  `);
  const publicationSql = (
    await readFile("deploy/migration/source-publication.sql", "utf8")
  )
    .replaceAll("shortener", "migration_fixture")
    .replaceAll("shortlink_migrator", "fixture_repl")
    .replaceAll("shortlink_migration", "fixture_publication");
  await publisherSql(publicationSql);
  await publisherSql(`ALTER ROLE fixture_repl PASSWORD '${password}';`);
  const privileges = JSON.parse(
    await publisherSql(
      "SELECT json_build_object('select',has_table_privilege('fixture_repl','public.links','SELECT'),'insert',has_table_privilege('fixture_repl','public.links','INSERT'),'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname='fixture_repl'));",
    ),
  );
  ensure(
    privileges.select && !privileges.insert && !privileges.superuser,
    "Unexpected fixture replication-role privileges",
  );
  report.checks.replicationRole = privileges;

  report.stage = "initial-copy";
  await destinationSql(
    `CREATE DATABASE ${database} OWNER shortlink_lab;`,
    "postgres",
  );
  databaseCreated = true;
  await destinationSql(`SET ROLE shortlink_lab;\n${schema}\nRESET ROLE;`);
  const certPath = `/controller/run/${name}.crt`;
  const passPath = `/controller/run/${name}.pgpass`;
  await dbKube(
    ["exec", "-i", primary, "--", "sh", "-c", `umask 077; cat > ${certPath}`],
    await readFile(`${tlsDir}/server.crt`, "utf8"),
  );
  await dbKube(
    ["exec", "-i", primary, "--", "sh", "-c", `umask 077; cat > ${passPath}`],
    `${config.tlsHostname}:${config.privatePort}:migration_fixture:fixture_repl:${password}\n`,
  );
  const connection = `host=${config.tlsHostname} hostaddr=${report.addresses.application} port=${config.privatePort} dbname=migration_fixture user=fixture_repl passfile=${passPath} sslmode=verify-full sslrootcert=${certPath} connect_timeout=3 application_name=${subscription}`;
  const subscriptionSql = (
    await readFile("deploy/migration/destination-subscription.sql", "utf8")
  )
    .replaceAll("shortlink_migration_sub", subscription)
    .replaceAll("shortlink_migration", "fixture_publication")
    .replace(":'source_conninfo'", `'${connection}'`);
  await destinationSql(subscriptionSql);
  report.checks.stagedSqlRehearsed = true;
  await compare("initialCopy");
  report.subscriptionRelations = JSON.parse(
    await destinationSql(
      `SELECT json_agg(x) FROM (SELECT srrelid::regclass::text AS relation,srsubstate AS state FROM pg_subscription_rel WHERE srsubid=(SELECT oid FROM pg_subscription WHERE subname='${subscription}'))x;`,
    ),
  );
  ensure(
    report.subscriptionRelations.length === 2 &&
      report.subscriptionRelations.every((r) => r.state === "r"),
    "Initial table synchronization is not ready",
  );

  report.stage = "ongoing-changes";
  await publisherSql(
    `BEGIN; INSERT INTO links(code,target_url) VALUES('fixtureC','https://example.test/c'); UPDATE links SET target_url='https://example.test/a-updated' WHERE code='fixtureA'; DELETE FROM links WHERE code='fixtureB'; INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES('fixture-history-next',2); COMMIT; BEGIN; INSERT INTO links(code,target_url) VALUES('rolledBack','https://example.test/rollback'); ROLLBACK;`,
  );
  await compare("transactionalChanges");
  report.publisherSession = JSON.parse(
    await publisherSql(
      `SELECT json_agg(x) FROM (SELECT r.application_name,r.state,s.ssl FROM pg_stat_replication r JOIN pg_stat_ssl s ON s.pid=r.pid WHERE r.application_name='${subscription}')x;`,
    ),
  );
  ensure(
    report.publisherSession?.some((s) => s.state === "streaming" && s.ssl),
    "Logical stream was not observed over TLS",
  );

  report.stage = "pause-resume";
  await destinationSql(`ALTER SUBSCRIPTION ${subscription} DISABLE;`);
  for (let i = 0; i < 20; i++) {
    const active = (
      await publisherSql(
        `SELECT active FROM pg_replication_slots WHERE slot_name='${subscription}';`,
      )
    ).trim();
    if (active === "f") break;
    ensure(
      i < 19,
      "Disabled subscription's publisher connection remained active",
    );
    await delay(100);
  }
  await publisherSql(
    "INSERT INTO links(code,target_url) VALUES('whilePaused','https://example.test/paused');",
  );
  ensure(
    (
      await destinationSql(
        "SELECT EXISTS(SELECT 1 FROM links WHERE code='whilePaused');",
      )
    ).trim() === "f",
    "Disabled subscriber unexpectedly received a later write",
  );
  report.slotWhilePaused = JSON.parse(
    await publisherSql(
      `SELECT json_build_object('slot',slot_name,'active',active,'status',wal_status,'retainedBytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::text) FROM pg_replication_slots WHERE slot_name='${subscription}';`,
    ),
  );
  ensure(
    report.slotWhilePaused && Number(report.slotWhilePaused.retainedBytes) > 0,
    "Did not observe retained WAL while subscriber was paused",
  );
  await destinationSql(`ALTER SUBSCRIPTION ${subscription} ENABLE;`);
  await compare("catchUpAfterPause");

  report.stage = "sequence-rehearsal";
  const sequences = JSON.parse(
    await destinationSql(
      "SELECT json_build_object('linksLast',(SELECT last_value::text FROM public.links_id_seq),'linksCalled',(SELECT is_called FROM public.links_id_seq),'maxLink',(SELECT max(id)::text FROM links),'historyLast',(SELECT last_value::text FROM drizzle.__drizzle_migrations_id_seq),'historyCalled',(SELECT is_called FROM drizzle.__drizzle_migrations_id_seq),'maxHistory',(SELECT max(id)::text FROM drizzle.__drizzle_migrations));",
    ),
  );
  ensure(
    sequences.linksLast === "1" &&
      !sequences.linksCalled &&
      sequences.historyLast === "1" &&
      !sequences.historyCalled,
    "Expected logical copy to leave target sequences at their initial state",
  );
  report.checks.sequencesNotReplicated = sequences;
  // Only the fixture changes writer here. No live application writer is moved.
  await destinationSql(`DROP SUBSCRIPTION ${subscription};`);
  ensure(
    (
      await publisherSql("SELECT count(*) FROM pg_replication_slots;")
    ).trim() === "0",
    "Dropping the fixture subscription left a publisher slot",
  );
  await destinationSql(
    "SELECT setval('public.links_id_seq',(SELECT max(id) FROM links),true); SELECT setval('drizzle.__drizzle_migrations_id_seq',(SELECT max(id) FROM drizzle.__drizzle_migrations),true);",
  );
  const allocated = JSON.parse(
    await destinationSql(
      "WITH l AS (INSERT INTO links(code,target_url) VALUES('targetOnly','https://example.test/target') RETURNING id), h AS (INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES('target-history',3) RETURNING id) SELECT json_build_object('linkId',(SELECT id::text FROM l),'historyId',(SELECT id::text FROM h));",
    ),
  );
  ensure(
    BigInt(allocated.linkId) > BigInt(sequences.maxLink) &&
      BigInt(allocated.historyId) > BigInt(sequences.maxHistory),
    "Corrected sequences did not allocate safely",
  );
  report.checks.sequenceCorrection = allocated;
  report.sourceAfter = await sourceState();
  report.sourceReplicationAfter = await sourceReplicationState();
  ensure(
    JSON.stringify(report.sourceReplicationBefore) ===
      JSON.stringify(report.sourceReplicationAfter),
    "Live source replication settings/objects changed",
  );
  ensure(
    report.sourceBefore.deploymentSpecHash ===
      report.sourceAfter.deploymentSpecHash &&
      report.sourcePostgresSpecHash ===
        hash((await appGet(["get", "deployment", "postgres"])).spec),
    "Live application or Postgres deployment specification changed",
  );
  ensure(
    (await dbGet(["get", "cluster", "shortlink-lab"])).status.currentPrimary ===
      primary,
    "Destination primary changed during the fixture run; requalify the result",
  );
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host memory pressure rose during the rehearsal",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.cleanupErrors = [];
  if (databaseCreated) {
    try {
      const found = (
        await destinationSql(
          `SELECT count(*) FROM pg_subscription WHERE subname='${subscription}' AND subdbid=(SELECT oid FROM pg_database WHERE datname=current_database());`,
        )
      ).trim();
      if (found === "1")
        await destinationSql(
          `ALTER SUBSCRIPTION ${subscription} DISABLE; ALTER SUBSCRIPTION ${subscription} SET (slot_name=NONE); DROP SUBSCRIPTION ${subscription};`,
        );
      await destinationSql(
        `DROP DATABASE ${database} WITH (FORCE);`,
        "postgres",
      );
      await dbKube([
        "exec",
        primary,
        "--",
        "rm",
        "-f",
        `/controller/run/${name}.crt`,
        `/controller/run/${name}.pgpass`,
      ]);
      ensure(
        (
          await destinationSql(
            `SELECT count(*) FROM pg_database WHERE datname='${database}';`,
            "postgres",
          )
        ).trim() === "0",
        "Fixture database remains",
      );
    } catch (error) {
      report.cleanupErrors.push(error.message);
    }
  }
  for (const [kind, resource, created] of [
    ["container", name, publisherCreated],
    ["volume", `${name}-data`, volumeCreated],
  ]) {
    if (!created) continue;
    try {
      const [object] = JSON.parse(
        await sourceDocker([kind, "inspect", resource]),
      );
      ensure(
        (kind === "container" ? object.Config.Labels : object.Labels)[
          "shortlink.dev/replication-run"
        ] === id,
        "Refusing to remove a resource belonging to another run",
      );
      await sourceDocker(
        kind === "container"
          ? ["rm", "-f", resource]
          : ["volume", "rm", resource],
      );
    } catch (error) {
      report.cleanupErrors.push(error.message);
    }
  }
  await rm(resolve(path, "tls"), { recursive: true, force: true });
  await rm(resolve(path, "publisher.env"), { force: true });
  report.cleanupPassed = report.cleanupErrors.length === 0;
  if (!report.cleanupPassed) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      cleanupPassed: report.cleanupPassed,
      evidence: `${path}/result.json`,
    }),
  );
}
