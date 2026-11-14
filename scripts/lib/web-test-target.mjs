import { resolve } from "node:path";

export function webTestTarget(env = process.env, commit) {
  const customFile = env.WEB_TEST_KUBECONFIG;
  const customContext = env.WEB_TEST_CONTEXT;
  if (Boolean(customFile) !== Boolean(customContext))
    throw new Error("Supply both WEB_TEST_KUBECONFIG and WEB_TEST_CONTEXT");
  const context = customContext ?? "kind-shortlink";
  if (
    context !== "kind-shortlink" &&
    !/^kind-shortlink-ci-[0-9]+-[0-9]+$/.test(context)
  )
    throw new Error(
      "Web rollout tests only target the local or disposable CI kind cluster",
    );
  if (env.CI && context === "kind-shortlink")
    throw new Error("CI must select its disposable kind cluster explicitly");
  if (commit && context !== "kind-shortlink")
    throw new Error(
      "Published-version changes use the local release helper; CI restarts its verified candidate",
    );
  return {
    kubeArgs: [
      "--kubeconfig",
      customFile ?? ".kind/kubeconfig",
      "--context",
      context,
      "--namespace",
      "shortlink",
    ],
    context,
    directory: resolve(
      env.WEB_TEST_ARTIFACT_DIR ??
        `.kind/web-rollout/${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    ),
    isCI: context !== "kind-shortlink",
  };
}
