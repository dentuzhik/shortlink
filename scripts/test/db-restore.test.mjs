import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoReplicationEntries,
  restoreMode,
  sequenceRepair,
} from "../lib/db-restore.mjs";

test("recovery sources are explicit and unsupported arguments cannot select another destination", () => {
  assert.equal(restoreMode([]), "source");
  assert.equal(restoreMode(["--ha"]), "ha");
  for (const args of [
    ["ha"],
    ["--source"],
    ["--ha", "--switch"],
    ["postgresql://live/db"],
  ])
    assert.throws(() => restoreMode(args));
});
test("a copied identity with an unadvanced generator is detected and repaired beyond the copied maximum", () => {
  const raw = {
    last_value: "1",
    increment: "1",
    is_called: false,
    max_id: "10817",
  };
  const repair = sequenceRepair(raw);
  assert.deepEqual(repair, { last_value: "10817", is_called: true });
  assert.equal(sequenceRepair({ ...raw, ...repair }), null);
  assert.deepEqual(sequenceRepair({ ...raw, max_id: "1" }), {
    last_value: "1",
    is_called: true,
  });
});
test("sequence preparation preserves a safe generator, handles empty tables and avoids bigint rounding", () => {
  const raw = {
    last_value: "1",
    increment: "1",
    is_called: false,
    max_id: "0",
  };
  assert.equal(sequenceRepair(raw), null);
  assert.equal(
    sequenceRepair({ ...raw, last_value: "20000", max_id: "10817" }),
    null,
  );
  assert.deepEqual(sequenceRepair({ ...raw, max_id: "9007199254740993" }), {
    last_value: "9007199254740993",
    is_called: true,
  });
  assert.throws(() => sequenceRepair({ ...raw, increment: "-1" }));
});
test("recovery archives must not restore a migration subscription or publication", () => {
  const header = "; Archive created by pg_dump\n";
  assert.doesNotThrow(() =>
    assertNoReplicationEntries(
      `${header}210; 1259 12345 TABLE public links shortlink_lab\n`,
    ),
  );
  for (const entry of [
    "SUBSCRIPTION - shortlink_migration_sub postgres",
    "PUBLICATION - copied_stream postgres",
    "PUBLICATION TABLE public copied_stream links postgres",
  ])
    assert.throws(() =>
      assertNoReplicationEntries(`${header}210; 1259 12345 ${entry}\n`),
    );
});
