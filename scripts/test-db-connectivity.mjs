import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  appGet,
  appKube,
  dbGet,
  dbKube,
  directory,
  docker,
  ensure,
  network,
  run,
  sourceState,
  vmAddresses,
} from "./lib/db-lab-connectivity.mjs";

const runId = randomUUID();
const name = `db-connect-${runId.slice(0, 8)}`;
const labels = { "shortlink.dev/connectivity-run": runId };
const path = await directory("connectivity-checks");
const report = { startedAt: new Date().toISOString(), passed: false, runId };
let resourcesCreated = false;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
  });
try {
  report.sourceBefore = await sourceState();
  report.addresses = await vmAddresses();
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host memory pressure is not normal",
  );
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three ready database instances",
  );
  report.primary = cluster.status.currentPrimary;
  const primary = await dbGet(["get", "pod", report.primary]);
  const clientService = await appGet(["get", "service", network.serviceName]);
  const slice = await appGet(["get", "endpointslice", "db-lab-primary-vm"]);
  ensure(
    slice.endpoints.length === 1 &&
      slice.endpoints[0].addresses[0] === report.addresses.database &&
      slice.ports[0].port === network.listenPort,
    "Application EndpointSlice has stale VM address/port; rerun db:lab:connect",
  );
  const [bridge] = JSON.parse(await docker(["inspect", network.bridgeName]));
  ensure(
    bridge.State.Running &&
      bridge.HostConfig.PortBindings["5432/tcp"][0].HostIp ===
        report.addresses.database,
    "Database bridge is not running on its private VM address",
  );

  // Only the lab's app credentials and public CA are copied, temporarily.
  const credentials = (await dbGet(["get", "secret", "shortlink-lab-app"]))
    .data;
  const ca = await dbKube([
    "get",
    "secret",
    "shortlink-lab-ca",
    "-o",
    "jsonpath={.data.ca\\.crt}",
  ]);
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace: "shortlink", labels },
    type: "Opaque",
    data: {
      username: credentials.username,
      password: credentials.password,
      dbname: credentials.dbname,
      "ca.crt": ca,
    },
  };
  const config = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: "shortlink", labels },
    data: {
      "probe.cjs": await readFile("scripts/db-connectivity-probe.cjs", "utf8"),
    },
  };
  const versions = JSON.parse(
    await readFile("deploy/db-lab/versions.json", "utf8"),
  );
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "shortlink", labels },
    spec: {
      // The wrong-name case reaches the same Service but must fail TLS identity validation.
      hostAliases: [
        {
          ip: clientService.spec.clusterIP,
          hostnames: ["incorrect.database.invalid"],
        },
      ],
      restartPolicy: "Never",
      activeDeadlineSeconds: 90,
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: versions.switchoverProbeImage,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "--max-old-space-size=64", "/exercise/probe.cjs"],
          env: [
            { name: "PGHOST", value: network.serviceHostname },
            { name: "PROBE_RUN", value: runId },
            ...[
              ["PGUSER", "username"],
              ["PGPASSWORD", "password"],
              ["PGDATABASE", "dbname"],
            ].map(([variable, key]) => ({
              name: variable,
              valueFrom: { secretKeyRef: { name, key } },
            })),
          ],
          resources: {
            requests: { cpu: "25m", memory: "64Mi" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            { name: "code", mountPath: "/exercise", readOnly: true },
            { name: "ca", mountPath: "/exercise-ca", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "code", configMap: { name } },
        {
          name: "ca",
          secret: {
            secretName: name,
            items: [{ key: "ca.crt", path: "ca.crt" }],
          },
        },
      ],
    },
  };
  ensure(!interrupted, "Connectivity test interrupted");
  resourcesCreated = true;
  await appKube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [secret, config, pod],
    }),
  );
  let status;
  for (let i = 0; i < 50; i++) {
    ensure(!interrupted, "Connectivity test interrupted");
    status = await appGet(["get", "pod", name]);
    if (["Succeeded", "Failed"].includes(status.status.phase)) break;
    await delay(2000);
  }
  const output = await appKube(["logs", name]);
  await writeFile(`${path}/probe.json`, output);
  report.probe = JSON.parse(output.trim());
  ensure(
    status.status.phase === "Succeeded" && report.probe.passed,
    `Application-cluster probe failed: ${report.probe.error ?? status.status.phase}`,
  );
  ensure(
    report.probe.session.server === primary.status.podIP,
    "Cross-VM connection did not reach the recorded current primary",
  );
  // Each standby must eventually replay the exact acknowledged fixture token.
  const pods = (
    await dbGet([
      "get",
      "pods",
      "-l",
      "cnpg.io/cluster=shortlink-lab,cnpg.io/podRole=instance",
    ])
  ).items;
  ensure(pods.length === 3, "Expected three database instances");
  const token = report.probe.token;
  ensure(token === `connectivity-${runId}`, "Unexpected fixture token");
  for (let i = 0; i < 20; i++) {
    report.replay = await Promise.all(
      pods.map(async (p) => ({
        pod: p.metadata.name,
        present:
          (
            await dbKube([
              "exec",
              p.metadata.name,
              "--",
              "psql",
              "-X",
              "-qAt",
              "-v",
              "ON_ERROR_STOP=1",
              "-U",
              "postgres",
              "-d",
              "shortlink_lab",
              "-c",
              `SET statement_timeout='2s'; SELECT EXISTS(SELECT 1 FROM replication_probe WHERE token='${token}');`,
            ])
          ).trim() === "t",
      })),
    );
    if (report.replay.every((p) => p.present)) break;
    await delay(250);
  }
  ensure(
    report.replay.every((p) => p.present),
    "Acknowledged fixture did not replay to every lab instance",
  );
  report.bridgeLogs = (
    await docker(["logs", "--since", report.startedAt, network.bridgeName])
  ).trim();
  ensure(
    report.bridgeLogs.includes(`${report.addresses.application}:`),
    "Bridge log did not confirm the allowed application VM as client",
  );
  report.sourceAfter = await sourceState();
  ensure(
    report.sourceBefore.deploymentSpecHash ===
      report.sourceAfter.deploymentSpecHash,
    "Source Fastify configuration changed",
  );
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (resourcesCreated) {
    try {
      await appKube(
        [
          "delete",
          "pod,configmap,secret",
          "-l",
          `shortlink.dev/connectivity-run=${runId}`,
          "--ignore-not-found=true",
          "--wait=true",
          "--timeout=30s",
        ],
        undefined,
        40000,
      );
      const left = await appGet([
        "get",
        "pod,configmap,secret",
        "-l",
        `shortlink.dev/connectivity-run=${runId}`,
      ]);
      report.cleanupPassed = left.items.length === 0;
      ensure(report.cleanupPassed, "Temporary resources remain");
    } catch (error) {
      report.cleanupPassed = false;
      report.passed = false;
      report.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      cleanupPassed: report.cleanupPassed,
      evidence: `${path}/result.json`,
    }),
  );
}
