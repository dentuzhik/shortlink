export function fastifyRolloutPlan(args) {
  if (args.length === 0) return { action: "restart" };
  if (
    args.length !== 2 ||
    !["--deploy", "--deploy-local"].includes(args[0]) ||
    !/^[a-f0-9]{40}$/.test(args[1])
  ) {
    throw new Error(
      "Use test-rolling-restart.mjs [--deploy|--deploy-local FULL_GIT_SHA]",
    );
  }
  return {
    action: args[0] === "--deploy" ? "deploy" : "deploy-local",
    revision: args[1],
  };
}

export function runtimePodSpec(container) {
  return {
    serviceAccountName: "redirect-runtime-control",
    containers: [
      {
        ...container,
        env: [
          ...(container.env ?? []).filter(
            (item) =>
              !["MAINTENANCE_CONFIGMAP", "POD_NAMESPACE"].includes(item.name),
          ),
          {
            name: "MAINTENANCE_CONFIGMAP",
            value: "shortlink-runtime",
            valueFrom: null,
          },
          {
            name: "POD_NAMESPACE",
            value: null,
            valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
          },
        ],
      },
    ],
  };
}

export function assertSourceConfiguration(config) {
  if (
    !Number.isSafeInteger(config.revision) ||
    config.revision < 1 ||
    config.creationMode !== "accept" ||
    (config.activeDatabase ?? "source") !== "source" ||
    config.prepareDatabase
  ) {
    throw new Error(
      "The preparatory rollout requires creation enabled, source selected and no prepared target",
    );
  }
}

export function assertSourcePods(pods) {
  if (
    pods.length !== 2 ||
    pods.some(
      (pod) =>
        !pod.configurationCurrent ||
        !pod.configurationApplied ||
        !pod.acceptingCreations ||
        pod.activeDatabase !== "source" ||
        pod.database?.activeDatabase !== "source",
    )
  ) {
    throw new Error(
      "Replacement replicas did not acknowledge the source database runtime configuration",
    );
  }
}
