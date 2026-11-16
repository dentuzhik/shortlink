import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeTemplate } from "../lib/application-roles.mjs";
import {
  assertMaintenanceOutsideCutover,
  assertReleaseOutsideCutover,
  coordinate,
  hash,
  phases,
  recovery,
  sequenceTarget,
  validatePlan,
} from "../lib/cutover.mjs";

export function fixturePlan() {
  const body = {
    format: "shortlink-cutover-v1",
    id: "a".repeat(32),
    marker: {
      code: "marker01",
      targetUrl: `https://example.invalid/cutover/${"a".repeat(32)}`,
    },
    canaryUrl: `https://example.invalid/cutover-canary/${"a".repeat(32)}`,
    initialControl: {
      revision: 4,
      creationMode: "accept",
      activeDatabase: "source",
      prepareDatabase: "ha",
    },
    binding: {
      pods: [{ uid: "one" }, { uid: "two" }],
      source: {
        systemId: "10",
        databaseOid: "1",
        linksOid: "2",
        historyOid: "3",
      },
      ha: { systemId: "20", databaseOid: "1", linksOid: "2", historyOid: "3" },
    },
  };
  return { ...body, planHash: hash(body) };
}
function fixture(failure) {
  const plan = fixturePlan();
  const journal = {
    planHash: plan.planHash,
    status: "prepared",
    steps: {},
    runtime: plan.initialControl,
  };
  const state = { sourceFenced: false, ha: false, gate: false, canaries: 0 };
  const writes = [];
  let stored;
  let fail = failure;
  const io = {
    async save(value) {
      stored = structuredClone(value);
      writes.push([
        "save",
        value.currentPhase,
        Boolean(value.steps[value.currentPhase]?.completedAt),
      ]);
    },
    async reconcile() {},
    async step(phase, _value, { replay }) {
      assert.ok(
        stored.steps[phase].intentAt,
        "An operation ran without durable intent",
      );
      writes.push(["operation", phase]);
      if (phase === "gate") state.gate = true;
      if (phase === "fence") state.sourceFenced = true;
      if (phase === "switch") state.ha = true;
      if (phase === "open") state.gate = false;
      if (phase === "canary" && !replay) state.canaries++;
      if (phase === fail) {
        fail = undefined;
        throw new Error("Lost operation acknowledgement");
      }
      return { phase };
    },
  };
  return {
    plan,
    journal,
    io,
    state,
    writes,
    stored: () => structuredClone(stored),
  };
}
test("a changed plan or identical source/destination is refused before any operation", async () => {
  const f = fixture();
  const changed = structuredClone(f.plan);
  changed.marker.code = "changed1";
  await assert.rejects(
    coordinate(changed, f.journal, f.io, { stopAfterMs: 10000 }),
  );
  assert.equal(f.writes.length, 0);
  const same = structuredClone(f.plan);
  same.binding.ha.systemId = same.binding.source.systemId;
  assert.throws(() => validatePlan(same));
});
test("success journals every irreversible intent before I/O and opens only after HA verification", async () => {
  const f = fixture();
  await coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10000 });
  assert.equal(f.journal.status, "complete");
  assert.ok(f.state.sourceFenced && f.state.ha && !f.state.gate);
  assert.equal(f.state.canaries, 1);
  assert.deepEqual(
    f.writes.filter((x) => x[0] === "operation").map((x) => x[1]),
    phases,
  );
});
for (const phase of phases)
  test(`a lost ${phase} acknowledgement stops later steps without rollback`, async () => {
    const f = fixture(phase);
    await assert.rejects(
      coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10000 }),
    );
    assert.equal(f.journal.status, "paused");
    assert.deepEqual(
      f.writes.filter((x) => x[0] === "operation").map((x) => x[1]),
      phases.slice(0, phases.indexOf(phase) + 1),
    );
    assert.equal(recovery(f.journal).abortToSourceAllowed, phase === "gate");
    assert.equal(
      recovery(f.journal).haWritesMayHaveBeenAdmitted,
      phases.indexOf(phase) >= phases.indexOf("open"),
    );
    assert.equal(recovery(f.journal).automaticRollback, false);
  });
test("recovery from an ambiguous canary inspects it without sending a second POST", async () => {
  const f = fixture("canary");
  await assert.rejects(
    coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10000 }),
  );
  const recovered = f.stored();
  await coordinate(f.plan, recovered, f.io, { stopAfterMs: 10000 });
  assert.equal(f.state.canaries, 1);
  assert.equal(recovered.status, "complete");
});
test("expiry stops before the next side effect and never opens creation admission", async () => {
  const f = fixture();
  let time = 1;
  const original = f.io.step;
  f.io.step = async (...args) => {
    const result = await original(...args);
    if (args[0] === "fence") time = 100;
    return result;
  };
  await assert.rejects(
    coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10, now: () => time }),
  );
  assert.ok(f.state.gate && f.state.sourceFenced);
  assert.equal(f.state.ha, false);
  assert.equal(recovery(f.journal).direction, "forward-to-ha-only");
});
test("a changed environment on resume prevents further writes", async () => {
  const f = fixture("fence");
  await assert.rejects(
    coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10000 }),
  );
  const before = f.writes.filter((x) => x[0] === "operation").length;
  f.io.reconcile = async () => {
    throw new Error("Pod identity changed");
  };
  await assert.rejects(
    coordinate(f.plan, f.stored(), f.io, { stopAfterMs: 10000 }),
  );
  assert.equal(f.writes.filter((x) => x[0] === "operation").length, before);
});
test("sequence preparation preserves reserved ranges, target progress and bigint precision", () => {
  const sequence = {
    last_value: "9007199254740993",
    max_id: "10",
    is_called: true,
    increment: "1",
    cycle: false,
    max_value: "9223372036854775807",
  };
  assert.deepEqual(
    sequenceTarget(sequence, {
      ...sequence,
      last_value: "1",
      is_called: false,
    }),
    { last_value: "9007199254740994", is_called: false },
  );
  assert.deepEqual(
    sequenceTarget(
      { ...sequence, last_value: "1", is_called: false },
      { ...sequence, last_value: "9007199254740995", is_called: false },
    ),
    { last_value: "9007199254740995", is_called: false },
  );
  assert.throws(() => sequenceTarget(sequence, { ...sequence, cycle: true }));
});
test("ordinary maintenance cannot bypass cutover authority or return a completed migration to source", () => {
  for (const status of ["running", "paused"])
    for (const action of ["begin", "end", "prepare", "switch"])
      assert.throws(() =>
        assertMaintenanceOutsideCutover(
          { status },
          { activeDatabase: "source" },
          action,
          "ha",
        ),
      );
  assert.doesNotThrow(() =>
    assertMaintenanceOutsideCutover(
      { status: "complete" },
      { activeDatabase: "ha" },
      "begin",
    ),
  );
  assert.throws(() =>
    assertMaintenanceOutsideCutover(
      { status: "complete" },
      { activeDatabase: "ha" },
      "switch",
      "source",
    ),
  );
  assert.doesNotThrow(() =>
    assertMaintenanceOutsideCutover(
      { status: "aborted" },
      { activeDatabase: "source" },
      "end",
    ),
  );
});

test("an interrupted source abort must finish aborting rather than resume the forward path", async () => {
  const f = fixture();
  f.journal.status = "aborting";
  assert.equal(recovery(f.journal).direction, "finish-source-abort");
  await assert.rejects(
    coordinate(f.plan, f.journal, f.io, { stopAfterMs: 10000 }),
  );
  assert.equal(f.writes.length, 0);
});
test("image releases preserve HA authority and reject historical administrator templates", () => {
  const old = {
    spec: {
      containers: [
        {
          name: "api",
          image: "example",
          envFrom: [{ secretRef: { name: "postgres-credentials" } }],
        },
      ],
    },
  };
  const compatible = runtimeTemplate(old);
  const server = "readDatabaseUser applyRuntimeConfig";
  assert.throws(() =>
    assertReleaseOutsideCutover({ status: "paused" }, compatible, server),
  );
  assert.throws(() =>
    assertReleaseOutsideCutover({ status: "complete" }, old, server),
  );
  assert.throws(() =>
    assertReleaseOutsideCutover(
      { status: "complete" },
      compatible,
      "old server",
    ),
  );
  assert.doesNotThrow(() =>
    assertReleaseOutsideCutover({ status: "complete" }, compatible, server),
  );
});
