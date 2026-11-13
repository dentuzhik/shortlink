import assert from "node:assert/strict";
import test from "node:test";
import {
  imageRevision,
  reportedRevision,
  rollbackTarget,
  servingPods,
  templateRelease,
} from "../lib/redirect-release.mjs";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const release = { image: `shortlink-redirect:${revision}`, revision, digest };
const template = {
  metadata: {
    annotations: {
      "shortlink.dev/git-revision": revision,
      "shortlink.dev/image-digest": digest,
    },
  },
  spec: { containers: [{ name: "api", image: release.image }] },
};
function pod(name = "new") {
  return {
    metadata: { name },
    spec: structuredClone(template.spec),
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "api",
          ready: true,
          imageID: `docker.io/library/import@${digest}`,
        },
      ],
    },
  };
}
function set(number, owner = "our-deployment") {
  return {
    metadata: {
      ownerReferences: [{ uid: owner }],
      annotations: { "deployment.kubernetes.io/revision": String(number) },
    },
    spec: { template: structuredClone(template) },
  };
}
const deployment = {
  metadata: {
    uid: "our-deployment",
    annotations: { "deployment.kubernetes.io/revision": "8" },
  },
};

test("release metadata rejects mutable tags and inconsistent source annotations", () => {
  assert.throws(
    () => imageRevision("shortlink-redirect:local"),
    /commit-tagged/,
  );
  assert.deepEqual(templateRelease(template), release);
  const bad = structuredClone(template);
  bad.metadata.annotations["shortlink.dev/git-revision"] = "c".repeat(40);
  assert.throws(() => templateRelease(bad), /does not match/);
});

test("rollback chooses the previous revision owned by this deployment, not another workload", () => {
  assert.equal(
    rollbackTarget(deployment, [set(7), set(6), set(99, "other")])
      .kubernetesRevision,
    7,
  );
  assert.equal(
    rollbackTarget(deployment, [set(7), set(6)], "6").kubernetesRevision,
    6,
  );
  assert.throws(() => rollbackTarget(deployment, [set(7)], "8"), /No retained/);
  assert.throws(() => rollbackTarget(deployment, [set(7)], "abc"), /positive/);
});

test("rollback refuses a legacy revision without artifact identity", () => {
  const legacy = set(7);
  delete legacy.spec.template.metadata.annotations[
    "shortlink.dev/image-digest"
  ];
  assert.throws(
    () => rollbackTarget(deployment, [legacy]),
    /Missing image digest/,
  );
});

test("verification ignores draining pods but requires all serving replicas to be ready", () => {
  const old = pod("draining");
  old.metadata.deletionTimestamp = new Date().toISOString();
  old.spec.containers[0].image = "shortlink-redirect:local";
  assert.equal(
    servingPods([pod("one"), pod("two"), old], release, 2).length,
    2,
  );
  assert.throws(() => servingPods([pod()], release, 2), /Expected 2/);
  const unready = pod();
  unready.status.containerStatuses[0].ready = false;
  assert.throws(() => servingPods([unready], release, 1), /not ready/);
});

test("verification detects changed image content even if the commit tag matches", () => {
  const changed = pod();
  changed.status.containerStatuses[0].imageID = `sha256:${"c".repeat(64)}`;
  assert.throws(
    () => servingPods([changed], release, 1),
    /expected image and digest/,
  );
});

test("the running revision must come from a build-info sample, not a comment or unrelated metric", () => {
  assert.equal(
    reportedRevision(
      `# HELP shortlink_build_info version\nshortlink_build_info{revision="${revision}"} 1\n`,
    ),
    revision,
  );
  assert.throws(
    () => reportedRevision(`# shortlink_build_info{revision="${revision}"} 1`),
    /does not report/,
  );
  assert.throws(
    () => reportedRevision('shortlink_build_info{revision="development"} 1'),
    /does not report/,
  );
});
