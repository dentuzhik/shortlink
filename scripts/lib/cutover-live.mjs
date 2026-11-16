import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeTemplate } from "./application-roles.mjs";
import {
  admitTargetSql,
  fenceSql,
  hash,
  journalName,
  prepareTargetSql,
  recovery,
  sequenceSql,
  sequenceTarget,
  stopStreamSql,
} from "./cutover.mjs";
import {
  appGet,
  appKube,
  dbGet,
  ensure,
  run,
  sourceState,
} from "./db-lab-connectivity.mjs";
import { acknowledged, assertResourceBudget } from "./handoff.mjs";
import {
  digestSql,
  state as replicationState,
  schemaSql,
  sourceSql,
  targetSql,
} from "./live-replication.mjs";

const source = (sql) => sourceSql(`BEGIN READ ONLY; ${sql} COMMIT;`);
const target = (sql, pod) =>
  targetSql(`BEGIN READ ONLY; ${sql} COMMIT;`, "shortener", pod);
const json = async (promise) => JSON.parse(await promise);
const quoted = (v) => `'${String(v).replaceAll("'", "''")}'`;
export const runtime = async () =>
  JSON.parse(await run("node", ["scripts/runtime-maintenance.mjs", "status"]));
export async function optionalJournal() {
  const raw = await appKube([
    "get",
    "configmap",
    journalName,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (!raw.trim()) return null;
  const object = JSON.parse(raw);
  ensure(
    object.metadata.labels?.["shortlink.dev/exercise"] === "live-cutover",
    "Cutover journal is unmanaged",
  );
  return object;
}
const identitySql = `SELECT json_build_object('systemId',(SELECT system_identifier::text FROM pg_control_system()),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'linksOid','public.links'::regclass::oid::text,'historyOid','drizzle.__drizzle_migrations'::regclass::oid::text,'database',current_database(),'recovery',pg_is_in_recovery());`;
export const roleSql = `SELECT row_to_json(x) FROM (SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
  (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
  (SELECT count(*)::int FROM pg_class WHERE relowner=r.oid) AS owned,
  (SELECT count(*)::int FROM pg_namespace WHERE nspowner=r.oid) AS owned_schemas,
  (SELECT count(*)::int FROM pg_database WHERE datdba=r.oid) AS owned_databases,
  has_table_privilege(rolname,'public.links','SELECT') AS can_read,
  has_table_privilege(rolname,'public.links','INSERT') AS can_insert,
  has_table_privilege(rolname,'public.links','UPDATE') AS can_update,
  has_table_privilege(rolname,'public.links','DELETE') AS can_delete,
  has_table_privilege(rolname,'public.links','TRUNCATE') AS can_truncate,
  has_schema_privilege(rolname,'public','CREATE') AS can_create_table,
  has_database_privilege(rolname,current_database(),'CREATE') AS can_create_schema,
  has_table_privilege(rolname,'drizzle.__drizzle_migrations','INSERT') AS can_write_history,
  has_sequence_privilege(rolname,'public.links_id_seq','USAGE') AS can_allocate,
  has_sequence_privilege(rolname,'public.links_id_seq','UPDATE') AS can_reset
  FROM pg_roles r WHERE rolname='shortlink_app')x;`;
export const sequencesSql = `SELECT json_build_object(
  'public.links_id_seq',(SELECT json_build_object('last_value',last_value::text,'is_called',is_called,'max_id',(SELECT coalesce(max(id),0)::text FROM public.links),'increment',s.seqincrement::text,'max_value',s.seqmax::text,'cycle',s.seqcycle,'cache',s.seqcache::text) FROM public.links_id_seq CROSS JOIN pg_sequence s WHERE s.seqrelid='public.links_id_seq'::regclass),
  'drizzle.__drizzle_migrations_id_seq',(SELECT json_build_object('last_value',last_value::text,'is_called',is_called,'max_id',(SELECT coalesce(max(id),0)::text FROM drizzle.__drizzle_migrations),'increment',s.seqincrement::text,'max_value',s.seqmax::text,'cycle',s.seqcycle,'cache',s.seqcache::text) FROM drizzle.__drizzle_migrations_id_seq CROSS JOIN pg_sequence s WHERE s.seqrelid='drizzle.__drizzle_migrations_id_seq'::regclass));`;
export const subscriptionSql = `SELECT row_to_json(x) FROM (SELECT oid::text,subname,subenabled,subslotname,subpublications,subskiplsn::text,subdisableonerr,(SELECT count(*)::int FROM pg_stat_subscription WHERE subid=s.oid AND pid IS NOT NULL) AS workers FROM pg_subscription s WHERE subname='shortlink_migration_sub')x;`;
export function assertRole(role, mayBeFenced) {
  assert.ok(role?.rolcanlogin && role.can_read);
  for (const key of [
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolinherit",
    "rolreplication",
    "rolbypassrls",
    "can_update",
    "can_delete",
    "can_truncate",
    "can_reset",
    "can_create_table",
    "can_create_schema",
    "can_write_history",
  ])
    assert.equal(role[key], false, `Unexpected runtime privilege: ${key}`);
  for (const key of [
    "memberships",
    "owned",
    "owned_schemas",
    "owned_databases",
  ])
    assert.equal(role[key], 0);
  if (!mayBeFenced) assert.ok(role.can_insert && role.can_allocate);
  else
    assert.equal(
      role.can_insert,
      role.can_allocate,
      "Source fence is incomplete",
    );
}
export async function resources() {
  const hostPressure = Number(
    (await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim(),
  );
  const raw = await run("colima", [
    "-p",
    "default",
    "ssh",
    "--",
    "sh",
    "-c",
    "cat /proc/meminfo; cat /proc/pressure/memory",
  ]);
  const value = {
    hostPressure,
    guestAvailableMiB: Number(raw.match(/^MemAvailable:\s+(\d+)/m)?.[1]) / 1024,
    guestFullAvg10: Number(raw.match(/^full avg10=(\S+)/m)?.[1]),
  };
  assertResourceBudget(value);
  return value;
}
export async function inspect() {
  const status = await runtime();
  const control = await appGet(["get", "configmap", "shortlink-runtime"]);
  assert.deepEqual(status.desired, JSON.parse(control.data["control.json"]));
  const deployment = await appGet(["get", "deployment", "redirect-service"]);
  assert.deepEqual(
    runtimeTemplate(deployment.spec.template),
    deployment.spec.template,
  );
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.status.availableReplicas, 2);
  assert.equal(status.pods.length, 2);
  assert.ok(status.pods.every((p) => !p.terminating && !p.unavailable));
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  assert.equal(cluster.status.readyInstances, 3);
  assert.equal(cluster.status.currentPrimary, cluster.status.targetPrimary);
  const primaryPod = await dbGet(["get", "pod", cluster.status.currentPrimary]);
  const postgres = await appGet(["get", "deployment", "postgres"]);
  const sourcePods = (await appGet(["get", "pods", "-l", "app=postgres"]))
    .items;
  assert.equal(sourcePods.length, 1);
  const secretIdentities = [];
  for (const name of [
    "source-app-credentials",
    "ha-app-credentials",
    "postgres-credentials",
  ]) {
    const secret = await appGet(["get", "secret", name]);
    secretIdentities.push({
      name,
      uid: secret.metadata.uid,
      version: secret.metadata.resourceVersion,
    });
  }
  const sourceIdentity = await json(source(identitySql));
  const haIdentity = await json(target(identitySql));
  for (const item of [sourceIdentity, haIdentity]) {
    assert.equal(item.database, "shortener");
    assert.equal(item.recovery, false);
  }
  assert.notEqual(sourceIdentity.systemId, haIdentity.systemId);
  const binding = {
    namespaceUid: (await appGet(["get", "namespace", "shortlink"])).metadata
      .uid,
    databaseNamespaceUid: (await dbGet(["get", "namespace", "database-lab"]))
      .metadata.uid,
    deploymentUid: deployment.metadata.uid,
    deploymentSpecHash: hash(deployment.spec),
    pods: status.pods
      .map((p) => ({ name: p.pod, uid: p.uid }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    controlUid: control.metadata.uid,
    postgresUid: postgres.metadata.uid,
    postgresPodUid: sourcePods[0].metadata.uid,
    postgresSpecHash: hash(postgres.spec),
    clusterUid: cluster.metadata.uid,
    clusterSpecHash: hash(cluster.spec),
    primary: primaryPod.metadata.name,
    primaryUid: primaryPod.metadata.uid,
    secrets: secretIdentities,
    source: sourceIdentity,
    ha: haIdentity,
  };
  const sourceRole = await json(source(roleSql));
  const haRole = await json(target(roleSql));
  assertRole(sourceRole, true);
  assertRole(haRole, false);
  const subscription = await json(target(subscriptionSql));
  assert.ok(subscription);
  assert.equal(subscription.subslotname, "shortlink_migration_sub");
  assert.deepEqual(subscription.subpublications, ["shortlink_migration"]);
  assert.equal(subscription.subskiplsn, "0/0");
  const publication = await json(
    source(
      `SELECT row_to_json(x) FROM (SELECT oid::text,pubinsert,pubupdate,pubdelete,pubtruncate,puballtables,(SELECT array_agg(schemaname||'.'||tablename ORDER BY schemaname,tablename) FROM pg_publication_tables WHERE pubname='shortlink_migration') AS tables FROM pg_publication WHERE pubname='shortlink_migration')x;`,
    ),
  );
  assert.ok(
    publication.pubinsert && publication.pubupdate && !publication.puballtables,
  );
  assert.deepEqual(publication.tables, [
    "drizzle.__drizzle_migrations",
    "public.links",
  ]);
  binding.subscriptionOid = subscription.oid;
  binding.publicationOid = publication.oid;
  const schemas = [
    await json(source(schemaSql)),
    await json(target(schemaSql)),
  ];
  assert.deepEqual(schemas[0], schemas[1]);
  binding.schemaHash = hash(schemas[0]);
  const watch = await appGet([
    "get",
    "configmap",
    "migration-replication-watch",
  ]);
  binding.watchUid = watch.metadata.uid;
  return {
    binding,
    status,
    control,
    sourceRole,
    haRole,
    subscription,
    publication,
    watch,
  };
}
export async function fresh(plan) {
  const value = await inspect();
  assert.ok(acknowledged(value.status.pods, value.status.desired));
  assert.equal(value.status.desired.creationMode, "accept");
  assert.equal(value.status.desired.activeDatabase, "source");
  assert.equal(value.status.desired.prepareDatabase, "ha");
  assert.ok(
    value.status.pods.every(
      (p) =>
        p.database.candidateReady &&
        p.database.preparedDatabase === "ha" &&
        p.database.error === null,
    ),
  );
  assertRole(value.sourceRole, false);
  assert.ok(value.subscription.subenabled && value.subscription.workers > 0);
  assert.equal(value.watch.data["require-slot"], "true");
  if (plan) {
    assert.deepEqual(value.binding, plan.binding);
    assert.deepEqual(value.status.desired, plan.initialControl);
  }
  await sourceState();
  value.resources = await resources();
  value.replication = await replicationState();
  assert.ok(
    value.replication.source.slots.some(
      (s) => s.slot_name === "shortlink_migration_sub" && s.active,
    ),
  );
  assert.ok(
    value.replication.destination.relations.every((r) => r.state === "r"),
  );
  value.sequences = {
    source: await json(source(sequencesSql)),
    ha: await json(target(sequencesSql)),
  };
  value.comparison = JSON.parse(
    await run("node", ["scripts/live-replication.mjs", "verify"]),
  );
  assert.ok(
    value.comparison.passed,
    "Read-only source/HA/standby comparison failed",
  );
  for (const item of Object.values(value.sequences.ha))
    assert.equal(
      item.cache,
      "1",
      "This increment supports uncached HA identity sequences only",
    );
  return value;
}
export async function backupEvidence(path, plan, maximumAgeHours) {
  assert.ok(
    Number.isFinite(maximumAgeHours) && maximumAgeHours > 0,
    "An explicit maximum backup age is required",
  );
  const full = resolve(path);
  assert.ok(
    full.startsWith(`${resolve(".kind/ha-backups")}/`) &&
      full.endsWith("/result.json"),
  );
  const raw = await readFile(full, "utf8");
  const report = JSON.parse(raw);
  assert.ok(
    report.passed &&
      report.mode === "ha" &&
      report.checks.allTableContents &&
      report.checks.archiveExcludesReplication,
  );
  assert.equal(report.source.uid, plan.binding.primaryUid);
  assert.equal(report.source.database, "shortener");
  const ageMs = Date.now() - Date.parse(report.backupStartedAt);
  assert.ok(
    ageMs >= 0 && ageMs <= maximumAgeHours * 3600000,
    "Qualified backup is older than the chosen limit",
  );
  const archive = resolve(dirname(full), "shortener.dump");
  assert.equal(hash(await readFile(archive)), report.archive.sha256);
  return {
    report: full,
    reportHash: hash(raw),
    archiveHash: report.archive.sha256,
    backupStartedAt: report.backupStartedAt,
    maximumAgeHours,
  };
}
export async function claim(plan, path, previous) {
  if (previous) {
    const old = JSON.parse(previous.data["journal.json"]);
    assert.equal(old.planHash, plan.planHash);
    assert.equal(
      old.owner.host,
      hostname(),
      "Cross-host journal takeover requires manual recovery review",
    );
    let alive = false;
    try {
      process.kill(old.owner.pid, 0);
      alive = true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    assert.equal(
      alive,
      false,
      "The previous coordinator is still running; do not take over",
    );
    for (const query of [source, target])
      assert.equal(
        (
          await query(
            `SELECT count(*) FROM pg_stat_activity WHERE application_name=${quoted(`shortlink-cutover-${plan.id}`)};`,
          )
        ).trim(),
        "0",
        "The previous database operation is still running",
      );
    return { ...old, owner: { host: hostname(), pid: process.pid } };
  }
  return {
    format: "shortlink-cutover-journal-v1",
    id: plan.id,
    planHash: plan.planHash,
    status: "prepared",
    steps: {},
    runtime: plan.initialControl,
    owner: { host: hostname(), pid: process.pid },
    evidence: path,
  };
}

export function liveAdapter(plan, path, initialObject, interrupted) {
  return cutoverAdapter(plan, path, initialObject, interrupted, {
    namespace: "shortlink",
    appKube,
    appGet,
    runtime,
    optionalJournal,
    inspect,
    sourceSql,
    targetSql,
    targetPods: async () =>
      (
        await dbGet([
          "get",
          "pods",
          "-l",
          "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
        ])
      ).items,
    checkApplication: sourceState,
    postCanary: (url) =>
      run("curl", [
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--max-time",
        "3",
        "--resolve",
        "go.localhost:8080:127.0.0.1",
        "--header",
        "Content-Type: application/json",
        "--data",
        JSON.stringify({ targetUrl: url }),
        "http://go.localhost:8080/links",
      ]),
  });
}

// The state transitions and I/O protocol are shared with the explicitly owned fixture.
// The live CLI always selects the production environment above.
export function cutoverAdapter(
  plan,
  path,
  initialObject,
  interrupted,
  environment,
) {
  const {
    namespace,
    appKube,
    appGet,
    runtime,
    optionalJournal,
    inspect,
    sourceSql,
    targetSql,
    targetPods,
    checkApplication,
    postCanary,
  } = environment;
  const source = (sql) => sourceSql(`BEGIN READ ONLY; ${sql} COMMIT;`);
  const target = (sql, pod) =>
    targetSql(`BEGIN READ ONLY; ${sql} COMMIT;`, "shortener", pod);
  let object = initialObject;
  const checkInterrupted = () => ensure(!interrupted(), "Cutover interrupted");
  const mutateSource = (sql) =>
    sourceSql(
      `SET application_name=${quoted(`shortlink-cutover-${plan.id}`)}; ${sql}`,
    );
  const mutateTarget = (sql) =>
    targetSql(
      `SET application_name=${quoted(`shortlink-cutover-${plan.id}`)}; ${sql}`,
      "shortener",
      plan.binding.primary,
    );
  const save = async (journal) => {
    const resource = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: journalName,
        namespace,
        labels: { "shortlink.dev/exercise": "live-cutover" },
      },
      data: { "journal.json": JSON.stringify(journal) },
    };
    if (!object)
      object = JSON.parse(
        await appKube(
          ["create", "-f", "-", "-o", "json"],
          JSON.stringify(resource),
        ),
      );
    else
      object = JSON.parse(
        await appKube(
          [
            "patch",
            "configmap",
            journalName,
            "--type=json",
            "--patch-file=/dev/stdin",
            "-o",
            "json",
          ],
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: object.metadata.uid },
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: object.metadata.resourceVersion,
            },
            { op: "replace", path: "/data", value: resource.data },
          ]),
        ),
      );
    await writeFile(
      `${path}/journal.json`,
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  };
  const poll = async (work, check) => {
    while (true) {
      check();
      if (await work()) return;
      await delay(200);
    }
  };
  async function switchControl(journal, phase, patch, check) {
    let pending = journal.steps[phase].control;
    if (!pending) {
      const from = (await runtime()).desired;
      pending = {
        from,
        to: { ...from, ...patch, revision: from.revision + 1 },
      };
      journal.steps[phase].control = pending;
      await save(journal);
    }
    const current = await appGet(["get", "configmap", "shortlink-runtime"]);
    assert.equal(current.metadata.uid, plan.binding.controlUid);
    const actual = JSON.parse(current.data["control.json"]);
    if (JSON.stringify(actual) !== JSON.stringify(pending.to)) {
      assert.deepEqual(
        actual,
        pending.from,
        "Runtime control changed outside this cutover",
      );
      check();
      await appKube(
        [
          "patch",
          "configmap",
          "shortlink-runtime",
          "--type=json",
          "--patch-file=/dev/stdin",
        ],
        JSON.stringify([
          { op: "test", path: "/metadata/uid", value: current.metadata.uid },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: current.metadata.resourceVersion,
          },
          {
            op: "replace",
            path: "/data/control.json",
            value: JSON.stringify(pending.to),
          },
        ]),
      );
    }
    await poll(async () => {
      const value = await runtime();
      assert.deepEqual(value.desired, pending.to);
      return acknowledged(value.pods, pending.to);
    }, check);
    journal.runtime = pending.to;
    return pending.to;
  }
  async function reconcile(journal) {
    const currentObject = await optionalJournal();
    assert.equal(currentObject.metadata.uid, object.metadata.uid);
    assert.equal(
      currentObject.metadata.resourceVersion,
      object.metadata.resourceVersion,
      "Journal changed concurrently",
    );
    const value = await inspect();
    assert.deepEqual(
      value.binding,
      plan.binding,
      "Pinned deployment/database identity changed",
    );
    const pending = Object.values(journal.steps).find(
      (s) => s.control && !s.completedAt,
    )?.control;
    assert.ok(
      [journal.runtime, pending?.from, pending?.to]
        .filter(Boolean)
        .some(
          (c) => JSON.stringify(c) === JSON.stringify(value.status.desired),
        ),
      "Runtime control changed outside this cutover",
    );
    if (!pending)
      assert.ok(acknowledged(value.status.pods, value.status.desired));
    if (journal.steps.fence?.completedAt)
      assert.ok(
        !value.sourceRole.can_insert && !value.sourceRole.can_allocate,
        "Source writer fence is missing",
      );
    if (journal.steps["stop-stream"]?.completedAt)
      assert.ok(
        !value.subscription.subenabled && value.subscription.workers === 0,
        "Migration subscriber became active",
      );
    if (journal.steps.sequences?.completedAt) {
      const actual = await json(target(sequencesSql));
      for (const [name, prepared] of Object.entries(
        journal.steps.sequences.result,
      )) {
        const item = actual[name];
        const next = BigInt(item.last_value) + (item.is_called ? 1n : 0n);
        assert.ok(
          next >= BigInt(prepared.last_value) && next > BigInt(item.max_id),
          "HA sequence moved backwards or became unsafe",
        );
      }
    }
    if (journal.steps.catchup?.completedAt) {
      assert.deepEqual(
        await json(source(digestSql)),
        journal.steps.catchup.result.contents,
      );
      assert.deepEqual(
        await json(source(sequencesSql)),
        journal.steps.catchup.result.sourceSequences,
      );
      if (!journal.steps.open?.intentAt)
        assert.deepEqual(
          await json(target(digestSql)),
          journal.steps.catchup.result.contents,
          "HA contents changed before write admission",
        );
    }
  }
  const probe = async (code, url) => {
    const script =
      'const [code]=process.argv.slice(1);const r=await fetch("http://127.0.0.1:3000/"+code,{redirect:"manual"});const ready=await fetch("http://127.0.0.1:3000/readyz");console.log(JSON.stringify({status:r.status,location:r.headers.get("location"),cache:r.headers.get("cache-control"),ready:ready.status}));';
    for (const pod of plan.binding.pods) {
      const value = JSON.parse(
        await appKube([
          "exec",
          pod.name,
          "--",
          "node",
          "--input-type=module",
          "-e",
          script,
          code,
        ]),
      );
      assert.deepEqual(value, {
        status: 302,
        location: url,
        cache: "no-store",
        ready: 200,
      });
    }
  };
  async function step(phase, journal, { replay, check }) {
    if (phase === "gate")
      return switchControl(journal, phase, { creationMode: "reject" }, check);
    if (phase === "fence") {
      const result = await json(mutateSource(fenceSql(plan)));
      assert.match(result.lsn, /^[A-F0-9]+\/[A-F0-9]+$/);
      const role = await json(source(roleSql));
      assert.ok(!role.can_insert && !role.can_allocate && role.can_read);
      return result;
    }
    if (phase === "catchup") {
      const lsn = journal.steps.fence.result.lsn;
      await poll(async () => {
        const value = await json(
          target(
            `SELECT json_build_object('applied',pg_replication_origin_progress('pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='shortlink_migration_sub'),true)>=${quoted(lsn)}::pg_lsn,'marker',EXISTS(SELECT 1 FROM links WHERE code=${quoted(plan.marker.code)} AND target_url=${quoted(plan.marker.targetUrl)}));`,
          ),
        );
        return value.applied && value.marker;
      }, check);
      const contents = await json(source(digestSql));
      await poll(
        async () =>
          JSON.stringify(await json(target(digestSql))) ===
          JSON.stringify(contents),
        check,
      );
      const pods = await targetPods();
      for (const pod of pods)
        await poll(
          async () =>
            JSON.stringify(await json(target(digestSql, pod.metadata.name))) ===
            JSON.stringify(contents),
          check,
        );
      return { contents, sourceSequences: await json(source(sequencesSql)) };
    }
    if (phase === "sequences") {
      await mutateTarget(prepareTargetSql(plan));
      const current = await json(target(sequencesSql));
      const prepared = {};
      for (const [name, state] of Object.entries(current)) {
        check();
        prepared[name] = sequenceTarget(
          journal.steps.catchup.result.sourceSequences[name],
          state,
        );
        await mutateTarget(sequenceSql(plan, name, prepared[name]));
      }
      const after = await json(target(sequencesSql));
      for (const [name, state] of Object.entries(after))
        assert.deepEqual(
          sequenceTarget(
            journal.steps.catchup.result.sourceSequences[name],
            state,
          ),
          prepared[name],
        );
      return prepared;
    }
    if (phase === "stop-stream") {
      const watch = await appGet([
        "get",
        "configmap",
        "migration-replication-watch",
      ]);
      assert.equal(watch.metadata.uid, plan.binding.watchUid);
      if (watch.data["require-slot"] !== "false")
        await appKube(
          [
            "patch",
            "configmap",
            "migration-replication-watch",
            "--type=json",
            "--patch-file=/dev/stdin",
          ],
          JSON.stringify([
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: watch.metadata.resourceVersion,
            },
            { op: "replace", path: "/data/require-slot", value: "false" },
            {
              op: "replace",
              path: "/data/check.sql",
              value: await readFile(
                "deploy/migration/replication-watch.sql",
                "utf8",
              ),
            },
          ]),
        );
      check();
      await mutateTarget(stopStreamSql(plan));
      await poll(async () => {
        const sub = await json(target(subscriptionSql));
        return !sub.subenabled && sub.workers === 0;
      }, check);
      return { disabled: true, workerStopped: true, slotRetained: true };
    }
    if (phase === "switch")
      return switchControl(
        journal,
        phase,
        { activeDatabase: "ha", prepareDatabase: null, creationMode: "reject" },
        check,
      );
    if (phase === "verify-ha") {
      await probe(plan.marker.code, plan.marker.targetUrl);
      return { bothPodsRedirect: true };
    }
    if (phase === "open") {
      check();
      await mutateTarget(admitTargetSql(plan));
      return switchControl(journal, phase, { creationMode: "accept" }, check);
    }
    if (phase === "canary") {
      // A replay only inspects the uniquely tagged write. It must never repeat POST.
      if (!replay) {
        try {
          await postCanary(plan.canaryUrl);
        } catch {
          /* Inspect the database for an ambiguous acknowledgement. */
        }
      }
      const matches = await json(
        target(
          `SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT code,target_url FROM links WHERE target_url=${quoted(plan.canaryUrl)})x;`,
        ),
      );
      assert.equal(
        matches.length,
        1,
        "Canary outcome is ambiguous; do not repeat its POST",
      );
      assert.equal(
        (
          await source(
            `SELECT count(*) FROM links WHERE target_url=${quoted(plan.canaryUrl)};`,
          )
        ).trim(),
        "0",
      );
      await probe(matches[0].code, plan.canaryUrl);
      return { code: matches[0].code, foundOnlyOnHa: true };
    }
    if (phase === "audit") {
      await reconcile(journal);
      await checkApplication();
      return {
        sourceFenced: true,
        haSelected: true,
        subscriberDisabled: true,
        slotRetained: true,
      };
    }
    throw new Error("Unknown cutover phase");
  }
  async function abortSource(journal, check) {
    assert.ok(
      recovery(journal).abortToSourceAllowed,
      "Fence was attempted; automatic source recovery is forbidden",
    );
    const state = await inspect();
    assert.deepEqual(state.binding, plan.binding);
    assertRole(state.sourceRole, false);
    assert.equal(state.status.desired.activeDatabase, "source");
    assert.ok(state.subscription.subenabled);
    assert.notEqual(journal.status, "aborted");
    journal.status = "aborting";
    await save(journal);
    journal.steps["abort-gate"] ??= { intentAt: Date.now() };
    if (!journal.steps["abort-gate"].completedAt) {
      await save(journal);
      await switchControl(
        journal,
        "abort-gate",
        {
          creationMode: "reject",
          activeDatabase: "source",
          prepareDatabase: null,
        },
        check,
      );
      journal.steps["abort-gate"].completedAt = Date.now();
      await save(journal);
    }
    journal.steps["abort-open"] ??= { intentAt: Date.now() };
    if (!journal.steps["abort-open"].completedAt) {
      await save(journal);
      await switchControl(
        journal,
        "abort-open",
        { creationMode: "accept" },
        check,
      );
      journal.steps["abort-open"].completedAt = Date.now();
    }
    journal.status = "aborted";
    await save(journal);
  }
  return { save, reconcile, step, checkInterrupted, abortSource };
}
