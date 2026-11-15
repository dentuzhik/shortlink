import { readFile, writeFile } from "node:fs/promises";
import {
  appKube,
  dbGet,
  dbKube,
  directory,
  ensure,
  sourceState,
} from "./lib/db-lab-connectivity.mjs";

const path = await directory("replication-preparation");
const report = {
  startedAt: new Date().toISOString(),
  passed: false,
  readyForLiveReplication: false,
};
try {
  report.sourceBefore = await sourceState();
  const query = await readFile("deploy/migration/inventory.sql", "utf8");
  report.source = JSON.parse(
    await appKube(
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
      query,
    ),
  );
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three healthy destination instances",
  );
  report.destination = JSON.parse(
    await dbKube(
      [
        "exec",
        "-i",
        cluster.status.currentPrimary,
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
      query,
    ),
  );
  const tables = report.source.relations
    .filter((r) => r.kind === "r")
    .map((r) => `${r.schema}.${r.name}`)
    .sort();
  ensure(
    JSON.stringify(tables) ===
      JSON.stringify(["drizzle.__drizzle_migrations", "public.links"]),
    "Source table inventory changed; review the explicit publication list",
  );
  ensure(
    report.source.relations.every(
      (r) =>
        ["r", "S"].includes(r.kind) && r.persistence === "p" && !r.row_security,
    ),
    "Unsupported relation or row-security configuration requires review",
  );
  ensure(
    report.source.largeObjects === 0 &&
      report.source.eventTriggers === 0 &&
      report.source.userTriggers === 0 &&
      report.source.userFunctions === 0,
    "Review non-table objects before migration",
  );
  ensure(
    report.source.relations
      .filter((r) => r.kind === "r")
      .every(
        (r) =>
          r.replica_identity === "d" &&
          r.constraints.some((c) => c.startsWith("PRIMARY KEY")),
      ),
    "Published tables need verified replica identity",
  );
  ensure(
    report.source.extensions.every((e) => e === "plpgsql"),
    "Review extension compatibility",
  );
  ensure(
    report.source.slots.length === 0 &&
      report.source.publications.length === 0 &&
      report.source.subscriptions.length === 0,
    "Source already has replication objects; review them before planning another migration",
  );
  report.publicationTables = tables;
  const settings = (inventory) =>
    Object.fromEntries(inventory.settings.map((s) => [s.name, s.setting]));
  const sourceSettings = settings(report.source);
  const destinationSettings = settings(report.destination);
  report.workerCapacitySufficient =
    Number(sourceSettings.max_replication_slots) >= 3 &&
    Number(sourceSettings.max_wal_senders) >= 3 &&
    Number(destinationSettings.max_logical_replication_workers) >= 3 &&
    Number(destinationSettings.max_active_replication_origins) >= 3 &&
    Number(destinationSettings.max_worker_processes) >=
      Number(destinationSettings.max_logical_replication_workers) + 1;
  ensure(
    report.workerCapacitySufficient,
    "Publisher/subscriber worker settings need review for one subscription and two table-sync workers",
  );

  report.sequenceHandling = report.source.sequences.map((s) => ({
    sequence: `${s.schemaname}.${s.sequencename}`,
    action:
      "Synchronize before enabling destination application writes; logical replication does not advance it",
  }));
  report.schema =
    "Copy schema without source ownership/ACLs; map ownership to shortlink_lab and freeze DDL during migration";
  report.blockers = [
    ...(sourceSettings.wal_level !== "logical"
      ? ["Source wal_level=logical requires restart"]
      : []),
    "Live reverse endpoint, verified TLS and dedicated replication credentials are not deployed",
    "Consolidate VM resize and all source restart requirements before the single maintenance window",
    "Source WAL retention and destination backup/recovery must be qualified before authority moves",
  ];
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
  // Ask Kubernetes to validate the staged settings patch without applying it.
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
  report.stagedPatchValidated = true;
  report.sourceAfter = await sourceState();
  ensure(
    report.sourceBefore.deploymentSpecHash ===
      report.sourceAfter.deploymentSpecHash,
    "Source application configuration changed during preparation",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      readyForLiveReplication: false,
      evidence: `${path}/result.json`,
    }),
  );
}
