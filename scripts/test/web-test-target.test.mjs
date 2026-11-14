import assert from "node:assert/strict";
import test from "node:test";
import { webTestTarget } from "../lib/web-test-target.mjs";

test("local rollout commands retain their explicit local cluster", () => {
  assert.equal(webTestTarget({}).context, "kind-shortlink");
  assert.equal(webTestTarget({}, "abc123").isCI, false);
});

test("CI cannot accidentally restart the local cluster or use a foreign context", () => {
  assert.throws(() => webTestTarget({ CI: "true" }), /disposable/);
  assert.throws(
    () => webTestTarget({ WEB_TEST_KUBECONFIG: "ci-file" }),
    /both/,
  );
  assert.throws(
    () => webTestTarget({ WEB_TEST_CONTEXT: "kind-shortlink-ci-1-1" }),
    /both/,
  );
  assert.throws(
    () =>
      webTestTarget({
        WEB_TEST_CONTEXT: "production",
        WEB_TEST_KUBECONFIG: "ci-file",
      }),
    /only target/,
  );
});

test("CI selects its own kubeconfig and cannot invoke the local version deployer", () => {
  const env = {
    CI: "true",
    WEB_TEST_CONTEXT: "kind-shortlink-ci-123-1",
    WEB_TEST_KUBECONFIG: "ci-file",
    WEB_TEST_ARTIFACT_DIR: ".kind/ci-web-rollout/test",
  };
  const target = webTestTarget(env);
  assert.equal(target.isCI, true);
  assert.deepEqual(target.kubeArgs, [
    "--kubeconfig",
    "ci-file",
    "--context",
    "kind-shortlink-ci-123-1",
    "--namespace",
    "shortlink",
  ]);
  assert.throws(() => webTestTarget(env, "abc123"), /local release helper/);
});
