import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appKube,
  dbGet,
  dbKube,
  directory,
  docker,
  ensure,
  hash,
  network,
  run,
  sourceState,
  vmAddresses,
} from "./lib/db-lab-connectivity.mjs";

const path = await directory("connectivity-setup");
const report = { startedAt: new Date().toISOString(), passed: false };
try {
  ensure(
    (
      await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])
    ).trim() === "1",
    "Host memory pressure is not normal",
  );
  report.sourceBefore = await sourceState();
  report.stage = "resolve-private-addresses";
  report.addresses = await vmAddresses();
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three ready database instances",
  );
  const nodes = JSON.parse(
    await run("kubectl", [
      ...[
        "--kubeconfig",
        ".kind/db-cluster/kubeconfig",
        "--context",
        "kind-shortlink-db",
      ],
      "get",
      "nodes",
      "-l",
      "shortlink.dev/workload=database",
      "-o",
      "json",
    ]),
  ).items;
  ensure(nodes.length === 3, "Expected three database workers");
  report.workers = nodes.map((n) => n.metadata.name).sort();
  ensure(
    report.workers.every((n) => /^shortlink-db-worker[0-9]*$/.test(n)),
    "Unexpected worker container name",
  );

  report.stage = "database-service-and-tls";
  // The same declarative manifest is also applied by db:lab:up.
  await dbKube([
    "apply",
    "--server-side",
    "--dry-run=server",
    "--field-manager=shortlink-db-lab",
    "-f",
    "deploy/db-lab/cluster.yaml",
  ]);
  await dbKube([
    "apply",
    "--server-side",
    "--field-manager=shortlink-db-lab",
    "-f",
    "deploy/db-lab/cluster.yaml",
  ]);
  await dbKube(
    ["wait", "--for=create", "service/shortlink-lab-external", "--timeout=60s"],
    undefined,
    70000,
  );
  const service = await dbGet(["get", "service", "shortlink-lab-external"]);
  ensure(
    service.spec.type === "NodePort" &&
      service.spec.ports[0].nodePort === network.nodePort &&
      service.spec.selector["cnpg.io/instanceRole"] === "primary",
    "Unexpected database Service configuration",
  );

  report.stage = "tcp-bridge";
  const config = `global
  log stdout format raw local0
  maxconn 256

defaults
  log global
  mode tcp
  option tcplog
  timeout connect 2s
  timeout client 60s
  timeout server 60s

resolvers docker
  nameserver embedded 127.0.0.11:53
  hold valid 10s

frontend postgres
  bind :5432
  acl application_vm src ${report.addresses.application}/32
  tcp-request connection reject unless application_vm
  default_backend database_nodes

backend database_nodes
${report.workers.map((name, i) => `  server worker${i + 1} ${name}:${network.nodePort} check inter 2s fall 2 rise 1 resolvers docker resolve-prefer ipv4 init-addr libc,none`).join("\n")}
`;
  const configPath = resolve(path, "haproxy.cfg");
  await writeFile(configPath, config, { mode: 0o644 });
  await chmod(configPath, 0o644);
  const configHash = hash({
    config,
    image: network.bridgeImage,
    address: report.addresses.database,
    port: network.listenPort,
  });
  const existing = JSON.parse(
    (await docker([
      "container",
      "ls",
      "-a",
      "--filter",
      `name=^/${network.bridgeName}$`,
      "--format",
      "json",
    ])) || "null",
  );
  let reuse = false;
  if (existing) {
    const [container] = JSON.parse(
      await docker(["inspect", network.bridgeName]),
    );
    ensure(
      container.Config.Labels["shortlink.dev/exercise"] ===
        "database-connectivity",
      "Refusing to replace an unrelated container",
    );
    reuse = container.Config.Labels["shortlink.dev/config-hash"] === configHash;
    if (!reuse) await docker(["rm", "-f", network.bridgeName]);
  }
  if (!reuse) {
    await docker(["pull", network.bridgeImage]);
    await docker([
      "create",
      "--name",
      network.bridgeName,
      "--label",
      "shortlink.dev/exercise=database-connectivity",
      "--label",
      `shortlink.dev/config-hash=${configHash}`,
      "--network",
      "kind",
      "--publish",
      `${report.addresses.database}:${network.listenPort}:5432`,
      "--restart",
      "unless-stopped",
      "--memory",
      "64m",
      "--cpus",
      "0.25",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      network.bridgeImage,
    ]);
    // Docker cp streams through its API; the database VM has no Mac directory mounts.
    await docker([
      "cp",
      configPath,
      `${network.bridgeName}:/usr/local/etc/haproxy/haproxy.cfg`,
    ]);
  }
  await docker(["start", network.bridgeName]);
  await docker([
    "exec",
    network.bridgeName,
    "haproxy",
    "-c",
    "-f",
    "/usr/local/etc/haproxy/haproxy.cfg",
  ]);
  report.bridgeReused = reuse;
  report.stage = "application-service";
  await appKube(["apply", "-f", "deploy/db-lab/client-service.yaml"]);
  await appKube(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "discovery.k8s.io/v1",
      kind: "EndpointSlice",
      metadata: {
        name: "db-lab-primary-vm",
        namespace: "shortlink",
        labels: {
          "kubernetes.io/service-name": network.serviceName,
          "endpointslice.kubernetes.io/managed-by":
            "db-lab-connect.shortlink.dev",
          "shortlink.dev/exercise": "database-connectivity",
        },
      },
      addressType: "IPv4",
      ports: [{ name: "postgres", protocol: "TCP", port: network.listenPort }],
      endpoints: [
        { addresses: [report.addresses.database], conditions: { ready: true } },
      ],
    }),
  );
  report.sourceAfter = await sourceState();
  ensure(
    report.sourceBefore.deploymentSpecHash ===
      report.sourceAfter.deploymentSpecHash,
    "Source Fastify configuration changed during setup",
  );
  report.endpoint = `${network.serviceHostname}:5432`;
  report.stage = "complete";
  report.passed = true;
  console.log(
    `Private database path configured: ${report.endpoint}. Run pnpm test:db-connectivity to verify it from an application-cluster Pod.`,
  );
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`Setup evidence: ${path}/result.json`);
}
