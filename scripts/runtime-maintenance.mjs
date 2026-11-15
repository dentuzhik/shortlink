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
const [action, ...extra] = process.argv.slice(2);
if (!["status", "begin", "end"].includes(action) || extra.length) {
  throw new Error("Use runtime-maintenance.mjs status|begin|end");
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
async function waitFor(config) {
  const deadline = Date.now() + 30000;
  let observed;
  while (Date.now() < deadline) {
    const current = parseMaintenanceConfig(
      JSON.parse((await readControl()).data["control.json"]),
    );
    if (
      current.revision !== config.revision ||
      current.creationMode !== config.creationMode
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
          pod.observedRevision === config.revision &&
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
    const creationMode = action === "begin" ? "reject" : "accept";
    // A repeated begin/end still verifies the current desired state.
    const next =
      current.creationMode === creationMode
        ? current
        : { revision: current.revision + 1, creationMode };
    parseMaintenanceConfig(next);
    await waitFor(current); // Refuse unsupported or unacknowledged replicas before changing modes.
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
