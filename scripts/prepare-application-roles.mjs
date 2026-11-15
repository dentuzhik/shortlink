import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertHaRolePolicy,
  caPath,
  haSecretName,
  haUrl,
  hbaBlock,
  roleName,
  runtimeTemplate,
  secretName,
  sourceHostname,
  sourceUrl,
  stateName,
  withoutRuntimeCredentials,
} from "./lib/application-roles.mjs";
import {
  appGet,
  appKube,
  dbGet,
  dbKube,
  directory,
  ensure,
  hash,
  run,
  sourceState,
} from "./lib/db-lab-connectivity.mjs";
import { assertSourceStatus } from "./lib/ha-target.mjs";
import {
  state as replicationState,
  sourceSql,
  targetSql,
} from "./lib/live-replication.mjs";

process.env.DOCKER_CONTEXT = "colima";
const [action, revision, ...extra] = process.argv.slice(2);
ensure(
  ["stage", "rollout", "verify"].includes(action) &&
    !extra.length &&
    (revision === undefined || /^[a-f0-9]{40}$/.test(revision)) &&
    (action !== "rollout" || revision) &&
    (action !== "verify" || revision === undefined),
  "Use prepare-application-roles.mjs stage [FULL_SHA] | rollout FULL_SHA | verify",
);
const path = await directory("application-roles");
const id = randomBytes(6).toString("hex");
const labels = { "shortlink.dev/exercise": "application-roles" };
const report = {
  action,
  revision,
  startedAt: new Date().toISOString(),
  passed: false,
  probes: [],
};
const temporary = [];
const getOptional = async (kube, kind, name) => {
  const output = await kube([
    "get",
    kind,
    name,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  return output.trim() ? JSON.parse(output) : null;
};
const runtime = async () =>
  JSON.parse(await run("node", ["scripts/runtime-maintenance.mjs", "status"]));
async function waitFor(work, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!(await work())) {
    ensure(Date.now() < end, message);
    await delay(500);
  }
}
async function snapshot() {
  const status = await runtime();
  assertSourceStatus(status, true);
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three healthy HA instances",
  );
  return {
    status,
    app: await sourceState(),
    deployment: (await appGet(["get", "deployment", "redirect-service"])).spec,
    postgres: hash((await appGet(["get", "deployment", "postgres"])).spec),
    postgresUid: (
      await appGet(["get", "pods", "-l", "app=postgres"])
    ).items.map((p) => p.metadata.uid),
    operatorSecretVersion: (
      await appGet(["get", "secret", "postgres-credentials"])
    ).metadata.resourceVersion,
    cluster: cluster.spec,
    databasePods: (
      await dbGet([
        "get",
        "pods",
        "-l",
        "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
      ])
    ).items
      .map((p) => p.metadata.uid)
      .sort(),
    sequences: JSON.parse(
      await targetSql(
        "SELECT json_build_object('links',(SELECT last_value::text FROM links_id_seq),'linksCalled',(SELECT is_called FROM links_id_seq),'history',(SELECT last_value::text FROM drizzle.__drizzle_migrations_id_seq),'historyCalled',(SELECT is_called FROM drizzle.__drizzle_migrations_id_seq));",
      ),
    ),
  };
}
async function createSecret(kube, namespace, name, data, type = "Opaque") {
  const previous = await getOptional(kube, "secret", name);
  if (previous) {
    ensure(
      previous.immutable === true &&
        previous.metadata.labels?.["shortlink.dev/exercise"] ===
          labels["shortlink.dev/exercise"],
      "Existing runtime Secret is unmanaged",
    );
    assert.deepEqual(
      previous.data,
      data,
      "Runtime Secret differs; rotate credentials in a separate reviewed increment",
    );
    return previous;
  }
  return JSON.parse(
    await kube(
      ["create", "-f", "-", "-o", "json"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        type,
        immutable: true,
        metadata: { name, namespace, labels },
        data,
      }),
    ),
  );
}
const encode = (value) => Buffer.from(value).toString("base64");
const decode = (value) => Buffer.from(value, "base64").toString("utf8");
async function sourceCredentials() {
  const ca = (await appGet(["get", "secret", "source-publisher-ca"])).data[
    "ca.crt"
  ];
  const existing = await getOptional(appKube, "secret", secretName);
  if (existing) {
    ensure(
      existing.immutable === true &&
        existing.metadata.labels?.["shortlink.dev/exercise"] ===
          labels["shortlink.dev/exercise"] &&
        existing.data["ca.crt"] === ca,
      "Source credential Secret/trust differs from this exercise",
    );
    const url = new URL(decode(existing.data.url));
    ensure(
      decodeURIComponent(url.username) === roleName &&
        url.hostname === sourceHostname &&
        url.pathname === "/shortener" &&
        url.searchParams.get("sslmode") === "verify-full" &&
        url.searchParams.get("sslrootcert") === caPath,
      "Unexpected source URL identity or TLS policy",
    );
    await sourceSql(
      await readFile("deploy/migration/application-runtime-role.sql", "utf8"),
    );
    await sourceSql("ALTER ROLE shortlink_app LOGIN;");
    return existing;
  }
  const prior = JSON.parse(
    await sourceSql(
      "SELECT json_build_object('role',(SELECT json_build_object('login',rolcanlogin,'comment',shobj_description(oid,'pg_authid')) FROM pg_roles WHERE rolname='shortlink_app'),'sessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='shortlink_app'));",
    ),
  );
  ensure(
    !prior.role ||
      (!prior.role.login &&
        prior.role.comment === "shortlink:runtime-application:v1" &&
        Number(prior.sessions) === 0),
    "Existing source runtime login requires inspection; no password was reset",
  );
  await sourceSql(
    await readFile("deploy/migration/application-runtime-role.sql", "utf8"),
  );
  const password = randomBytes(24).toString("hex");
  await appKube(
    [
      "exec",
      "-i",
      "deployment/postgres",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "shortener",
      "-d",
      "shortener",
      "-c",
      "\\password shortlink_app",
    ],
    `${password}\n${password}\n`,
  );
  const secret = await createSecret(appKube, "shortlink", secretName, {
    url: encode(sourceUrl(password)),
    "ca.crt": ca,
  });
  await sourceSql("ALTER ROLE shortlink_app LOGIN;");
  return secret;
}
async function prepareSourceHba() {
  const desired = await readFile("deploy/migration/pg_hba.conf", "utf8");
  ensure(desired.includes(hbaBlock), "Dedicated runtime HBA block is missing");
  const before = await appGet(["get", "configmap", "source-publisher-hba"]);
  ensure(
    [desired, desired.replace(hbaBlock, "")].includes(
      before.data["pg_hba.conf"],
    ),
    "Source HBA has independent changes; refusing to overwrite them",
  );
  if (before.data["pg_hba.conf"] !== desired)
    await appKube(
      [
        "patch",
        "configmap",
        "source-publisher-hba",
        "--type=json",
        "--patch-file=/dev/stdin",
      ],
      JSON.stringify([
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: before.metadata.resourceVersion,
        },
        { op: "replace", path: "/data/pg_hba.conf", value: desired },
      ]),
    );
  await waitFor(
    async () =>
      (await appKube([
        "exec",
        "deployment/postgres",
        "--",
        "cat",
        "/etc/postgresql/publisher-hba/pg_hba.conf",
      ])) === desired,
    "Projected source HBA did not update; no PostgreSQL restart was requested",
    150000,
  );
  ensure(
    (await sourceSql("SELECT pg_reload_conf();")).trim() === "t",
    "PostgreSQL rejected authentication reload",
  );
  report.sourceHba = JSON.parse(
    await sourceSql(
      "SELECT json_build_object('errors',(SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL),'application',(SELECT json_agg(x) FROM (SELECT type,database,user_name,auth_method FROM pg_hba_file_rules WHERE user_name @> ARRAY['shortlink_app'])x));",
    ),
  );
  ensure(
    Number(report.sourceHba.errors) === 0 &&
      report.sourceHba.application.length === 3,
    "Reloaded source HBA rules are invalid",
  );
}
async function haCredentials() {
  const loginName = "shortlink-runtime-login";
  const prior = await getOptional(dbKube, "secret", loginName);
  const role = await getOptional(dbKube, "databaserole", "shortlink-runtime");
  if (role)
    ensure(
      role.metadata.labels?.["shortlink.dev/exercise"] ===
        labels["shortlink.dev/exercise"],
      "HA runtime role is managed elsewhere",
    );
  if (!prior) {
    ensure(
      (
        await targetSql(
          "SELECT count(*) FROM pg_roles WHERE rolname='shortlink_app';",
        )
      ).trim() === "0",
      "An existing HA runtime role has no owned password Secret",
    );
  }
  const data = prior?.data ?? {
    username: encode(roleName),
    password: encode(randomBytes(24).toString("hex")),
  };
  ensure(decode(data.username) === roleName, "Unexpected HA runtime principal");
  await createSecret(
    dbKube,
    "database-lab",
    loginName,
    data,
    "kubernetes.io/basic-auth",
  );
  if (!role)
    await dbKube(["create", "-f", "deploy/db-lab/application-role.yaml"]);
  else {
    const expected = JSON.parse(
      await dbKube([
        "create",
        "--dry-run=client",
        "-f",
        "deploy/db-lab/application-role.yaml",
        "-o",
        "json",
      ]),
    );
    assertHaRolePolicy(role.spec, expected.spec);
  }
  await waitFor(
    async () => {
      const object = await dbGet(["get", "databaserole", "shortlink-runtime"]);
      return (
        object.status?.applied === true &&
        object.status.observedGeneration === object.metadata.generation
      );
    },
    "CNPG did not reconcile the runtime role",
    60000,
  );
  await targetSql(
    await readFile("deploy/migration/application-runtime-role.sql", "utf8"),
  );
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  const rules = cluster.spec.postgresql.pg_hba ?? [];
  const additions = [
    "hostssl shortener shortlink_app all scram-sha-256",
    "host all shortlink_app all reject",
    "host replication shortlink_app all reject",
  ];
  ensure(
    !rules.some(
      (rule) => rule.includes("shortlink_app") && !additions.includes(rule),
    ),
    "Independent HA runtime HBA rules exist",
  );
  const next = [
    ...additions,
    ...rules.filter((rule) => !additions.includes(rule)),
  ];
  if (JSON.stringify(next) !== JSON.stringify(rules))
    await dbKube(
      [
        "patch",
        "cluster",
        "shortlink-lab",
        "--type=json",
        "--patch-file=/dev/stdin",
      ],
      JSON.stringify([
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: cluster.metadata.resourceVersion,
        },
        { op: "replace", path: "/spec/postgresql/pg_hba", value: next },
      ]),
    );
  await waitFor(
    async () => {
      const pods = (
        await dbGet([
          "get",
          "pods",
          "-l",
          "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
        ])
      ).items;
      for (const pod of pods) {
        const count = await targetSql(
          "SELECT count(*) FROM pg_hba_file_rules WHERE user_name @> ARRAY['shortlink_app'];",
          "shortener",
          pod.metadata.name,
        );
        if (count.trim() !== "3") return false;
      }
      return true;
    },
    "HA authentication rules did not propagate",
    90000,
  );
  const ca = (await dbGet(["get", "secret", "shortlink-lab-ca"])).data[
    "ca.crt"
  ];
  return createSecret(appKube, "shortlink", haSecretName, {
    url: encode(haUrl(decode(data.password))),
    "ca.crt": ca,
  });
}
async function probe(side, secret, image) {
  const name = `app-role-${side}-${id}`;
  const marker = { ...labels, "shortlink.dev/probe-run": id };
  await appKube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, namespace: "shortlink", labels: marker },
      data: {
        "probe.cjs": await readFile("scripts/source-role-probe.cjs", "utf8"),
      },
    }),
  );
  temporary.push(["configmap", name]);
  await appKube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: "shortlink", labels: marker },
      spec: {
        restartPolicy: "Never",
        activeDeadlineSeconds: 45,
        automountServiceAccountToken: false,
        containers: [
          {
            name: "probe",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "--max-old-space-size=48", "/probe/probe.cjs"],
            env: [
              {
                name: "DATABASE_URL",
                valueFrom: { secretKeyRef: { name: secret, key: "url" } },
              },
            ],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { memory: "128Mi" },
            },
            volumeMounts: [
              { name: "probe", mountPath: "/probe", readOnly: true },
              { name: "ca", mountPath: "/source-db", readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "probe", configMap: { name } },
          {
            name: "ca",
            secret: {
              secretName: secret,
              items: [{ key: "ca.crt", path: "ca.crt" }],
            },
          },
        ],
      },
    }),
  );
  temporary.push(["pod", name]);
  let object;
  await waitFor(
    async () => {
      object = await appGet(["get", "pod", name]);
      return ["Succeeded", "Failed"].includes(object.status.phase);
    },
    "Runtime role probe did not complete",
    60000,
  );
  const logs = await appKube(["logs", name]);
  await writeFile(`${path}/${side}-probe.log`, logs);
  ensure(
    object.status.phase === "Succeeded",
    `The ${side} runtime role probe failed; inspect its private log`,
  );
  const value = JSON.parse(logs);
  ensure(value.passed, "Role probe did not acknowledge success");
  report.probes.push({ side, ...value });
}
async function marker(status, release) {
  const before = await getOptional(appKube, "configmap", stateName);
  const data = {
    status,
    role: roleName,
    secret: secretName,
    haSecret: haSecretName,
    ...(before?.data.image
      ? {
          image: before.data.image,
          revision: before.data.revision,
          digest: before.data.digest,
          indexDigest: before.data.indexDigest,
        }
      : {}),
    ...(release
      ? {
          image: release.image,
          revision: release.revision,
          digest: release.digest,
          indexDigest: release.indexDigest,
        }
      : {}),
  };
  if (!before)
    await appKube(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: stateName, namespace: "shortlink", labels },
        data,
      }),
    );
  else {
    ensure(
      before.metadata.labels?.["shortlink.dev/exercise"] ===
        labels["shortlink.dev/exercise"],
      "Runtime role state is unmanaged",
    );
    await appKube(
      [
        "patch",
        "configmap",
        stateName,
        "--type=json",
        "--patch-file=/dev/stdin",
      ],
      JSON.stringify([
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: before.metadata.resourceVersion,
        },
        { op: "replace", path: "/data", value: data },
      ]),
    );
  }
}
async function verifySessions() {
  report.sourceSessions = JSON.parse(
    await sourceSql(
      "SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT a.usename,s.ssl,count(*)::int AS sessions FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.application_name='redirect-service' GROUP BY a.usename,s.ssl)x;",
    ),
  );
  ensure(
    report.sourceSessions.length > 0 &&
      report.sourceSessions.every((s) => s.usename === roleName && s.ssl) &&
      report.sourceSessions.reduce((n, s) => n + s.sessions, 0) >= 2,
    "Fastify still has an administrator source connection or lacks runtime TLS sessions",
  );
  report.haSessions = JSON.parse(
    await targetSql(
      "SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT a.usename,s.ssl,count(*)::int AS sessions FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.application_name='redirect-service' AND a.datname='shortener' GROUP BY a.usename,s.ssl)x;",
    ),
  );
  ensure(
    report.haSessions.length > 0 &&
      report.haSessions.every((s) => s.usename === roleName && s.ssl) &&
      report.haSessions.reduce((n, s) => n + s.sessions, 0) >= 2,
    "HA candidates still use the owner or lack runtime TLS sessions",
  );
}
try {
  report.before = await snapshot();
  const before = await appGet(["get", "deployment", "redirect-service"]);
  const image = before.spec.template.spec.containers.find(
    (c) => c.name === "api",
  ).image;
  const state = await getOptional(appKube, "configmap", stateName);
  if (action === "stage") {
    await sourceCredentials();
    await prepareSourceHba();
    await haCredentials();
    await probe("source", secretName, image);
    await probe("ha", haSecretName, image);
    let release;
    if (revision) {
      ensure(
        (
          await run("git", [
            "show",
            `${revision}:apps/redirect-service/src/server.ts`,
          ])
        ).includes("readDatabaseUser"),
        "Selected image predates configurable HA runtime identity",
      );
      const staged = await run(
        "node",
        ["scripts/release-redirect.mjs", "stage", revision],
        undefined,
        180000,
      );
      const evidence = staged.match(/Release evidence: (.+)/)?.[1];
      ensure(evidence, "Image staging did not return evidence");
      const record = JSON.parse(
        await readFile(`${evidence}/operation.json`, "utf8"),
      );
      ensure(
        record.passed && record.release.revision === revision,
        "Staged image revision mismatch",
      );
      release = record.release;
      report.release = release;
    }
    await marker(
      state?.data.status === "enabled" ? "enabled" : "prepared",
      release,
    );
  } else if (action === "rollout") {
    ensure(
      state?.data.revision === revision &&
        state.data.image?.includes(`:${revision}@sha256:`),
      "Stage the published role-aware image before rollout",
    );
    report.release = state.data;
    const base = structuredClone(before.spec.template);
    const api = base.spec.containers.find((c) => c.name === "api");
    api.image = state.data.image;
    api.imagePullPolicy = "IfNotPresent";
    base.metadata.annotations = {
      ...base.metadata.annotations,
      "shortlink.dev/git-revision": revision,
      "shortlink.dev/image-digest": state.data.digest,
      "shortlink.dev/registry-index-digest": state.data.indexDigest,
    };
    const template = runtimeTemplate(base);
    assert.deepEqual(
      withoutRuntimeCredentials(template),
      withoutRuntimeCredentials(base),
    );
    const patch = JSON.stringify([
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: before.metadata.resourceVersion,
      },
      { op: "replace", path: "/spec/template", value: template },
    ]);
    const dry = JSON.parse(
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
    assert.deepEqual(dry.spec.template, template);
    await marker("enabled");
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
    await waitFor(async () => {
      const pods = (await appGet(["get", "pods", "-l", "app=redirect-service"]))
        .items;
      return (
        pods.length === 2 && pods.every((p) => !p.metadata.deletionTimestamp)
      );
    }, "Old application pods have not drained");
    assertSourceStatus(await runtime(), true);
    await verifySessions();
    report.rolloutCompletedAt = new Date().toISOString();
  } else {
    ensure(
      state?.data.status === "enabled",
      "Runtime role wiring has not been enabled",
    );
    assert.deepEqual(
      runtimeTemplate(before.spec.template),
      before.spec.template,
    );
    await probe("source", secretName, image);
    await probe("ha", haSecretName, image);
    await verifySessions();
  }
  report.after = await snapshot();
  assert.deepEqual(report.after.status.desired, report.before.status.desired);
  for (const key of [
    "postgres",
    "postgresUid",
    "operatorSecretVersion",
    "databasePods",
    "sequences",
  ])
    assert.deepEqual(
      report.after[key],
      report.before[key],
      `Unexpected live change: ${key}`,
    );
  const withoutHba = (spec) => {
    const copy = structuredClone(spec);
    delete copy.postgresql.pg_hba;
    return copy;
  };
  assert.deepEqual(
    withoutHba(report.after.cluster),
    withoutHba(report.before.cluster),
  );
  if (action !== "rollout")
    assert.deepEqual(report.after.deployment, report.before.deployment);
  report.replication = await replicationState();
  ensure(
    report.replication.source.slots.some(
      (s) => s.slot_name === "shortlink_migration_sub" && s.active,
    ),
    "Source migration slot is not active",
  );
  report.passed = true;
} catch (error) {
  report.error =
    error.code === "ERR_ASSERTION"
      ? "Application-role invariant failed; inspect private evidence"
      : error.message;
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.cleanupErrors = [];
  for (const [kind, name] of temporary.reverse()) {
    try {
      const object = await appGet(["get", kind, name]);
      ensure(
        object.metadata.labels?.["shortlink.dev/probe-run"] === id,
        "Probe belongs to another run",
      );
      await appKube(["delete", kind, name, "--wait=true", "--timeout=20s"]);
    } catch {
      report.cleanupErrors.push(`Failed to remove owned ${kind} ${name}`);
    }
  }
  if (report.cleanupErrors.length) {
    report.passed = false;
    process.exitCode = 1;
  }
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
