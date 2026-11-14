import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const project = `shortlink-e2e-${process.pid}`;
const artifacts = resolve(
  process.env.E2E_ARTIFACT_DIR ??
    `.kind/e2e-containers/${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
const usePublished = Boolean(
  process.env.E2E_API_IMAGE && process.env.E2E_WEB_IMAGE,
);
if (Boolean(process.env.E2E_API_IMAGE) !== Boolean(process.env.E2E_WEB_IMAGE))
  throw new Error("Supply both E2E_API_IMAGE and E2E_WEB_IMAGE, or neither");
const env = {
  ...process.env,
  E2E_API_IMAGE: process.env.E2E_API_IMAGE ?? `shortlink-e2e-api:${project}`,
  E2E_WEB_IMAGE: process.env.E2E_WEB_IMAGE ?? `shortlink-e2e-web:${project}`,
};
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--file",
  "tests/e2e/compose.yaml",
];
const output = async (command, args) =>
  (await execute(command, args, { env, maxBuffer: 16 * 1024 * 1024 })).stdout;
let activeChild;
let interrupted = false;
let cleaning = false;
const interrupt = () => {
  interrupted = true;
  activeChild?.kill("SIGINT");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function run(command, args) {
  if (interrupted && !cleaning) throw new Error("E2E run interrupted");
  await new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? done()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
const compose = (...args) => run("docker", [...composeArgs, ...args]);
await mkdir(artifacts, { recursive: true });
const report = {
  project,
  artifacts,
  usePublished,
  apiImage: env.E2E_API_IMAGE,
  webImage: env.E2E_WEB_IMAGE,
  startedAt: Date.now(),
};
if ((await output("docker", [...composeArgs, "ps", "--all", "--quiet"])).trim())
  throw new Error(
    `Refusing to reuse an existing Compose test project: ${project}`,
  );
try {
  if (usePublished) {
    await run("docker", ["pull", env.E2E_API_IMAGE]);
    await run("docker", ["pull", env.E2E_WEB_IMAGE]);
  } else {
    await compose("build", "redirect-service", "web");
  }
  await compose(
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--no-build",
    "redirect-service",
  );
  const apiAddress = (
    await output("docker", [...composeArgs, "port", "redirect-service", "3000"])
  ).trim();
  if (!/^127\.0\.0\.1:[0-9]+$/.test(apiAddress))
    throw new Error("Unexpected API host-port mapping");
  env.E2E_REDIRECT_ORIGIN = `http://${apiAddress}`;
  await compose(
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "120",
    "--no-build",
    "--no-deps",
    "web",
  );
  const webAddress = (
    await output("docker", [...composeArgs, "port", "web", "3001"])
  ).trim();
  if (!/^127\.0\.0\.1:[0-9]+$/.test(webAddress))
    throw new Error("Unexpected web host-port mapping");
  env.E2E_BASE_URL = `http://${webAddress}`;
  env.E2E_ARTIFACT_DIR = `${artifacts}/playwright`;
  report.urls = { ui: env.E2E_BASE_URL, redirect: env.E2E_REDIRECT_ORIGIN };
  await run("pnpm", ["exec", "playwright", "test"]);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  cleaning = true;
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  try {
    await writeFile(
      `${artifacts}/containers.ndjson`,
      await output("docker", [
        ...composeArgs,
        "ps",
        "--all",
        "--format",
        "json",
      ]),
    );
    await writeFile(
      `${artifacts}/containers.log`,
      await output("docker", [
        ...composeArgs,
        "logs",
        "--no-color",
        "--timestamps",
      ]),
    );
  } catch (error) {
    report.diagnosticsError = error.message;
  }
  try {
    await compose("down", "--volumes", "--remove-orphans");
  } catch (error) {
    report.cleanupError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  report.finishedAt = Date.now();
  await writeFile(
    `${artifacts}/run.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`E2E evidence: ${artifacts}`);
  if (report.error) console.error(report.error);
}
