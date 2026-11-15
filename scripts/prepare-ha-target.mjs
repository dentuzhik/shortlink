import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  appGet,
  appKube,
  dbGet,
  directory,
  ensure,
  hash,
  network,
  run,
  sourceState,
  vmAddresses,
} from "./lib/db-lab-connectivity.mjs";
import {
  assertSourceStatus,
  haTargetData,
  haTemplate,
  hostname,
  secretName,
  withoutHaTarget,
} from "./lib/ha-target.mjs";
import { primary, targetSql } from "./lib/live-replication.mjs";

const [action, ...extra] = process.argv.slice(2);
ensure(
  ["stage", "rollout", "verify"].includes(action) && !extra.length,
  "Use prepare-ha-target.mjs stage|rollout|verify; this command never activates HA",
);
const applicationRoles = await appKube([
  "get",
  "configmap",
  "runtime-application-roles",
  "--ignore-not-found",
  "-o",
  "json",
]);
ensure(
  !applicationRoles.trim(),
  "Dedicated runtime roles are staged; use db:app-roles verify instead of restoring the legacy HA owner login",
);
const path = await directory("ha-target-preparation");
const report = { startedAt: new Date().toISOString(), action, passed: false };
const runtime = async (args = ["status"]) =>
  JSON.parse(
    await run(
      "node",
      ["scripts/runtime-maintenance.mjs", ...args],
      undefined,
      45000,
    ),
  );
const deployment = () => appGet(["get", "deployment", "redirect-service"]);
async function readSecretData() {
  const credentials = (await dbGet(["get", "secret", "shortlink-lab-app"]))
    .data;
  const ca = (await dbGet(["get", "secret", "shortlink-lab-ca"])).data[
    "ca.crt"
  ];
  const cert = new X509Certificate(Buffer.from(ca, "base64"));
  ensure(
    cert.ca &&
      Date.parse(cert.validFrom) <= Date.now() &&
      Date.parse(cert.validTo) > Date.now(),
    "HA CA is invalid or expired",
  );
  report.caFingerprint256 = cert.fingerprint256;
  return haTargetData(credentials, ca);
}
try {
  report.sourceBefore = await sourceState();
  const before = await deployment();
  const status = await runtime();
  assertSourceStatus(status, action === "verify");
  report.runtimeBefore = status;
  ensure(
    before.spec.replicas === 2 &&
      before.status.updatedReplicas === 2 &&
      before.status.availableReplicas === 2 &&
      before.status.observedGeneration === before.metadata.generation,
    "Expected two stable Fastify replicas with no active rollout",
  );
  ensure(
    before.spec.strategy.rollingUpdate.maxUnavailable === 0 &&
      before.spec.strategy.rollingUpdate.maxSurge === 1,
    "Expected the qualified rolling update strategy",
  );
  report.image = before.spec.template.spec.containers.find(
    (c) => c.name === "api",
  ).image;
  const sourcePostgres = await appGet(["get", "deployment", "postgres"]);
  const sourceLogin = await appGet(["get", "secret", "postgres-credentials"]);
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  report.primary = await primary();
  ensure(
    cluster.spec.certificates.serverAltDNSNames.includes(hostname) &&
      network.serviceHostname === hostname,
    "HA TLS hostname differs from the configured Service",
  );
  const addresses = await vmAddresses();
  const slice = await appGet(["get", "endpointslice", "db-lab-primary-vm"]);
  ensure(
    slice.endpoints.length === 1 &&
      slice.endpoints[0].addresses[0] === addresses.database &&
      slice.ports[0].port === network.listenPort,
    "HA EndpointSlice is stale; inspect database connectivity before preparation",
  );
  const wiring = JSON.parse(
    await readFile("deploy/migration/fastify-ha-target.json", "utf8"),
  );
  const template = haTemplate(before.spec.template, wiring);
  assert.deepEqual(
    withoutHaTarget(template),
    withoutHaTarget(before.spec.template),
  );
  const data = await readSecretData();
  const existing = await appKube([
    "get",
    "secret",
    secretName,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  let secret = existing.trim() ? JSON.parse(existing) : null;
  if (secret) {
    ensure(
      secret.immutable === true &&
        secret.metadata.labels?.["shortlink.dev/exercise"] === "ha-target" &&
        Object.keys(secret.data).length === Object.keys(data).length &&
        Object.entries(data).every(
          ([key, value]) => secret.data[key] === value,
        ),
      "Existing HA target Secret differs; credential rotation requires a separately reviewed rollout",
    );
  } else {
    ensure(action === "stage", "Stage the HA target Secret before rolling out");
    secret = JSON.parse(
      await appKube(
        ["create", "-f", "-", "-o", "json"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          type: "Opaque",
          immutable: true,
          metadata: {
            name: secretName,
            namespace: "shortlink",
            labels: { "shortlink.dev/exercise": "ha-target" },
          },
          data,
        }),
      ),
    );
  }
  report.secret = {
    name: secretName,
    resourceVersion: secret.metadata.resourceVersion,
    immutable: true,
  };
  if (action === "rollout") {
    ensure(
      !isDeepStrictEqual(template, before.spec.template),
      "HA target wiring is already installed; use verify or explicitly prepare the candidate",
    );
    // JSON Patch tests prevent replacing a concurrently edited Deployment.
    const patch = JSON.stringify([
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: before.metadata.resourceVersion,
      },
      { op: "replace", path: "/spec/template", value: template },
    ]);
    const dryRun = JSON.parse(
      await appKube(
        [
          "patch",
          "deployment",
          "redirect-service",
          "--type=json",
          "--patch-file=/dev/stdin",
          "--dry-run=server",
          "-o",
          "json",
        ],
        patch,
      ),
    );
    assert.deepEqual(
      withoutHaTarget(dryRun.spec.template),
      withoutHaTarget(before.spec.template),
    );
    assertSourceStatus(await runtime());
    report.rolloutStartedAt = new Date().toISOString();
    await appKube(
      [
        "patch",
        "deployment",
        "redirect-service",
        "--type=json",
        "--patch-file=/dev/stdin",
      ],
      patch,
    );
    await appKube(
      ["rollout", "status", "deployment/redirect-service", "--timeout=90s"],
      undefined,
      95000,
    );
    // Terminating pods may still receive requests. Wait for removal before preparing.
    const deadline = Date.now() + 30000;
    while (true) {
      const pods = (await appGet(["get", "pods", "-l", "app=redirect-service"]))
        .items;
      if (pods.length === 2 && pods.every((p) => !p.metadata.deletionTimestamp))
        break;
      ensure(
        Date.now() < deadline,
        "Old Fastify pods have not terminated; inspect runtime status",
      );
      await delay(200);
    }
    report.rolloutCompletedAt = new Date().toISOString();
    assertSourceStatus(await runtime());
    report.runtimeAfter = await runtime(["prepare", "ha"]);
    assertSourceStatus(report.runtimeAfter, true);
    report.preparedAt = new Date().toISOString();
  } else report.runtimeAfter = await runtime();
  const after = await deployment();
  assert.deepEqual(
    withoutHaTarget(after.spec.template),
    withoutHaTarget(before.spec.template),
  );
  assert.deepEqual(
    after.spec.template,
    action === "stage" ? before.spec.template : template,
    "Unexpected Fastify template change",
  );
  ensure(
    hash((await appGet(["get", "deployment", "postgres"])).spec) ===
      hash(sourcePostgres.spec),
    "Source Postgres configuration changed",
  );
  ensure(
    (await appGet(["get", "secret", "postgres-credentials"])).metadata
      .resourceVersion === sourceLogin.metadata.resourceVersion,
    "Source credentials changed",
  );
  ensure(
    hash((await dbGet(["get", "cluster", "shortlink-lab"])).spec) ===
      hash(cluster.spec),
    "CNPG configuration changed",
  );
  ensure(
    (await primary()) === report.primary,
    "HA primary changed during preparation; revalidate",
  );
  if (action !== "stage") {
    assertSourceStatus(report.runtimeAfter, true);
    report.haSessions = JSON.parse(
      await targetSql(`SELECT coalesce(json_agg(x),'[]'::json) FROM (
      SELECT a.pid,a.datname,a.usename,a.application_name,a.state,s.ssl,s.version,s.cipher
      FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid)
      WHERE a.datname='shortener' AND a.usename='shortlink_lab' AND a.application_name='redirect-service'
    )x;`),
    );
    ensure(
      report.haSessions.length === 2 &&
        report.haSessions.every((s) => s.ssl && s.state === "idle"),
      "Expected one idle TLS candidate connection per Fastify replica",
    );
    report.sequences = JSON.parse(
      await targetSql(
        "SELECT json_build_object('lastValue',(SELECT last_value::text FROM public.links_id_seq),'isCalled',(SELECT is_called FROM public.links_id_seq),'maxId',(SELECT max(id)::text FROM public.links));",
      ),
    );
    ensure(
      report.sequences.lastValue === "1" && !report.sequences.isCalled,
      "Destination identity sequence changed; investigate possible application writes",
    );
  }
  report.sourceAfter = await sourceState();
  report.passed = true;
} catch (error) {
  report.error =
    error.code === "ERR_ASSERTION"
      ? "HA preparation invariant failed; inspect private evidence and runtime status"
      : error.message;
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      action,
      evidence: `${path}/result.json`,
    }),
  );
}
