import assert from "node:assert/strict";
import {
  assertSourceConfiguration,
  assertSourcePods,
} from "./fastify-rollout.mjs";

export const secretName = "fastify-ha-target";
export const hostname = "db-lab-primary.shortlink.svc.cluster.local";
const envNames = [
  "HA_DATABASE_URL",
  "HA_DATABASE_CA_FILE",
  "HA_DATABASE_SERVERNAME",
];

export function haTargetData(credentials, ca) {
  const username = Buffer.from(credentials.username ?? "", "base64").toString(
    "utf8",
  );
  const password = Buffer.from(credentials.password ?? "", "base64").toString(
    "utf8",
  );
  if (username !== "shortlink_lab" || !password || !ca)
    throw new Error(
      "Expected the HA application role, a password and public CA",
    );
  const url = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostname}:5432/shortener`;
  return { url: Buffer.from(url).toString("base64"), "ca.crt": ca };
}

export function haTemplate(template, wiring) {
  assert.deepEqual(
    wiring.env.map((item) => item.name),
    envNames,
  );
  assert.equal(wiring.env[0].valueFrom.secretKeyRef.name, secretName);
  assert.equal(wiring.env[0].valueFrom.secretKeyRef.key, "url");
  assert.equal(wiring.env[1].value, "/etc/shortlink/ha-database/ca.crt");
  assert.equal(wiring.env[2].value, hostname);
  assert.deepEqual(wiring.volume, {
    name: "ha-database-trust",
    secret: {
      secretName,
      defaultMode: 292,
      items: [{ key: "ca.crt", path: "ca.crt" }],
    },
  });
  assert.deepEqual(wiring.volumeMount, {
    name: "ha-database-trust",
    mountPath: "/etc/shortlink/ha-database",
    readOnly: true,
  });
  const next = structuredClone(template);
  const api = next.spec.containers.filter((c) => c.name === "api");
  assert.equal(api.length, 1, "Expected exactly one Fastify container");
  const upsert = (items, additions) => [
    ...(items ?? []).filter(
      (item) => !additions.some((add) => item.name === add.name),
    ),
    ...structuredClone(additions),
  ];
  api[0].env = upsert(api[0].env, wiring.env);
  api[0].volumeMounts = upsert(api[0].volumeMounts, [wiring.volumeMount]);
  next.spec.volumes = upsert(next.spec.volumes, [wiring.volume]);
  return next;
}

export function withoutHaTarget(template) {
  const result = structuredClone(template);
  for (const api of result.spec.containers.filter((c) => c.name === "api")) {
    api.env = (api.env ?? []).filter((item) => !envNames.includes(item.name));
    api.volumeMounts = (api.volumeMounts ?? []).filter(
      (item) => item.name !== "ha-database-trust",
    );
    if (!api.volumeMounts.length) delete api.volumeMounts;
  }
  result.spec.volumes = (result.spec.volumes ?? []).filter(
    (item) => item.name !== "ha-database-trust",
  );
  if (!result.spec.volumes.length) delete result.spec.volumes;
  return result;
}

export function assertSourceStatus(status, prepared = false) {
  assertSourceConfiguration({ ...status.desired, prepareDatabase: null });
  assertSourcePods(status.pods);
  assert.ok(status.pods.every((p) => !p.terminating));
  assert.equal(status.desired.prepareDatabase ?? null, prepared ? "ha" : null);
  for (const pod of status.pods) {
    assert.equal(pod.observedRevision, status.desired.revision);
    assert.equal(pod.database.appliedRevision, status.desired.revision);
    assert.equal(pod.desiredDatabase, "source");
    assert.equal(pod.database.preparedDatabase, prepared ? "ha" : null);
    assert.equal(pod.database.candidateReady, prepared);
    assert.equal(pod.database.error, null);
  }
}
