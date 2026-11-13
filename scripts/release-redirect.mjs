import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  imageDigest,
  imageRevision,
  reportedRevision,
  rollbackTarget,
  servingPods,
  templateRelease,
} from "./lib/redirect-release.mjs";

const execute = promisify(execFile);
const kubeArgs = [
  "--kubeconfig",
  ".kind/kubeconfig",
  "--context",
  "kind-shortlink",
  "--namespace",
  "shortlink",
];
const output = async (command, args) =>
  (await execute(command, args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
const kube = (...args) => output("kubectl", [...kubeArgs, ...args]);
const kubeJson = async (...args) =>
  JSON.parse(await kube(...args, "-o", "json"));
const [action, argument, ...extra] = process.argv.slice(2);
if (!["build", "deploy", "rollback", "status"].includes(action) || extra.length)
  throw new Error(
    "Usage: release-redirect.mjs build|deploy [git-commit] | rollback [kubernetes-revision] | status",
  );

async function run(command, args, inputFile) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, {
      stdio: [inputFile ? "pipe" : "ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
    if (inputFile) {
      child.stdin.on("error", reject);
      createReadStream(inputFile).on("error", reject).pipe(child.stdin);
    }
  });
}

async function optionalJson(command, args) {
  try {
    return JSON.parse(await output(command, args));
  } catch (error) {
    if (/No such image|no such image/.test(error.stderr ?? ""))
      return undefined;
    throw error;
  }
}

async function build(ref) {
  if (!ref && (await output("git", ["status", "--porcelain"])).trim())
    throw new Error(
      "Commit changes before releasing HEAD, or pass an explicit commit to build its archived snapshot",
    );
  const revision = (
    await output("git", ["rev-parse", "--verify", `${ref ?? "HEAD"}^{commit}`])
  ).trim();
  const image = `shortlink-redirect:${revision}`;
  imageRevision(image);
  const dockerfile = await output("git", ["show", `${revision}:Dockerfile`]);
  if (!dockerfile.includes("ARG APP_REVISION="))
    throw new Error("This commit predates versioned Fastify image support");
  const architecture = (
    await kube(
      "get",
      "node",
      "shortlink-control-plane",
      "-o",
      "jsonpath={.status.nodeInfo.architecture}",
    )
  ).trim();
  const existing = await optionalJson("docker", ["image", "inspect", image]);
  if (existing) {
    const info = existing[0];
    if (
      info.Config.Labels?.["org.opencontainers.image.revision"] !== revision ||
      !info.Config.Env.includes(`APP_REVISION=${revision}`) ||
      info.Architecture !== architecture
    )
      throw new Error(
        "Existing SHA tag has different metadata or architecture; refusing to overwrite it",
      );
    console.log(`Reusing ${image}`);
    return { image, revision };
  }
  const folder = await mkdtemp(join(tmpdir(), "shortlink-release-"));
  try {
    const archive = join(folder, "source.tar");
    await output("git", [
      "archive",
      "--format=tar",
      "--output",
      archive,
      revision,
    ]);
    console.log(
      `Building committed snapshot ${revision}; working-tree edits are excluded.`,
    );
    await run(
      "docker",
      [
        "build",
        "--platform",
        `linux/${architecture}`,
        "--target",
        "redirect",
        "--build-arg",
        `APP_REVISION=${revision}`,
        "--label",
        "org.opencontainers.image.source=https://github.com/dentuzhik/shortlink",
        "--tag",
        image,
        "-",
      ],
      archive,
    );
    return { image, revision };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function load(image, expectedDigest) {
  let info = await optionalJson("docker", [
    "exec",
    "shortlink-control-plane",
    "crictl",
    "inspecti",
    image,
  ]);
  if (!info || !expectedDigest) {
    // Docker's image ID may identify a multi-platform index. CRI's ID identifies
    // the platform configuration; hash that exact configuration for comparison.
    await output("docker", ["image", "inspect", image]);
    const architecture = (
      await kube(
        "get",
        "node",
        "shortlink-control-plane",
        "-o",
        "jsonpath={.status.nodeInfo.architecture}",
      )
    ).trim();
    const folder = await mkdtemp(join(tmpdir(), "shortlink-image-"));
    try {
      const archive = join(folder, "image.tar");
      await run("docker", [
        "image",
        "save",
        "--platform",
        `linux/${architecture}`,
        "--output",
        archive,
        image,
      ]);
      const [manifest] = JSON.parse(
        await output("tar", ["-xOf", archive, "manifest.json"]),
      );
      const config = (
        await execute("tar", ["-xOf", archive, manifest.Config], {
          encoding: "buffer",
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;
      const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
      if (!info) {
        await run("kind", [
          "load",
          "image-archive",
          "--name",
          "shortlink",
          archive,
        ]);
        info = JSON.parse(
          await output("docker", [
            "exec",
            "shortlink-control-plane",
            "crictl",
            "inspecti",
            image,
          ]),
        );
      }
      if (info.status.id !== configDigest)
        throw new Error(
          "kind's SHA tag contains different content from the built image; deployment was not changed",
        );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  const digest = imageDigest(info.status.repoDigests[0]);
  if (expectedDigest && digest !== expectedDigest)
    throw new Error(
      "Retained image digest differs from the rollback revision; deployment was not changed",
    );
  return digest;
}

const readMetrics = (pod) =>
  kube(
    "exec",
    pod,
    "--",
    "node",
    "-e",
    'fetch("http://127.0.0.1:9090/metrics").then(async r=>{if(!r.ok)throw Error("Metrics HTTP " + r.status);process.stdout.write(await r.text());}).catch(e=>{console.error(e);process.exitCode=1});',
  );
async function verify(release) {
  await run("kubectl", [
    ...kubeArgs,
    "rollout",
    "status",
    "deployment/redirect-service",
    "--timeout=120s",
  ]);
  const deployment = await kubeJson("get", "deployment", "redirect-service");
  const pods = (await kubeJson("get", "pods", "-l", "app=redirect-service"))
    .items;
  const serving = servingPods(pods, release, deployment.spec.replicas);
  const results = [];
  for (const pod of serving) {
    const revision = reportedRevision(await readMetrics(pod.metadata.name));
    if (revision !== release.revision)
      throw new Error(
        `Pod ${pod.metadata.name} reports unexpected revision ${revision}`,
      );
    results.push({
      pod: pod.metadata.name,
      image: release.image,
      imageID: pod.status.containerStatuses.find((item) => item.name === "api")
        .imageID,
      revision,
    });
  }
  console.table(
    results.map(({ pod, revision, imageID }) => ({
      pod,
      revision: revision.slice(0, 12),
      digest: imageDigest(imageID).slice(0, 19),
    })),
  );
  console.log(`Verified image: ${release.image}`);
  return results;
}

if (action === "status") {
  console.log(await kube("rollout", "history", "deployment/redirect-service"));
  const deployment = await kubeJson("get", "deployment", "redirect-service");
  console.log(
    "Git SHA identifies source; Kubernetes revision identifies a pod-template rollout.",
  );
  await verify(templateRelease(deployment.spec.template));
} else {
  const directory = resolve(
    ".kind/releases",
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${action}`,
  );
  await mkdir(directory, { recursive: true });
  const report = { action, argument, directory, startedAt: Date.now() };
  try {
    if (action === "build") {
      report.release = await build(argument);
    } else {
      const deployment = await kubeJson(
        "get",
        "deployment",
        "redirect-service",
      );
      report.before = {
        image: deployment.spec.template.spec.containers.find(
          (item) => item.name === "api",
        ).image,
        kubernetesRevision:
          deployment.metadata.annotations["deployment.kubernetes.io/revision"],
      };
      if (action === "deploy") {
        report.release = await build(argument);
        report.release.digest = await load(report.release.image);
        const { image, revision, digest } = report.release;
        await kube(
          "patch",
          "deployment",
          "redirect-service",
          "--type=strategic",
          "--patch",
          JSON.stringify({
            metadata: {
              annotations: {
                "kubernetes.io/change-cause": `Fastify ${revision}`,
              },
            },
            spec: {
              template: {
                metadata: {
                  annotations: {
                    "shortlink.dev/git-revision": revision,
                    "shortlink.dev/image-digest": digest,
                  },
                },
                spec: { containers: [{ name: "api", image }] },
              },
            },
          }),
        );
      } else {
        const sets = (
          await kubeJson("get", "replicasets", "-l", "app=redirect-service")
        ).items;
        report.release = rollbackTarget(deployment, sets, argument);
        await load(report.release.image, report.release.digest);
        await kube(
          "rollout",
          "undo",
          "deployment/redirect-service",
          `--to-revision=${report.release.kubernetesRevision}`,
        );
        await kube(
          "annotate",
          "deployment",
          "redirect-service",
          `kubernetes.io/change-cause=Rollback to Fastify ${report.release.revision}`,
          "--overwrite",
        );
      }
      report.pods = await verify(report.release);
      report.afterKubernetesRevision = (
        await kubeJson("get", "deployment", "redirect-service")
      ).metadata.annotations["deployment.kubernetes.io/revision"];
    }
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    report.finishedAt = Date.now();
    await writeFile(
      join(directory, "operation.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      resolve(".kind/releases/latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`Release evidence: ${directory}`);
  }
}
