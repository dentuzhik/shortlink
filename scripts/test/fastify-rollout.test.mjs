import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSourceConfiguration,
  assertSourcePods,
  assertStagedDigest,
  fastifyRolloutPlan,
  runtimePodSpec,
} from "../lib/fastify-rollout.mjs";

test("a versioned load test requires an explicit immutable revision and never falls back to restart", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(fastifyRolloutPlan([]), { action: "restart" });
  assert.deepEqual(fastifyRolloutPlan(["--deploy", sha]), {
    action: "deploy",
    revision: sha,
  });
  assert.deepEqual(fastifyRolloutPlan(["--deploy-local", sha]), {
    action: "deploy-local",
    revision: sha,
  });
  assert.deepEqual(fastifyRolloutPlan(["--application-roles", sha]), {
    action: "application-roles",
    revision: sha,
  });
  for (const args of [
    ["--deploy"],
    ["--deploy", "main"],
    ["--oops", sha],
    ["--deploy", sha, "extra"],
  ]) {
    assert.throws(() => fastifyRolloutPlan(args));
  }
});

test("one pod-template patch changes the image and enables runtime control without changing the source endpoint", () => {
  const container = {
    name: "api",
    image: "ghcr.io/example/api:sha@sha256:digest",
    imagePullPolicy: "IfNotPresent",
    env: [{ name: "POSTGRES_HOST", value: "postgres" }],
  };
  const patch = runtimePodSpec(container);
  assert.equal(patch.serviceAccountName, "redirect-runtime-control");
  assert.equal(patch.containers[0].image, container.image);
  assert.deepEqual(
    patch.containers[0].env.find((item) => item.name === "POSTGRES_HOST"),
    container.env[0],
  );
  assert.equal(
    patch.containers[0].env.find(
      (item) => item.name === "MAINTENANCE_CONFIGMAP",
    ).value,
    "shortlink-runtime",
  );
  assert.equal(
    patch.containers[0].env.find((item) => item.name === "POD_NAMESPACE")
      .valueFrom.fieldRef.fieldPath,
    "metadata.namespace",
  );
});

test("preparatory deployment refuses a maintenance window, HA selection or prepared target", () => {
  assert.doesNotThrow(() =>
    assertSourceConfiguration({ revision: 1, creationMode: "accept" }),
  );
  for (const config of [
    { revision: 2, creationMode: "reject" },
    { revision: 2, creationMode: "accept", activeDatabase: "ha" },
    { revision: 2, creationMode: "accept", prepareDatabase: "ha" },
    { creationMode: "accept" },
  ])
    assert.throws(() => assertSourceConfiguration(config));
});

test("replacement replicas must acknowledge the active source pool, not merely be ready", () => {
  const good = {
    configurationCurrent: true,
    configurationApplied: true,
    acceptingCreations: true,
    activeDatabase: "source",
    database: { activeDatabase: "source" },
  };
  assert.doesNotThrow(() => assertSourcePods([good, good]));
  assert.throws(() => assertSourcePods([good]));
  assert.throws(() =>
    assertSourcePods([good, { ...good, configurationApplied: false }]),
  );
  assert.throws(() =>
    assertSourcePods([good, { ...good, database: { activeDatabase: "ha" } }]),
  );
});

test("staging checks the node's manifest digest, rather than a Docker cache or config ID", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.doesNotThrow(() =>
    assertStagedDigest(
      { status: { repoDigests: [`ghcr.io/example/api@${digest}`] } },
      digest,
    ),
  );
  assert.throws(() =>
    assertStagedDigest({ status: { id: digest, repoDigests: [] } }, digest),
  );
  assert.throws(() =>
    assertStagedDigest(
      {
        status: {
          repoDigests: [`ghcr.io/example/api@sha256:${"b".repeat(64)}`],
        },
      },
      digest,
    ),
  );
});
