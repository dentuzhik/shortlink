import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  acknowledged,
  assertFixture,
  assertResourceBudget,
  assertSwitchGates,
  fenceSql,
  fixtureNamespace,
} from "../lib/handoff.mjs";

const id = "0123456789abcdef";
test("fixture mutations require a run-specific namespace and matching ownership label", () => {
  assert.equal(fixtureNamespace(id), `handoff-${id}`);
  assert.doesNotThrow(() =>
    assertFixture(
      {
        metadata: {
          name: `handoff-${id}`,
          labels: { "shortlink.dev/handoff-run": id },
        },
      },
      id,
    ),
  );
  assert.throws(() => fixtureNamespace("shortlink"));
  assert.throws(() =>
    assertFixture(
      {
        metadata: {
          name: "shortlink",
          labels: { "shortlink.dev/handoff-run": id },
        },
      },
      id,
    ),
  );
  assert.throws(() =>
    assertFixture({ metadata: { name: `handoff-${id}`, labels: {} } }, id),
  );
});
test("fixture fencing SQL checks its source startup marker before changing permissions", async () => {
  const template = await readFile(
    new URL("../../deploy/migration/handoff/fence.sql", import.meta.url),
    "utf8",
  );
  const sql = fenceSql(template, id);
  assert.ok(
    sql.indexOf("current_setting('shortlink.handoff_fixture',true)") <
      sql.indexOf("ALTER ROLE"),
  );
  assert.ok(sql.includes(`IS DISTINCT FROM '${id}'`));
  assert.ok(sql.includes("GRANT SELECT"));
  assert.ok(!sql.includes("@RUN_ID@"));
  assert.throws(() => fenceSql("ALTER ROLE shortener NOSUPERUSER", id));
  assert.throws(() => fenceSql(template, "'; DROP DATABASE shortener;--"));
});
test("a pool switch requires fencing, the final barrier, matching contents, safe sequences and a stopped subscriber", () => {
  const gates = {
    fenced: true,
    barrierApplied: true,
    contentsMatched: true,
    sequencesSafe: true,
    subscriptionStopped: true,
  };
  assert.doesNotThrow(() => assertSwitchGates(gates));
  for (const gate of Object.keys(gates))
    assert.throws(() => assertSwitchGates({ ...gates, [gate]: false }));
});
test("two replicas must acknowledge the same drained configuration, and a failed switch must retain source", () => {
  const desired = { revision: 3, creationMode: "reject", activeDatabase: "ha" };
  const failed = {
    terminating: false,
    configurationCurrent: true,
    configurationApplied: false,
    observedRevision: 3,
    creationMode: "reject",
    activeDatabase: "source",
    desiredDatabase: "ha",
    drained: true,
    acceptingCreations: false,
    database: {
      activeDatabase: "source",
      appliedRevision: 2,
      error: "database_configuration_failed",
    },
  };
  assert.equal(acknowledged([failed, failed], desired, "source", false), true);
  assert.equal(acknowledged([failed, failed], desired), false);
  assert.equal(acknowledged([failed], desired, "source", false), false);
  assert.equal(
    acknowledged(
      [failed, { ...failed, observedRevision: 2 }],
      desired,
      "source",
      false,
    ),
    false,
  );
  assert.equal(
    acknowledged(
      [failed, { ...failed, acceptingCreations: true }],
      desired,
      "source",
      false,
    ),
    false,
  );
  const applied = {
    ...failed,
    activeDatabase: "ha",
    configurationApplied: true,
    database: { activeDatabase: "ha", appliedRevision: 3, error: null },
  };
  assert.equal(acknowledged([applied, applied], desired), true);
  assert.equal(
    acknowledged(
      [
        applied,
        { ...applied, database: { ...applied.database, appliedRevision: 2 } },
      ],
      desired,
    ),
    false,
  );
});

test("the small fixture requires spare guest capacity and stops for critical host pressure or guest stalls", () => {
  const state = { hostPressure: 2, guestAvailableMiB: 3900, guestFullAvg10: 0 };
  assert.doesNotThrow(() => assertResourceBudget(state));
  for (const bad of [
    { hostPressure: 4 },
    { guestAvailableMiB: 500 },
    { guestFullAvg10: 5 },
    { guestAvailableMiB: NaN },
  ])
    assert.throws(() => assertResourceBudget({ ...state, ...bad }));
});

test("the k6 summary survives its stdout-to-Kubernetes-log JSON protocol", async () => {
  const source = await readFile(
    new URL("../../benchmarks/database-handoff.js", import.meta.url),
    "utf8",
  );
  const summaryFunction = source
    .slice(source.indexOf("export function handleSummary"))
    .replace("export function", "function");
  const serialize = new Function(`${summaryFunction}; return handleSummary;`)();
  const metrics = { metrics: { handoff_creations: { values: { count: 2 } } } };
  const output = serialize(metrics).stdout;
  assert.equal(output.at(-1).charCodeAt(0), 10);
  assert.deepEqual(
    JSON.parse(output.trim().slice("HANDOFF_SUMMARY ".length)),
    metrics,
  );
});
