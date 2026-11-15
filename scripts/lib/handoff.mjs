import assert from "node:assert/strict";

export function fixtureNamespace(runId) {
  assert.match(runId, /^[a-f0-9]{16}$/);
  return `handoff-${runId}`;
}
export function assertFixture(object, runId) {
  assert.equal(object.metadata.name, fixtureNamespace(runId));
  assert.equal(object.metadata.labels?.["shortlink.dev/handoff-run"], runId);
}
export function fenceSql(template, runId) {
  fixtureNamespace(runId);
  assert.ok(
    template.includes("current_setting('shortlink.handoff_fixture',true)"),
  );
  assert.ok(template.includes("@RUN_ID@"));
  return template.replaceAll("@RUN_ID@", runId);
}
export function acknowledged(
  pods,
  desired,
  active = desired.activeDatabase,
  applied = true,
) {
  return (
    pods.length === 2 &&
    pods.every(
      (p) =>
        !p.terminating &&
        p.configurationCurrent &&
        p.observedRevision === desired.revision &&
        p.creationMode === desired.creationMode &&
        p.activeDatabase === active &&
        p.desiredDatabase === desired.activeDatabase &&
        p.database?.activeDatabase === active &&
        (applied
          ? p.configurationApplied &&
            p.database.appliedRevision === desired.revision
          : !p.configurationApplied &&
            p.database.error === "database_configuration_failed") &&
        (desired.creationMode === "reject"
          ? p.drained && !p.acceptingCreations
          : p.acceptingCreations),
    )
  );
}
export function assertSwitchGates(gates) {
  for (const gate of [
    "fenced",
    "barrierApplied",
    "contentsMatched",
    "sequencesSafe",
    "subscriptionStopped",
  ])
    assert.equal(gates[gate], true, `Handoff gate is incomplete: ${gate}`);
}

export function assertResourceBudget(state) {
  assert.ok(
    [1, 2].includes(state.hostPressure),
    "Host pressure is critical or unknown",
  );
  assert.ok(
    Number.isFinite(state.guestAvailableMiB) && state.guestAvailableMiB >= 1024,
    "The application guest must retain at least 1 GiB available",
  );
  assert.ok(
    Number.isFinite(state.guestFullAvg10) && state.guestFullAvg10 <= 0.5,
    "The application guest is stalling on memory",
  );
}
