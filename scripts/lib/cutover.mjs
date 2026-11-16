import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runtimeTemplate } from "./application-roles.mjs";

export const journalName = "database-cutover";
export const phases = [
  "gate",
  "fence",
  "catchup",
  "sequences",
  "stop-stream",
  "switch",
  "verify-ha",
  "open",
  "canary",
  "audit",
];
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function validatePlan(plan) {
  assert.equal(plan.format, "shortlink-cutover-v1");
  assert.match(plan.id, /^[a-f0-9]{32}$/);
  assert.match(plan.marker.code, /^[A-Za-z0-9_-]{8}$/);
  assert.equal(
    plan.marker.targetUrl,
    `https://example.invalid/cutover/${plan.id}`,
  );
  assert.equal(
    plan.canaryUrl,
    `https://example.invalid/cutover-canary/${plan.id}`,
  );
  assert.equal(plan.initialControl.creationMode, "accept");
  assert.equal(plan.initialControl.activeDatabase, "source");
  assert.equal(plan.initialControl.prepareDatabase, "ha");
  assert.equal(plan.binding.pods.length, 2);
  assert.notEqual(plan.binding.source.systemId, plan.binding.ha.systemId);
  for (const side of ["source", "ha"]) {
    for (const key of ["systemId", "databaseOid", "linksOid", "historyOid"])
      assert.match(plan.binding[side][key], /^\d+$/);
  }
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  const { planHash, ...body } = plan;
  assert.equal(
    hash(body),
    planHash,
    "Plan content changed; create a fresh plan",
  );
  return plan;
}
export function recovery(journal) {
  const attempted = (step) => Boolean(journal.steps[step]?.intentAt);
  return {
    abortToSourceAllowed: !attempted("fence"),
    direction:
      journal.status === "aborting"
        ? "finish-source-abort"
        : attempted("fence")
          ? "forward-to-ha-only"
          : "source-abort-or-continue",
    haWritesMayHaveBeenAdmitted: attempted("open"),
    canaryMustNotBeRetried: attempted("canary"),
    automaticRollback: false,
  };
}
export function sequenceTarget(source, target) {
  for (const item of [source, target]) {
    assert.equal(item.increment, "1");
    assert.equal(item.cycle, false);
    assert.equal(typeof item.is_called, "boolean");
  }
  const next = (item) => BigInt(item.last_value) + (item.is_called ? 1n : 0n);
  let value = 0n;
  for (const candidate of [
    next(source),
    next(target),
    BigInt(source.max_id) + 1n,
    BigInt(target.max_id) + 1n,
  ])
    if (candidate > value) value = candidate;
  assert.ok(value <= BigInt(target.max_value), "Identity sequence exhausted");
  // Set the next unallocated value; never rewind a consumed range.
  return { last_value: value.toString(), is_called: false };
}
export async function coordinate(
  plan,
  journal,
  io,
  { stopAfterMs, now = Date.now } = {},
) {
  validatePlan(plan);
  assert.equal(journal.planHash, plan.planHash);
  assert.ok(
    Number.isSafeInteger(stopAfterMs) && stopAfterMs > 0,
    "An explicit stop deadline is required",
  );
  assert.ok(
    !["aborted", "aborting", "complete"].includes(journal.status),
    "Journal is already terminal",
  );
  const deadline = now() + stopAfterMs;
  const check = () => {
    assert.ok(
      now() < deadline,
      "Cutover stop deadline reached; inspect recovery state",
    );
    io.checkInterrupted?.();
  };
  journal.status = "running";
  journal.attempts ??= [];
  journal.attempts.push({ startedAt: now(), deadline });
  try {
    await io.save(journal);
    await io.reconcile(journal);
    for (const phase of phases) {
      if (journal.steps[phase]?.completedAt) continue;
      check();
      const replay = Boolean(journal.steps[phase]?.intentAt);
      journal.steps[phase] ??= { intentAt: now() };
      journal.currentPhase = phase;
      // Write intent durably before every possible side effect, including opening admission.
      await io.save(journal);
      await io.reconcile(journal);
      check();
      const result = await io.step(phase, journal, { replay, check, deadline });
      journal.steps[phase].result = result;
      journal.steps[phase].completedAt = now();
      await io.save(journal);
    }
    journal.status = "complete";
    journal.completedAt = now();
    await io.save(journal);
    return journal;
  } catch (error) {
    journal.status = "paused";
    journal.recovery = recovery(journal);
    // Adapter errors must be sanitized; never persist child stdout/stderr or credentials.
    journal.error =
      error.code === "ERR_ASSERTION"
        ? error.message.split("\n")[0]
        : "Cutover operation failed; inspect the recorded phase and live status";
    await io.save(journal).catch(() => {});
    throw error;
  }
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function identityGuard(identity) {
  for (const key of ["systemId", "databaseOid", "linksOid", "historyOid"])
    assert.match(identity[key], /^\d+$/);
  return `DO $$ BEGIN
    IF current_database()<>'shortener' OR pg_is_in_recovery()
      OR (SELECT system_identifier::text FROM pg_control_system())<>${quote(identity.systemId)}
      OR (SELECT oid::text FROM pg_database WHERE datname=current_database())<>${quote(identity.databaseOid)}
      OR 'public.links'::regclass::oid::text<>${quote(identity.linksOid)}
      OR 'drizzle.__drizzle_migrations'::regclass::oid::text<>${quote(identity.historyOid)} THEN
      RAISE EXCEPTION 'Cutover database identity changed';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('shortlink-live-cutover',0)) THEN
      RAISE EXCEPTION 'Another cutover transaction is active';
    END IF;
  END $$;`;
}
export function fenceSql(plan) {
  validatePlan(plan);
  return `BEGIN;
    SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s';
    ${identityGuard(plan.binding.source)}
    LOCK TABLE public.links,drizzle.__drizzle_migrations IN SHARE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shortlink_app' AND
        (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication OR rolbypassrls))
        OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
        OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app'))
        OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='shortlink_app')) THEN
        RAISE EXCEPTION 'Source runtime role cannot be safely fenced';
      END IF;
      IF EXISTS(SELECT 1 FROM public.links WHERE code=${quote(plan.marker.code)} AND target_url<>${quote(plan.marker.targetUrl)}) THEN
        RAISE EXCEPTION 'Cutover marker conflicts with an existing link';
      END IF;
    END $$;
    REVOKE INSERT ON public.links FROM shortlink_app;
    REVOKE USAGE ON SEQUENCE public.links_id_seq FROM shortlink_app;
    DO $$ BEGIN
      IF has_table_privilege('shortlink_app','public.links','INSERT') OR has_sequence_privilege('shortlink_app','public.links_id_seq','USAGE') THEN
        RAISE EXCEPTION 'Source write privileges remain through another grant';
      END IF;
    END $$;
    INSERT INTO public.links(code,target_url) VALUES(${quote(plan.marker.code)},${quote(plan.marker.targetUrl)}) ON CONFLICT(code) DO UPDATE SET target_url=EXCLUDED.target_url;
    SELECT json_build_object('lsn',pg_current_wal_insert_lsn()::text,'marker',(SELECT row_to_json(x) FROM (SELECT id::text,code,target_url FROM links WHERE code=${quote(plan.marker.code)})x));
    COMMIT;`;
}
const controlGuard = (plan, allowed) => `
  PERFORM 1 FROM shortlink_cutover.control WHERE run_id=${quote(plan.id)} AND plan_hash=${quote(plan.planHash)} AND phase IN (${allowed.map(quote).join(",")}) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cutover phase is sealed or belongs to another plan'; END IF;`;
export function prepareTargetSql(plan) {
  validatePlan(plan);
  return `BEGIN; ${identityGuard(plan.binding.ha)}
    DO $$ BEGIN
      IF to_regnamespace('shortlink_cutover') IS NOT NULL AND
        (obj_description(to_regnamespace('shortlink_cutover'),'pg_namespace') IS DISTINCT FROM 'shortlink:cutover-control:v1'
        OR (SELECT nspowner<>current_user::regrole FROM pg_namespace WHERE oid=to_regnamespace('shortlink_cutover'))) THEN
        RAISE EXCEPTION 'Unmanaged cutover control schema';
      END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS shortlink_cutover;
    COMMENT ON SCHEMA shortlink_cutover IS 'shortlink:cutover-control:v1';
    REVOKE ALL ON SCHEMA shortlink_cutover FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS shortlink_cutover.control (
      singleton boolean NOT NULL UNIQUE DEFAULT true CHECK(singleton),run_id text PRIMARY KEY,
      plan_hash text NOT NULL,phase text NOT NULL CHECK(phase IN ('preparing','sealed','admitted')));
    REVOKE ALL ON shortlink_cutover.control FROM PUBLIC;
    INSERT INTO shortlink_cutover.control(run_id,plan_hash,phase) VALUES(${quote(plan.id)},${quote(plan.planHash)},'preparing') ON CONFLICT DO NOTHING;
    DO $$ BEGIN ${controlGuard(plan, ["preparing"])} END $$; COMMIT;`;
}
export function sequenceSql(plan, name, value) {
  validatePlan(plan);
  assert.ok(
    ["public.links_id_seq", "drizzle.__drizzle_migrations_id_seq"].includes(
      name,
    ),
  );
  assert.match(value.last_value, /^\d+$/);
  assert.equal(value.is_called, false);
  const table =
    name === "public.links_id_seq"
      ? "public.links"
      : "drizzle.__drizzle_migrations";
  return `BEGIN; ${identityGuard(plan.binding.ha)} DO $$ DECLARE next_id bigint; BEGIN
    ${controlGuard(plan, ["preparing"])}
    SELECT greatest(${value.last_value}::bigint,(SELECT last_value+CASE WHEN is_called THEN 1 ELSE 0 END FROM ${name}),(SELECT coalesce(max(id),0)+1 FROM ${table})) INTO next_id;
    PERFORM setval(${quote(name)},next_id,false);
    END $$; COMMIT;`;
}
export function stopStreamSql(plan) {
  validatePlan(plan);
  return `BEGIN; ${identityGuard(plan.binding.ha)} DO $$ BEGIN ${controlGuard(plan, ["preparing", "sealed"])} END $$;
    ALTER SUBSCRIPTION shortlink_migration_sub DISABLE;
    UPDATE shortlink_cutover.control SET phase='sealed' WHERE run_id=${quote(plan.id)};
    COMMIT;`;
}
export function admitTargetSql(plan) {
  validatePlan(plan);
  return `BEGIN; ${identityGuard(plan.binding.ha)} DO $$ BEGIN ${controlGuard(plan, ["sealed", "admitted"])} END $$;
    UPDATE shortlink_cutover.control SET phase='admitted' WHERE run_id=${quote(plan.id)}; COMMIT;`;
}
export function assertMaintenanceOutsideCutover(
  journal,
  current,
  action,
  database,
) {
  if (!journal || journal.status === "aborted") return;
  if (
    journal.status === "complete" &&
    current.activeDatabase === "ha" &&
    !(["prepare", "switch"].includes(action) && database === "source")
  )
    return;
  throw new Error(
    "A cutover journal controls database authority; use its status/recovery commands",
  );
}

export function assertReleaseOutsideCutover(journal, template, server) {
  if (!journal || journal.status === "aborted") return;
  assert.equal(
    journal.status,
    "complete",
    "Pause API image changes until cutover recovery finishes",
  );
  assert.ok(
    isDeepStrictEqual(runtimeTemplate(template), template),
    "A release must retain dedicated runtime credentials",
  );
  assert.ok(
    server.includes("readDatabaseUser") &&
      server.includes("applyRuntimeConfig"),
    "The image must understand runtime HA selection and its dedicated login",
  );
}
