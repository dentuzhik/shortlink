import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { coordinate, hash, validatePlan } from "./cutover.mjs";
import {
  assertRole,
  cutoverAdapter,
  roleSql,
  subscriptionSql,
} from "./cutover-live.mjs";
import { acknowledged, assertFixture, fixtureNamespace } from "./handoff.mjs";
import { schemaSql } from "./live-replication.mjs";

// Real Kubernetes/Postgres/HTTP I/O, always confined to a run-owned disposable namespace.
export async function successfulCoordinator({
  runId,
  namespace,
  path,
  kube,
  get,
  sql,
  statuses,
  event,
  isInterrupted,
}) {
  assert.equal(namespace, fixtureNamespace(runId));
  const owned = async () =>
    assertFixture(await get(["get", "namespace", namespace]), runId);
  await owned();
  assert.equal(
    (await sql("source", "SHOW shortlink.handoff_fixture;")).trim(),
    runId,
  );
  const scopedKube = async (args, input) => {
    await owned();
    if (args[0] === "create" && input) {
      const resource = JSON.parse(input);
      assert.equal(resource.metadata.namespace, namespace);
    }
    return kube(args, input);
  };
  const scopedGet = async (args) =>
    JSON.parse(await scopedKube([...args, "-o", "json"]));
  const sourceSql = async (text) => {
    await owned();
    return sql("source", text);
  };
  const targetSql = async (text, database = "shortener", pod) => {
    assert.equal(database, "shortener");
    await owned();
    if (pod) {
      const pods = (await get(["get", "pods", "-l", "app=handoff-target"]))
        .items;
      assert.ok(pods.some((p) => p.metadata.name === pod));
    }
    return sql("target", text);
  };
  const read = (side, text) => sql(side, `BEGIN READ ONLY; ${text} COMMIT;`);
  const json = async (value) => JSON.parse(await value);
  const identitySql =
    "SELECT json_build_object('systemId',(SELECT system_identifier::text FROM pg_control_system()),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'linksOid','links'::regclass::oid::text,'historyOid','drizzle.__drizzle_migrations'::regclass::oid::text);";
  const runtime = async () => ({
    desired: JSON.parse(
      (await get(["get", "configmap", "shortlink-runtime"])).data[
        "control.json"
      ],
    ),
    pods: await statuses(),
  });
  const targetPods = async () =>
    (await get(["get", "pods", "-l", "app=handoff-target"])).items;
  const optionalJournal = async () => {
    const raw = await scopedKube([
      "get",
      "configmap",
      "database-cutover",
      "--ignore-not-found",
      "-o",
      "json",
    ]);
    if (!raw.trim()) return null;
    const object = JSON.parse(raw);
    assert.equal(object.metadata.namespace, namespace);
    assert.equal(
      object.metadata.labels["shortlink.dev/exercise"],
      "live-cutover",
    );
    return object;
  };
  async function inspect() {
    await owned();
    const ns = await get(["get", "namespace", namespace]);
    const deployment = await get(["get", "deployment", "handoff-api"]);
    assert.equal(deployment.spec.replicas, 2);
    assert.equal(deployment.status.availableReplicas, 2);
    const api = (await get(["get", "pods", "-l", "app=handoff-api"])).items;
    const sourcePods = (await get(["get", "pods", "-l", "app=handoff-source"]))
      .items;
    const targets = await targetPods();
    assert.equal(api.length, 2);
    assert.equal(sourcePods.length, 1);
    assert.equal(targets.length, 1);
    assert.ok(
      [...api, ...sourcePods, ...targets].every(
        (p) =>
          !p.metadata.deletionTimestamp &&
          p.status.conditions.some(
            (c) => c.type === "Ready" && c.status === "True",
          ),
      ),
    );
    const control = await get(["get", "configmap", "shortlink-runtime"]);
    const secret = await get(["get", "secret", "handoff-private"]);
    const watch = await get([
      "get",
      "configmap",
      "migration-replication-watch",
    ]);
    const sourceRole = await json(read("source", roleSql));
    const haRole = await json(read("target", roleSql));
    assertRole(sourceRole, true);
    assertRole(haRole, false);
    const subscription = await json(read("target", subscriptionSql));
    assert.ok(subscription);
    assert.equal(subscription.subslotname, "shortlink_migration_sub");
    const schemas = [
      await json(read("source", schemaSql)),
      await json(read("target", schemaSql)),
    ];
    assert.deepEqual(...schemas);
    const binding = {
      namespaceUid: ns.metadata.uid,
      deploymentUid: deployment.metadata.uid,
      deploymentSpecHash: hash(deployment.spec),
      pods: api
        .map((p) => ({ name: p.metadata.name, uid: p.metadata.uid }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      controlUid: control.metadata.uid,
      sourcePodUid: sourcePods[0].metadata.uid,
      primary: targets[0].metadata.name,
      primaryUid: targets[0].metadata.uid,
      secret: {
        uid: secret.metadata.uid,
        version: secret.metadata.resourceVersion,
      },
      source: await json(read("source", identitySql)),
      ha: await json(read("target", identitySql)),
      subscriptionOid: subscription.oid,
      watchUid: watch.metadata.uid,
      schemaHash: hash(schemas[0]),
    };
    return {
      binding,
      status: await runtime(),
      sourceRole,
      haRole,
      subscription,
    };
  }
  const initial = await inspect();
  assert.ok(acknowledged(initial.status.pods, initial.status.desired));
  assert.ok(initial.sourceRole.can_insert && initial.sourceRole.can_allocate);
  assert.equal(await optionalJournal(), null);
  const id = randomBytes(16).toString("hex");
  const body = {
    format: "shortlink-cutover-v1",
    id,
    initialControl: initial.status.desired,
    binding: initial.binding,
    marker: {
      code: randomBytes(6).toString("base64url"),
      targetUrl: `https://example.invalid/cutover/${id}`,
    },
    canaryUrl: `https://example.invalid/cutover-canary/${id}`,
    fixture: { namespace, runId },
  };
  const plan = validatePlan({ ...body, planHash: hash(body) });
  await writeFile(
    `${path}/coordinator-plan.json`,
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  const journal = {
    format: "shortlink-cutover-journal-v1",
    id,
    planHash: plan.planHash,
    status: "prepared",
    steps: {},
    runtime: initial.status.desired,
  };
  let canaryResponse;
  const adapter = cutoverAdapter(plan, path, null, isInterrupted, {
    namespace,
    appKube: scopedKube,
    appGet: scopedGet,
    sourceSql,
    targetSql,
    targetPods,
    runtime,
    inspect,
    optionalJournal,
    checkApplication: async () => {
      const state = await runtime();
      assert.ok(acknowledged(state.pods, state.desired));
      assert.equal(state.desired.activeDatabase, "ha");
    },
    postCanary: async (url) => {
      const script =
        'const [endpoint,targetUrl]=process.argv.slice(1);const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetUrl}),signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({status:response.status,body:await response.json()}));';
      canaryResponse = JSON.parse(
        await scopedKube([
          "exec",
          plan.binding.pods[0].name,
          "--",
          "node",
          "--input-type=module",
          "-e",
          script,
          `http://handoff-api.${namespace}.svc.cluster.local:3000/links`,
          url,
        ]),
      );
      await writeFile(
        `${path}/canary-response.json`,
        `${JSON.stringify(canaryResponse, null, 2)}\n`,
      );
    },
  });
  const execute = adapter.step;
  adapter.step = async (phase, ...args) => {
    await event(`coordinator:${phase}`);
    return execute(phase, ...args);
  };
  // A fixture test timeout, not a proposed production maintenance budget.
  await coordinate(plan, journal, adapter, { stopAfterMs: 45000 });
  assert.equal(journal.status, "complete");
  assert.equal(canaryResponse.status, 201);
  const final = await inspect();
  assert.deepEqual(final.binding, initial.binding);
  assert.equal(final.sourceRole.can_insert, false);
  assert.equal(final.sourceRole.can_allocate, false);
  assert.equal(final.sourceRole.can_read, true);
  assert.ok(!final.subscription.subenabled && final.subscription.workers === 0);
  assert.ok(acknowledged(final.status.pods, final.status.desired));
  assert.equal(final.status.desired.activeDatabase, "ha");
  assert.equal(final.status.desired.creationMode, "accept");
  assert.equal(
    (
      await read(
        "source",
        "SELECT count(*) FROM pg_replication_slots WHERE slot_name='shortlink_migration_sub';",
      )
    ).trim(),
    "1",
  );
  return {
    plan,
    journal,
    finalStatus: final.status,
    sourceRole: final.sourceRole,
    canary: canaryResponse,
    slotRetained: true,
    interruptionInjection: false,
  };
}
