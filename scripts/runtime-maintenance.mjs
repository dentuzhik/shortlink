import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseMaintenanceConfig } from "../apps/redirect-service/src/runtime-maintenance.ts";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const execute = promisify(execFile);
const target = [
  "--kubeconfig",
  ".kind/kubeconfig",
  "--context",
  "kind-shortlink",
  "-n",
  "shortlink",
];
const [action, targetDatabase, ...extra] = process.argv.slice(2);
if (
  !["status", "begin", "end", "prepare", "switch"].includes(action) ||
  extra.length ||
  (["prepare", "switch"].includes(action)
    ? !["source", "ha"].includes(targetDatabase)
    : targetDatabase !== undefined)
) {
  throw new Error(
    "Use runtime-maintenance.mjs status|begin|end | prepare|switch source|ha",
  );
}
const kube = async (...args) =>
  JSON.parse(
    (
      await execute("kubectl", [...target, ...args], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  );
const readControl = () =>
  kube("get", "configmap", "shortlink-runtime", "-o", "json");
async function pods() {
  const list = await kube(
    "get",
    "pods",
    "-l",
    "app=redirect-service",
    "-o",
    "json",
  );
  // Terminating pods can still serve during preStop and routing propagation.
  return list.items;
}
async function statuses() {
  const current = await pods();
  return Promise.all(
    current.map(async (pod) => {
      const identity = {
        pod: pod.metadata.name,
        uid: pod.metadata.uid,
        terminating: Boolean(pod.metadata.deletionTimestamp),
      };
      try {
        const status = await kube(
          "get",
          "--raw",
          `/api/v1/namespaces/shortlink/pods/http:${pod.metadata.name}:9090/proxy/internal/maintenance`,
        );
        return { ...identity, ...status };
      } catch {
        return { ...identity, unavailable: true };
      }
    }),
  );
}
async function waitFor(config, requireApplied = true) {
  const deadline = Date.now() + 30000;
  let observed;
  while (Date.now() < deadline) {
    const current = parseMaintenanceConfig(
      JSON.parse((await readControl()).data["control.json"]),
    );
    if (
      current.revision !== config.revision ||
      current.creationMode !== config.creationMode ||
      (current.activeDatabase ?? "source") !==
        (config.activeDatabase ?? "source") ||
      (current.prepareDatabase ?? null) !== (config.prepareDatabase ?? null)
    )
      throw new Error(
        "Control changed concurrently; inspect status before continuing",
      );
    const deployment = await kube(
      "get",
      "deployment",
      "redirect-service",
      "-o",
      "json",
    );
    observed = await statuses();
    if (
      observed.filter((pod) => !pod.terminating).length >=
        deployment.spec.replicas &&
      observed.length > 0 &&
      observed.every(
        (pod) =>
          pod.configurationCurrent &&
          (!requireApplied || pod.configurationApplied) &&
          pod.observedRevision === config.revision &&
          pod.activeDatabase === (config.activeDatabase ?? "source") &&
          pod.creationMode === config.creationMode &&
          (config.creationMode === "reject"
            ? pod.drained && !pod.acceptingCreations
            : pod.acceptingCreations),
      )
    ) {
      const after = await pods();
      if (
        JSON.stringify(after.map((p) => p.metadata.uid).sort()) ===
        JSON.stringify(observed.map((p) => p.uid).sort())
      )
        return observed;
    }
    await delay(200);
  }
  console.error(JSON.stringify({ pods: observed }));
  throw new Error(
    "Timed out waiting for every replica; configuration is left in place, with no automatic reopen",
  );
}
try {
  const object = await readControl();
  const current = parseMaintenanceConfig(
    JSON.parse(object.data["control.json"]),
  );
  if (action === "status") {
    console.log(
      JSON.stringify({ desired: current, pods: await statuses() }, null, 2),
    );
  } else {
    if (action === "switch" && current.creationMode !== "reject")
      throw new Error("Begin maintenance before switching pools");
    const creationMode =
      action === "begin"
        ? "reject"
        : action === "end"
          ? "accept"
          : current.creationMode;
    // A repeated begin/end still verifies the current desired state.
    const change =
      action === "prepare"
        ? { prepareDatabase: targetDatabase }
        : action === "switch"
          ? { activeDatabase: targetDatabase, prepareDatabase: null }
          : { creationMode };
    const changed = Object.entries(change).some(
      ([key, value]) => current[key] !== value,
    );
    const next = changed
      ? { ...current, ...change, revision: current.revision + 1 }
      : current;
    parseMaintenanceConfig(next);
    const acknowledged = await waitFor(current, action !== "prepare");
    if (
      action === "switch" &&
      targetDatabase !== (current.activeDatabase ?? "source") &&
      !acknowledged.every(
        (pod) =>
          pod.database?.preparedDatabase === targetDatabase &&
          pod.database.candidateReady,
      )
    ) {
      throw new Error(
        "Prepare the selected pool on every replica before switching",
      );
    }
    if (next !== current) {
      await kube(
        "patch",
        "configmap",
        "shortlink-runtime",
        "--type=json",
        "-p",
        JSON.stringify([
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: object.metadata.resourceVersion,
          },
          {
            op: "replace",
            path: "/data/control.json",
            value: JSON.stringify(next),
          },
        ]),
        "-o",
        "json",
      );
    }
    console.log(
      JSON.stringify({ desired: next, pods: await waitFor(next) }, null, 2),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error && !Object.hasOwn(error, "stderr")
      ? error.message
      : "Kubernetes operation failed; check the selected cluster and runtime status",
  );
  process.exitCode = 1;
}
