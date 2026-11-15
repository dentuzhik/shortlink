import assert from "node:assert/strict";

export function restoreMode(args) {
  if (args.length === 0) return "source";
  if (args.length === 1 && args[0] === "--ha") return "ha";
  throw new Error(
    "Use rehearse-db-restore.mjs [--ha]; targets are explicit and never inferred from DATABASE_URL",
  );
}

export function sequenceRepair(state) {
  const last = BigInt(state.last_value);
  const increment = BigInt(state.increment);
  const maximum = BigInt(state.max_id);
  assert.ok(increment > 0n, "Only increasing sequences are supported");
  assert.equal(typeof state.is_called, "boolean");
  const next = last + (state.is_called ? increment : 0n);
  if (next > maximum) return null;
  return { last_value: maximum.toString(), is_called: true };
}

export function assertNoReplicationEntries(toc) {
  assert.ok(
    !/^\d+;.*\b(?:SUBSCRIPTION|PUBLICATION)\b/m.test(toc),
    "The recovery archive must not recreate replication objects",
  );
}

export const sequenceInventorySql = `SELECT coalesce(json_agg(x ORDER BY schema,name),'[]'::json) FROM (
  SELECT n.nspname AS schema,c.relname AS name,tn.nspname AS table_schema,t.relname AS table_name,a.attname AS column_name,
    s.seqincrement::text AS increment,s.seqstart::text AS start_value
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_sequence s ON s.seqrelid=c.oid
  JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
  JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
  JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
  WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema')
)x;`;
