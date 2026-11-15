import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fastifyRolloutPlan } from "../lib/fastify-rollout.mjs";
import {
  assertSourceStatus,
  haTargetData,
  haTemplate,
  hostname,
  withoutHaTarget,
} from "../lib/ha-target.mjs";

const wiring = JSON.parse(
  await readFile(
    new URL("../../deploy/migration/fastify-ha-target.json", import.meta.url),
    "utf8",
  ),
);
const base = {
  metadata: {
    labels: { app: "redirect-service" },
    annotations: { "shortlink.dev/git-revision": "a".repeat(40) },
  },
  spec: {
    serviceAccountName: "redirect-runtime-control",
    terminationGracePeriodSeconds: 30,
    volumes: [{ name: "other", emptyDir: {} }],
    containers: [
      {
        name: "api",
        image: "example@sha256:pinned",
        envFrom: [{ secretRef: { name: "postgres-credentials" } }],
        env: [{ name: "POSTGRES_HOST", value: "postgres" }],
        volumeMounts: [{ name: "other", mountPath: "/other" }],
        lifecycle: { preStop: { sleep: { seconds: 5 } } },
      },
    ],
  },
};
test("HA staging encodes reserved password characters and copies only URL/public CA", () => {
  const password = "p@ss:/?#% with space";
  const credentials = {
    username: Buffer.from("shortlink_lab").toString("base64"),
    password: Buffer.from(password).toString("base64"),
    dbname: "ignored-probe-db",
    "tls.key": "private-key",
  };
  const data = haTargetData(credentials, "public-ca");
  assert.deepEqual(Object.keys(data).sort(), ["ca.crt", "url"]);
  const url = new URL(Buffer.from(data.url, "base64").toString());
  assert.equal(url.hostname, hostname);
  assert.equal(url.pathname, "/shortener");
  assert.equal(url.username, "shortlink_lab");
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.search, "");
  assert.equal(data["ca.crt"], "public-ca");
  assert.throws(() =>
    haTargetData({ ...credentials, password: "" }, "public-ca"),
  );
  assert.throws(() =>
    haTargetData(
      { ...credentials, username: Buffer.from("postgres").toString("base64") },
      "public-ca",
    ),
  );
});
test("the HA rollout preserves image, source credentials, other mounts and drain settings", () => {
  const template = haTemplate(base, wiring);
  assert.deepEqual(withoutHaTarget(template), withoutHaTarget(base));
  assert.deepEqual(haTemplate(template, wiring), template);
  // Kubernetes serializes map keys in a different order; that is not a change.
  const wire = structuredClone(wiring);
  wire.volumeMount = {
    readOnly: true,
    mountPath: "/etc/shortlink/ha-database",
    name: "ha-database-trust",
  };
  wire.env[0].valueFrom.secretKeyRef = {
    key: "url",
    name: "fastify-ha-target",
  };
  assert.deepEqual(haTemplate(template, wire), template);
  assert.equal(
    template.spec.containers[0].image,
    base.spec.containers[0].image,
  );
  assert.equal(template.spec.volumes[1].secret.items.length, 1);
  assert.equal(template.spec.volumes[1].secret.items[0].key, "ca.crt");
  assert.deepEqual(template.spec.containers[0].env.slice(-3), wiring.env);
  const noVolumes = structuredClone(base);
  delete noVolumes.spec.volumes;
  delete noVolumes.spec.containers[0].volumeMounts;
  assert.deepEqual(
    withoutHaTarget(haTemplate(noVolumes, wiring)),
    withoutHaTarget(noVolumes),
  );
  const invalid = structuredClone(wiring);
  invalid.volume.secret.items.push({ key: "ca.key", path: "ca.key" });
  assert.throws(() => haTemplate(base, invalid));
});
function status() {
  return {
    desired: { revision: 2, creationMode: "accept", prepareDatabase: "ha" },
    pods: ["first", "second"].map((pod) => ({
      pod,
      terminating: false,
      observedRevision: 2,
      desiredDatabase: "source",
      configurationCurrent: true,
      configurationApplied: true,
      acceptingCreations: true,
      activeDatabase: "source",
      database: {
        appliedRevision: 2,
        activeDatabase: "source",
        preparedDatabase: "ha",
        candidateReady: true,
        error: null,
      },
    })),
  };
}
test("HA validation requires every source replica to acknowledge the same ready candidate revision", () => {
  assert.doesNotThrow(() => assertSourceStatus(status(), true));
  for (const mutate of [
    (s) => {
      s.desired.activeDatabase = "ha";
    },
    (s) => {
      s.desired.creationMode = "reject";
    },
    (s) => {
      s.pods[1].database.candidateReady = false;
    },
    (s) => {
      s.pods[1].database.appliedRevision = 1;
    },
    (s) => {
      s.pods[1].database.error = "failed";
    },
    (s) => {
      s.pods[1].terminating = true;
    },
    (s) => {
      s.pods.pop();
    },
    (s) => {
      s.pods[1].activeDatabase = "ha";
    },
  ]) {
    const value = status();
    mutate(value);
    assert.throws(() => assertSourceStatus(value, true));
  }
});
test("config rollout is an explicit operation without an image revision", () => {
  assert.deepEqual(fastifyRolloutPlan(["--prepare-ha-target"]), {
    action: "ha-target",
  });
  assert.throws(() =>
    fastifyRolloutPlan(["--prepare-ha-target", "a".repeat(40)]),
  );
});
