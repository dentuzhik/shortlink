import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
process.umask(0o077);
export const network = JSON.parse(
  await readFile("deploy/db-lab/connectivity.json", "utf8"),
);
export const appTarget = [
  "--kubeconfig",
  ".kind/kubeconfig",
  "--context",
  "kind-shortlink",
  "-n",
  "shortlink",
];
export const dbTarget = [
  "--kubeconfig",
  ".kind/db-cluster/kubeconfig",
  "--context",
  "kind-shortlink-db",
  "-n",
  "database-lab",
];
export const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function run(command, args, input, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // Child output can contain credentials. Never include it in an exception.
        if (error)
          reject(
            new Error(
              `${command} failed (${error.code}); inspect the explicitly selected lab target`,
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export const appKube = (args, input, timeout) =>
  run("kubectl", [...appTarget, ...args], input, timeout);
export const dbKube = (args, input, timeout) =>
  run("kubectl", [...dbTarget, ...args], input, timeout);
export const appGet = async (args) =>
  JSON.parse(await appKube([...args, "-o", "json"]));
export const dbGet = async (args) =>
  JSON.parse(await dbKube([...args, "-o", "json"]));
export const docker = (args) =>
  run("docker", ["--context", "colima-shortlink-db", ...args]);
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function directory(kind) {
  const path = `.kind/db-cluster/${kind}/${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
export async function vmAddresses() {
  const resolved = await run("colima", [
    "-p",
    "default",
    "ssh",
    "--",
    "getent",
    "ahostsv4",
    network.databaseVmHost,
  ]);
  const database = resolved.trim().split(/\s+/)[0];
  ensure(isIPv4(database), "Could not resolve database VM IPv4 address");
  const route = await run("colima", [
    "-p",
    "default",
    "ssh",
    "--",
    "ip",
    "-4",
    "route",
    "get",
    database,
  ]);
  const application = route.match(/\bsrc (\S+)/)?.[1];
  ensure(
    isIPv4(application) && isIPv4(database) && application !== database,
    "Expected distinct IPv4 addresses on the existing private VM network",
  );
  return { application, database };
}
export async function sourceState() {
  const deployment = await appGet(["get", "deployment", "redirect-service"]);
  const result = {
    deploymentSpecHash: hash(deployment.spec),
    readyReplicas: deployment.status.readyReplicas,
  };
  for (const [name, host, path] of [
    ["api", "go.localhost", "/readyz"],
    ["ui", "app.localhost", "/"],
  ]) {
    result[name] = (
      await run("curl", [
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--max-time",
        "3",
        "--resolve",
        `${host}:8080:127.0.0.1`,
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        `http://${host}:8080${path}`,
      ])
    ).trim();
  }
  ensure(
    result.api === "200" && result.ui === "200" && result.readyReplicas >= 2,
    "Source application is not healthy",
  );
  return result;
}
