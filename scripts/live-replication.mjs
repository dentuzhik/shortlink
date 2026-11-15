import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  appKube,
  dbGet,
  directory,
  ensure,
  hash,
  run,
  sourceState,
} from "./lib/db-lab-connectivity.mjs";
import {
  config,
  digestSql,
  holdCopy,
  localeSql,
  primary,
  schemaSql,
  sourceSql,
  state,
  targetSql,
  watcher,
} from "./lib/live-replication.mjs";

ensure(
  config.database === "shortener" && config.localePolicy === "preserve-source",
  "Destination database/locale choice must be recorded before copying",
);
const mode = process.argv[2];
ensure(
  ["start", "verify", "status"].includes(mode),
  "Use start, verify or status",
);
const path = await directory(`live-replication-${mode}`);
const report = {
  startedAt: new Date().toISOString(),
  mode,
  passed: false,
  cohort: [],
};
let release;
let monitoring;
let finishMonitor = false;
let monitorError;
const timeline = [];
const save = (name, value) =>
  writeFile(`${path}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
async function observe() {
  const before = Date.now();
  try {
    const current = await state();
    const health = await sourceState();
    const fs = (
      await appKube([
        "exec",
        "deployment/postgres",
        "--",
        "sh",
        "-c",
        'df -Pk "$PGDATA"',
      ])
    ).trim();
    const free = Number(fs.split("\n").at(-1).trim().split(/\s+/)[3]) * 1024;
    ensure(free > 512 * 1024 * 1024, "Source disk headroom is below 512 MiB");
    timeline.push({
      time: new Date(before).toISOString(),
      ...current,
      sourceHealth: health,
      sourceAvailableBytes: free,
    });
  } catch (error) {
    timeline.push({
      time: new Date(before).toISOString(),
      error: error.message,
    });
    throw error;
  }
}
async function createLink(phase, transport) {
  const targetUrl = `https://example.test/migration/${report.runId}/${phase}-${transport}`;
  const graphql = transport === "graphql";
  const host = graphql ? "app.localhost" : "go.localhost";
  const body = graphql
    ? {
        query:
          "mutation($input:CreateLinkInput!){createLink(input:$input){code targetUrl createdAt}}",
        variables: { input: { targetUrl } },
      }
    : { targetUrl };
  const startedAt = new Date().toISOString();
  const output = await run(
    "curl",
    [
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--max-time",
      "5",
      "--resolve",
      `${host}:8080:127.0.0.1`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
      "--write-out",
      "\n%{http_code}",
      `http://${host}:8080/${graphql ? "graphql" : "links"}`,
    ],
    JSON.stringify(body),
  );
  const split = output.lastIndexOf("\n");
  const status = Number(output.slice(split + 1));
  const result = JSON.parse(output.slice(0, split));
  const link = graphql ? result.data?.createLink : result;
  ensure(
    status === (graphql ? 200 : 201) &&
      !result.errors &&
      link?.targetUrl === targetUrl &&
      /^[A-Za-z0-9_-]{8}$/.test(link.code),
    "Source API did not acknowledge the cohort link",
  );
  const headers = await run("curl", [
    "--silent",
    "--show-error",
    "--noproxy",
    "*",
    "--max-time",
    "3",
    "--resolve",
    "go.localhost:8080:127.0.0.1",
    "--dump-header",
    "-",
    "--output",
    "/dev/null",
    `http://go.localhost:8080/${link.code}`,
  ]);
  const fields = Object.fromEntries(
    headers
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const split = line.indexOf(":");
        return [
          line.slice(0, split).toLowerCase(),
          line.slice(split + 1).trim(),
        ];
      }),
  );
  ensure(
    /^HTTP\/\S+ 302/.test(headers) &&
      fields.location === targetUrl &&
      fields["cache-control"] === "no-store",
    "Newly acknowledged source link did not immediately redirect correctly",
  );
  const record = {
    phase,
    transport,
    startedAt,
    acknowledgedAt: new Date().toISOString(),
    ...link,
  };
  report.cohort.push(record);
  await save("cohort.json", report.cohort);
  return record;
}
async function compareContents() {
  // Application writes append IDs. Compare a fixed prefix so new appends can continue.
  const boundary = JSON.parse(
    await sourceSql(
      "SELECT json_build_object('links',(SELECT coalesce(max(id),0)::text FROM links),'history',(SELECT coalesce(max(id),0)::text FROM drizzle.__drizzle_migrations));",
    ),
  );
  ensure(
    /^\d+$/.test(boundary.links) && /^\d+$/.test(boundary.history),
    "Unexpected verification boundaries",
  );
  const query = digestSql
    .replaceAll(
      "FROM public.links)",
      `FROM public.links WHERE id<=${boundary.links})`,
    )
    .replaceAll(
      "FROM public.links x)",
      `FROM public.links x WHERE id<=${boundary.links})`,
    )
    .replaceAll(
      "FROM drizzle.__drizzle_migrations)",
      `FROM drizzle.__drizzle_migrations WHERE id<=${boundary.history})`,
    )
    .replaceAll(
      "FROM drizzle.__drizzle_migrations x)",
      `FROM drizzle.__drizzle_migrations x WHERE id<=${boundary.history})`,
    );
  for (let attempt = 0; attempt < 30; attempt++) {
    const a = JSON.parse(await sourceSql(query));
    const dest = JSON.parse(await targetSql(query));
    const b = JSON.parse(await sourceSql(query));
    if (
      JSON.stringify(a) === JSON.stringify(b) &&
      JSON.stringify(a) === JSON.stringify(dest)
    )
      return {
        source: a,
        destination: dest,
        boundary,
        sourceStableAcrossComparison: true,
        verificationQuery: query,
      };
    await delay(200);
  }
  throw new Error(
    "No stable source/destination content match was observed through the recorded ID boundaries",
  );
}
async function verify() {
  const current = await state();
  ensure(
    current.destination.relations.length === 2 &&
      current.destination.relations.every((r) => r.state === "r"),
    "Initial table synchronization is incomplete",
  );
  ensure(
    current.destination.workers.some((w) => w.worker_type === "apply" && w.pid),
    "No running logical apply worker",
  );
  ensure(
    current.source.slots.some(
      (s) => s.slot_name === config.subscription && s.active,
    ),
    "Migration slot is not active",
  );
  ensure(
    current.source.sender.some((s) => s.state === "streaming" && s.ssl),
    "No TLS logical stream was observed",
  );
  const sourceSchema = JSON.parse(await sourceSql(schemaSql));
  const targetSchema = JSON.parse(await targetSql(schemaSql));
  ensure(
    JSON.stringify(sourceSchema) === JSON.stringify(targetSchema),
    "Replicated table definitions differ",
  );
  report.schemaSha256 = hash(sourceSchema);
  report.contents = await compareContents();
  const pods = (
    await dbGet([
      "get",
      "pods",
      "-l",
      "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
    ])
  ).items;
  report.standbys = [];
  const p = await primary();
  for (const pod of pods.filter((x) => x.metadata.name !== p)) {
    let actual;
    for (let attempt = 0; attempt < 40; attempt++) {
      actual = JSON.parse(
        await targetSql(
          report.contents.verificationQuery,
          config.database,
          pod.metadata.name,
        ),
      );
      if (
        JSON.stringify(actual) === JSON.stringify(report.contents.destination)
      )
        break;
      await delay(250);
    }
    ensure(
      JSON.stringify(actual) === JSON.stringify(report.contents.destination),
      "A standby has not replayed the verified copy",
    );
    report.standbys.push({ pod: pod.metadata.name, matched: true });
  }
  report.sequences = JSON.parse(
    await targetSql(
      "SELECT json_build_object('linksLast',(SELECT last_value::text FROM links_id_seq),'linksCalled',(SELECT is_called FROM links_id_seq),'maxLink',(SELECT max(id)::text FROM links),'historyLast',(SELECT last_value::text FROM drizzle.__drizzle_migrations_id_seq),'historyCalled',(SELECT is_called FROM drizzle.__drizzle_migrations_id_seq),'maxHistory',(SELECT max(id)::text FROM drizzle.__drizzle_migrations));",
    ),
  );
  report.state = current;
  report.destinationApplicationWritesEnabled = false;
}
try {
  report.sourceBefore = await sourceState();
  if (mode === "status") {
    report.state = await state();
    report.initialCopyComplete =
      report.state.destination.relations.length === 2 &&
      report.state.destination.relations.every((r) => r.state === "r");
    report.streamActive =
      report.state.source.slots.some(
        (s) => s.slot_name === config.subscription && s.active,
      ) &&
      report.state.source.sender.some(
        (s) => s.state === "streaming" && s.ssl,
      ) &&
      report.state.destination.workers.some(
        (w) => w.worker_type === "apply" && w.pid,
      );
    report.passed = report.streamActive;
    if (!report.passed) process.exitCode = 1;
  }
  if (mode === "verify") {
    await verify();
    report.passed = true;
  }
  if (mode === "start") {
    report.runId = randomUUID();
    const targetPrimary = await primary();
    report.primary = targetPrimary;
    ensure(
      (
        await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
      ).trim() === "1",
      "Host memory pressure is not normal",
    );
    report.sourceLocale = JSON.parse(await sourceSql(localeSql));
    ensure(
      report.sourceLocale.encoding === "UTF8" &&
        report.sourceLocale.datlocprovider === "c" &&
        report.sourceLocale.datcollate === "en_US.utf8" &&
        report.sourceLocale.datctype === "en_US.utf8",
      "Source locale changed; review destination creation",
    );
    const exists = (
      await targetSql(
        "SELECT count(*) FROM pg_database WHERE datname='shortener';",
        "postgres",
      )
    ).trim();
    ensure(
      exists === "0",
      "Destination database already exists; use status/verify and inspect partial state instead of recopying",
    );
    const sourceObjects = JSON.parse(
      await sourceSql(
        "SELECT json_build_object('publications',(SELECT count(*) FROM pg_publication),'slots',(SELECT count(*) FROM pg_replication_slots));",
      ),
    );
    ensure(
      sourceObjects.publications === 0 && sourceObjects.slots === 0,
      "Source already has replication objects",
    );
    const ready = await run("node", ["scripts/prepare-replication.mjs"]);
    ensure(
      JSON.parse(ready.trim()).readyForLiveReplication,
      "Source preparation did not pass",
    );
    const originalSchema = JSON.parse(await sourceSql(schemaSql));
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
    await writeFile(`${path}/source-schema.sql`, schema);
    await watcher(false);
    const watchJob = `migration-watch-${report.runId.slice(0, 8)}`;
    await appKube([
      "create",
      "job",
      watchJob,
      "--from=cronjob/migration-replication-watch",
    ]);
    await appKube(
      ["wait", "--for=condition=complete", `job/${watchJob}`, "--timeout=60s"],
      undefined,
      70000,
    );
    await save(
      "watcher-preflight.log",
      await appKube(["logs", `job/${watchJob}`]),
    );
    console.log(
      "Creating destination database with matching UTF8/en_US.utf8 locale and restoring schema",
    );
    await targetSql(
      "CREATE DATABASE shortener OWNER shortlink_lab TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8';",
      "postgres",
      targetPrimary,
    );
    report.destinationLocale = JSON.parse(await targetSql(localeSql));
    ensure(
      JSON.stringify(report.sourceLocale) ===
        JSON.stringify(report.destinationLocale),
      "Destination locale/provider/version differ from source",
    );
    await targetSql(
      `SET ROLE shortlink_lab; BEGIN;\n${schema}\nCOMMIT; RESET ROLE;`,
    );
    ensure(
      JSON.stringify(originalSchema) ===
        JSON.stringify(JSON.parse(await targetSql(schemaSql))),
      "Schema restore differs from source before copying rows",
    );
    await createLink("before-copy", "rest");
    await createLink("before-copy", "graphql");
    await sourceSql(
      await readFile("deploy/migration/source-publication.sql", "utf8"),
    );
    const hold = await holdCopy(targetPrimary, config.database);
    release = hold.release;
    const connection =
      "host=migration-source.database-lab.svc.cluster.local port=5432 dbname=shortener user=shortlink_migrator sslmode=verify-full sslrootcert=/controller/external/migration-source/migration-source-client_ca.crt passfile=/controller/external/migration-source/pgpass connect_timeout=3 application_name=shortlink-migration";
    const sql = (
      await readFile("deploy/migration/destination-subscription.sql", "utf8")
    ).replace(":'source_conninfo'", `'${connection}'`);
    console.log("Starting initial copy and the continuous logical stream");
    await targetSql(sql);
    await watcher(true);
    monitoring = (async () => {
      while (!finishMonitor) {
        try {
          await observe();
        } catch (error) {
          monitorError = error;
          break;
        }
        await delay(500);
      }
    })();
    for (let attempt = 0; attempt < 50; attempt++) {
      const s = await state();
      const copying = s.destination.relations.find(
        (r) => r.name === "links" || r.name === "public.links",
      );
      if (copying?.state === "d") {
        report.heldCopyState = { time: new Date().toISOString(), ...s };
        break;
      }
      ensure(
        attempt < 49,
        "Did not observe links table synchronization while the copy-test lock was held",
      );
      await delay(150);
    }
    ensure(
      hold.isHeld(),
      "Destination copy lock expired before the concurrent-write proof",
    );
    for (let i = 0; i < 2; i++) {
      await createLink(`during-copy-${i}`, "rest");
      await createLink(`during-copy-${i}`, "graphql");
    }
    ensure(
      hold.isHeld(),
      "Destination copy lock expired during the concurrent-write proof",
    );
    await release();
    release = undefined;
    report.copyHoldReleasedAt = new Date().toISOString();
    for (let attempt = 0; attempt < 100; attempt++) {
      const s = await state();
      if (
        s.destination.relations.length === 2 &&
        s.destination.relations.every((r) => r.state === "r")
      )
        break;
      ensure(attempt < 99, "Initial synchronization did not complete");
      await delay(300);
    }
    await createLink("after-copy", "rest");
    await createLink("after-copy", "graphql");
    await verify();
    for (const row of report.cohort) {
      const found = JSON.parse(
        await targetSql(
          `SELECT row_to_json(x) FROM (SELECT code,target_url AS "targetUrl",created_at AT TIME ZONE 'UTC' AS "createdAt" FROM links WHERE code='${row.code}')x;`,
        ),
      );
      ensure(
        found?.targetUrl === row.targetUrl,
        "An acknowledged cohort link is missing or differs on destination",
      );
    }
    ensure(
      JSON.stringify(originalSchema) ===
        JSON.stringify(JSON.parse(await sourceSql(schemaSql))),
      "Source schema changed during migration",
    );
    ensure(
      (await primary()) === targetPrimary,
      "Destination primary changed during this copy; requalify the result",
    );
    report.sourceAfter = await sourceState();
    ensure(
      report.sourceBefore.deploymentSpecHash ===
        report.sourceAfter.deploymentSpecHash,
      "Fastify deployment configuration changed",
    );
    ensure(
      !monitorError,
      "Monitoring failed during copy; inspect timeline evidence",
    );
    report.passed = true;
    console.log(
      "Initial copy and concurrent REST/GraphQL writes verified; leaving replication running",
    );
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (release)
    try {
      await release();
    } catch (error) {
      report.lockReleaseError = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  finishMonitor = true;
  if (monitoring) await monitoring;
  if (monitorError) {
    report.monitoringError = monitorError.message;
    report.passed = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await save("timeline.json", timeline);
  await save("result.json", report);
  console.log(
    JSON.stringify({
      passed: report.passed,
      mode,
      evidence: `${path}/result.json`,
      ...(report.contents
        ? { links: report.contents.destination.linksCount }
        : {}),
    }),
  );
}
