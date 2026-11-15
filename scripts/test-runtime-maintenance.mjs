import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  appGet,
  appKube,
  directory,
  ensure,
  sourceState,
} from "./lib/db-lab-connectivity.mjs";

// Real Kubernetes API/RBAC exercise in an isolated namespace. No application rollout.
const { RuntimeMaintenance } = await import(
  pathToFileURL(
    join(process.cwd(), "apps/redirect-service/dist/runtime-maintenance.js"),
  )
);
const { kubernetesMaintenanceSource, startMaintenanceWatch } = await import(
  pathToFileURL(
    join(process.cwd(), "apps/redirect-service/dist/maintenance-watch.js"),
  )
);
const path = await directory("runtime-maintenance-tests");
const report = { startedAt: new Date().toISOString(), passed: false };
const namespace = `maintenance-test-${randomUUID().slice(0, 8)}`;
const temp = await mkdtemp(join(tmpdir(), "shortlink-control-"));
const watchers = [];
const controls = [];
let created = false;
const kube = (args, input) =>
  appKube(["--namespace", namespace, ...args], input);
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!controls.every((control) => predicate(control.status()))) {
    ensure(Date.now() < deadline, "Controllers did not converge");
    await delay(10);
  }
}
async function update(revision, creationMode) {
  await kube([
    "patch",
    "configmap",
    "shortlink-runtime",
    "--type=merge",
    "-p",
    JSON.stringify({
      data: { "control.json": JSON.stringify({ revision, creationMode }) },
    }),
  ]);
}
try {
  report.sourceBefore = await sourceState();
  await appKube(["create", "namespace", namespace]);
  created = true;
  const permissions = (
    await readFile("deploy/k8s/runtime-maintenance.yaml", "utf8")
  ).replace("namespace: shortlink", `namespace: ${namespace}`);
  await kube(["apply", "-f", "-"], permissions);
  await kube(["create", "-f", "deploy/k8s/runtime-control.yaml"]);
  const endpoint = (
    await appKube([
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ])
  ).trim();
  const ca = (
    await appKube([
      "config",
      "view",
      "--raw",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.certificate-authority-data}",
    ])
  ).trim();
  const token = (
    await kube([
      "create",
      "token",
      "redirect-runtime-control",
      "--duration=10m",
    ])
  ).trim();
  await writeFile(`${temp}/ca.crt`, Buffer.from(ca, "base64"), { mode: 0o600 });
  await writeFile(`${temp}/token`, token, { mode: 0o600 });
  const options = { endpoint, credentialsDirectory: temp };
  const start = () => {
    const control = new RuntimeMaintenance();
    ensure(
      !control.status().acceptingCreations,
      "Controller did not start closed",
    );
    controls.push(control);
    watchers.push(
      startMaintenanceWatch(
        control,
        kubernetesMaintenanceSource(namespace, "shortlink-runtime", options),
        () => {},
        10,
      ),
    );
  };
  start();
  start();
  await waitFor((s) => s.observedRevision === 1 && s.acceptingCreations);
  await update(2, "reject");
  await waitFor((s) => s.observedRevision === 2 && s.drained);
  start(); // New replica state must load the active maintenance window.
  await waitFor((s) => s.observedRevision === 2 && s.drained);
  report.maintenance = controls.map((control) => control.status());
  await update(3, "accept");
  await waitFor((s) => s.observedRevision === 3 && s.acceptingCreations);
  report.reopened = controls.map((control) => control.status());
  let forbidden = false;
  try {
    await kubernetesMaintenanceSource(
      namespace,
      "unrelated-config",
      options,
    ).read(new AbortController().signal);
  } catch (error) {
    forbidden = error.message.includes("403");
  }
  ensure(forbidden, "Application role could read an unrelated ConfigMap");
  report.unrelatedConfigDenied = forbidden;
  for (const verb of ["patch", "create", "delete"]) {
    const review = JSON.parse(
      await appKube(
        [
          "create",
          "--raw",
          "/apis/authorization.k8s.io/v1/subjectaccessreviews",
          "-f",
          "-",
        ],
        JSON.stringify({
          apiVersion: "authorization.k8s.io/v1",
          kind: "SubjectAccessReview",
          spec: {
            user: `system:serviceaccount:${namespace}:redirect-runtime-control`,
            resourceAttributes: {
              namespace,
              group: "",
              resource: "configmaps",
              name: "shortlink-runtime",
              verb,
            },
          },
        }),
      ),
    );
    ensure(
      review.status.allowed === false,
      "Application role can mutate control configuration",
    );
  }
  report.sourceAfter = await sourceState();
  ensure(
    report.sourceBefore.deploymentSpecHash ===
      report.sourceAfter.deploymentSpecHash,
    "Live Fastify configuration changed",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await Promise.all(watchers.map((watcher) => watcher.stop()));
  await rm(temp, { recursive: true, force: true });
  if (created) {
    await appKube(
      ["delete", "namespace", namespace, "--wait=true", "--timeout=30s"],
      undefined,
      40000,
    );
    ensure(
      (await appGet(["get", "namespaces"])).items.every(
        (n) => n.metadata.name !== namespace,
      ),
      "Fixture namespace remains",
    );
  }
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence: `${path}/result.json`,
      ...(report.error ? { error: report.error } : {}),
    }),
  );
}
