import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coordinate, hash, recovery, validatePlan } from "./lib/cutover.mjs";
import {
  backupEvidence,
  claim,
  fresh,
  liveAdapter,
  optionalJournal,
  runtime,
} from "./lib/cutover-live.mjs";
import { directory, run } from "./lib/db-lab-connectivity.mjs";
import { sourceSql, targetSql } from "./lib/live-replication.mjs";

const [action, ...args] = process.argv.slice(2);
const names = ["plan", "status", "execute", "resume", "abort-source"];
const usage =
  "Use live-cutover.mjs plan | status PLAN | execute|resume PLAN --stop-after-ms N --backup-report FILE --max-backup-age-hours H | abort-source PLAN --stop-after-ms N";
assert.ok(names.includes(action), usage);
const mutate = ["execute", "resume", "abort-source"].includes(action);
const options = {};
let file;
if (action !== "plan") file = args.shift();
while (args.length) {
  const key = args.shift();
  assert.ok(
    ["--stop-after-ms", "--backup-report", "--max-backup-age-hours"].includes(
      key,
    ) &&
      args.length &&
      !Object.hasOwn(options, key),
    usage,
  );
  options[key] = args.shift();
}
if (action === "plan" || action === "status")
  assert.equal(Object.keys(options).length, 0, usage);
if (mutate) {
  assert.ok(
    Number.isSafeInteger(Number(options["--stop-after-ms"])) &&
      Number(options["--stop-after-ms"]) > 0,
    usage,
  );
}
if (["execute", "resume"].includes(action))
  assert.ok(
    options["--backup-report"] && Number(options["--max-backup-age-hours"]) > 0,
    usage,
  );
if (action === "abort-source")
  assert.equal(Object.keys(options).length, 1, usage);
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });
const files = [
  "scripts/live-cutover.mjs",
  "scripts/lib/cutover.mjs",
  "scripts/lib/cutover-live.mjs",
  "scripts/lib/live-replication.mjs",
  "scripts/lib/db-lab-connectivity.mjs",
  "scripts/lib/application-roles.mjs",
  "scripts/runtime-maintenance.mjs",
  "scripts/release-redirect.mjs",
  "scripts/live-replication.mjs",
  "deploy/migration/replication-watch.sql",
];
async function tooling() {
  const values = {};
  for (const name of files) values[name] = hash(await readFile(name));
  return values;
}
let evidence;
try {
  if (action === "plan") {
    assert.equal(
      await optionalJournal(),
      null,
      "An existing cutover journal must be recovered or reviewed; do not create a new run",
    );
    const current = await fresh();
    const id = randomBytes(16).toString("hex");
    const marker = {
      code: randomBytes(6).toString("base64url"),
      targetUrl: `https://example.invalid/cutover/${id}`,
    };
    const body = {
      format: "shortlink-cutover-v1",
      id,
      createdAt: new Date().toISOString(),
      initialControl: current.status.desired,
      binding: current.binding,
      marker,
      canaryUrl: `https://example.invalid/cutover-canary/${id}`,
      sourceCommit: (await run("git", ["rev-parse", "HEAD"])).trim(),
      tooling: await tooling(),
      policy: {
        automaticRollback: false,
        postFenceRecovery: "forward-only",
        subscription: "disable-and-retain-slot",
        performanceQualification: "25/2 only; 1000/10 unqualified",
      },
    };
    const plan = { ...body, planHash: hash(body) };
    validatePlan(plan);
    evidence = await directory("live-cutovers");
    await writeFile(
      `${evidence}/plan.json`,
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    await writeFile(
      `${evidence}/preflight.json`,
      `${JSON.stringify({ passed: true, readOnly: true, resources: current.resources, replication: current.replication, sourceRole: current.sourceRole, haRole: current.haRole, sequences: current.sequences, comparison: current.comparison }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        action,
        readOnly: true,
        plan: `${evidence}/plan.json`,
        sourceSelected: true,
        executionDeadlineRequired: true,
        qualifiedBackupRequired: true,
      }),
    );
  } else {
    const full = resolve(file ?? "");
    assert.ok(
      full.startsWith(`${resolve(".kind/db-cluster/live-cutovers")}/`) &&
        full.endsWith("/plan.json"),
      "Select a generated private cutover plan",
    );
    const plan = validatePlan(JSON.parse(await readFile(full, "utf8")));
    evidence = dirname(full);
    const object = await optionalJournal();
    if (action === "status") {
      const journal = object ? JSON.parse(object.data["journal.json"]) : null;
      if (journal) assert.equal(journal.planHash, plan.planHash);
      console.log(
        JSON.stringify(
          {
            action,
            runtime: await runtime(),
            toolingMatches: hash(await tooling()) === hash(plan.tooling),
            journal,
            recovery: journal ? recovery(journal) : null,
          },
          null,
          2,
        ),
      );
    } else {
      assert.deepEqual(
        await tooling(),
        plan.tooling,
        "Tooling changed since planning; review and generate a fresh plan before starting",
      );
      if (action === "execute") {
        assert.equal(
          object,
          null,
          "A cutover already exists; use its recovery path",
        );
        await fresh(plan);
        for (const query of [sourceSql, targetSql])
          assert.equal(
            (
              await query(
                `BEGIN READ ONLY; SELECT count(*) FROM links WHERE code='${plan.marker.code}' OR target_url='${plan.canaryUrl}'; COMMIT;`,
              )
            ).trim(),
            "0",
            "Marker/canary collision; generate a fresh plan",
          );
      } else assert.ok(object, "No existing cutover journal to recover");
      const backup =
        action === "abort-source"
          ? null
          : await backupEvidence(
              options["--backup-report"],
              plan,
              Number(options["--max-backup-age-hours"]),
            );
      const journal = await claim(plan, evidence, object);
      if (backup) journal.backup = backup;
      const io = liveAdapter(plan, evidence, object, () => interrupted);
      if (action === "abort-source") {
        assert.ok(
          recovery(journal).abortToSourceAllowed,
          "Fence intent is recorded; source abort is forbidden",
        );
        const deadline = Date.now() + Number(options["--stop-after-ms"]);
        const check = () => {
          io.checkInterrupted();
          assert.ok(Date.now() < deadline, "Recovery stop deadline reached");
        };
        await io.save(journal);
        await io.abortSource(journal, check);
      } else
        await coordinate(plan, journal, io, {
          stopAfterMs: Number(options["--stop-after-ms"]),
        });
      console.log(
        JSON.stringify({
          action,
          status: journal.status,
          evidence,
          recovery: recovery(journal),
        }),
      );
    }
  }
} catch (error) {
  console.error(
    error.code === "ERR_ASSERTION"
      ? error.message.split("\n")[0]
      : "Cutover command failed; inspect its journal and selected environment; no automatic rollback occurred",
  );
  if (evidence) console.error(`Evidence: ${evidence}`);
  process.exitCode = 1;
}
