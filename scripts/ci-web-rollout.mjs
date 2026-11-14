import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyImageMetadata } from "./lib/published-image.mjs";
import { imageDigest, releaseTarget } from "./lib/redirect-release.mjs";

const [action, ...extra] = process.argv.slice(2);
if (!["up", "collect", "down"].includes(action) || extra.length)
  throw new Error("Usage: ci-web-rollout.mjs up|collect|down");
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.platform !== "linux" ||
  process.arch !== "x64"
)
  throw new Error(
    "This bootstrap only runs on an AMD64 GitHub Actions Linux runner",
  );
const cluster = process.env.CI_ROLLOUT_CLUSTER;
assert.match(cluster ?? "", /^shortlink-ci-[0-9]+-[0-9]+$/);
assert.equal(
  cluster,
  `shortlink-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
);
const revision = process.env.GITHUB_SHA;
assert.match(revision ?? "", /^[a-f0-9]{40}$/);
const artifacts = resolve(".kind/ci-web-rollout");
const kubeconfig = join(process.env.RUNNER_TEMP, `${cluster}.kubeconfig`);
const marker = join(process.env.RUNNER_TEMP, `${cluster}.created.json`);
const context = `kind-${cluster}`;
const kubeArgs = [
  "--kubeconfig",
  kubeconfig,
  "--context",
  context,
  "--namespace",
  "shortlink",
];
const execute = promisify(execFile);
const output = async (command, args) =>
  (
    await execute(command, args, {
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
const kube = (...args) => output("kubectl", [...kubeArgs, ...args]);
async function run(command, args, input) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, {
      stdio: [input ? "pipe" : "ignore", "inherit", "inherit"],
      timeout: 180000,
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? done()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
    if (input) {
      child.stdin.on("error", reject);
      child.stdin.end(input);
    }
  });
}
const apply = (resource) =>
  run("kubectl", [...kubeArgs, "apply", "-f", "-"], JSON.stringify(resource));
const render = async (path) => {
  const stream = await kube(
    "create",
    "--dry-run=client",
    "--validate=false",
    "-f",
    path,
    "-o",
    "json",
  );
  // kubectl prints each document separately; jq's slurp accepts that JSON stream.
  const documents = JSON.parse(
    execFileSync("jq", ["--slurp"], { input: stream, encoding: "utf8" }),
  );
  return documents.length === 1
    ? documents[0]
    : { apiVersion: "v1", kind: "List", items: documents };
};
const exists = async (path) =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );
await mkdir(artifacts, { recursive: true });

async function applicationImages() {
  const supplied = [process.env.E2E_API_IMAGE, process.env.E2E_WEB_IMAGE];
  if (Boolean(supplied[0]) !== Boolean(supplied[1]))
    throw new Error("Supply both verified image references, or neither");
  if (supplied[0]) {
    return ["redirect", "web"].map((target, index) => {
      const { repository } = releaseTarget(target);
      const reference = supplied[index];
      assert.ok(
        reference.startsWith(`${repository}@`),
        "Expected the verified repository digest reference",
      );
      const digest = imageDigest(reference);
      // Kubernetes uses the digest for pulling; this tag need not exist yet.
      return {
        target,
        image: `${repository}:${revision}@${digest}`,
        revision,
        digest,
        imagePullPolicy: "IfNotPresent",
      };
    });
  }
  const images = [];
  for (const target of ["redirect", "web"]) {
    const image = `shortlink-${target}:${revision}`;
    await run("docker", [
      "build",
      "--platform",
      "linux/amd64",
      "--target",
      target,
      "--build-arg",
      `APP_REVISION=${revision}`,
      "--tag",
      image,
      ".",
    ]);
    const [info] = JSON.parse(
      await output("docker", ["image", "inspect", image]),
    );
    verifyImageMetadata(info, revision, "amd64");
    images.push({ target, image, revision, imagePullPolicy: "Never" });
  }
  const archive = join(process.env.RUNNER_TEMP, `${cluster}-images.tar`);
  try {
    await run("docker", [
      "image",
      "save",
      "--platform",
      "linux/amd64",
      "--output",
      archive,
      ...images.map((item) => item.image),
    ]);
    await run("kind", ["load", "image-archive", "--name", cluster, archive]);
    for (const image of images) {
      const info = JSON.parse(
        await output("docker", [
          "exec",
          `${cluster}-control-plane`,
          "crictl",
          "inspecti",
          image.image,
        ]),
      );
      image.digest = imageDigest(info.status.repoDigests[0]);
    }
  } finally {
    await rm(archive, { force: true });
  }
  return images;
}

async function up() {
  const existing = (await output("kind", ["get", "clusters"]))
    .trim()
    .split("\n");
  if (existing.includes(cluster))
    throw new Error("Refusing to reuse an existing CI cluster");
  await writeFile(marker, JSON.stringify({ cluster, createdAt: Date.now() }));
  const report = { cluster, context, revision, startedAt: Date.now() };
  try {
    await run("kind", [
      "create",
      "cluster",
      "--name",
      cluster,
      "--kubeconfig",
      kubeconfig,
      "--config",
      "deploy/ci/kind.yaml",
      "--image",
      "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5",
      "--wait",
      "120s",
    ]);
    await run("kubectl", [
      ...kubeArgs,
      "apply",
      "-f",
      "deploy/k8s/namespace.yaml",
    ]);
    const secret = JSON.parse(
      await kube(
        "create",
        "secret",
        "generic",
        "postgres-credentials",
        "--from-literal=POSTGRES_USER=shortener",
        "--from-literal=POSTGRES_PASSWORD=ci-test-only",
        "--from-literal=POSTGRES_DB=shortener_ci",
        "--dry-run=client",
        "-o",
        "json",
      ),
    );
    await apply(secret);
    await run("kubectl", [
      ...kubeArgs,
      "apply",
      "-f",
      "deploy/k8s/postgres.yaml",
    ]);
    await kube("rollout", "status", "deployment/postgres", "--timeout=120s");
    const redis = await render("deploy/k8s/redis.yaml");
    redis.items.find(
      (item) => item.kind === "Deployment",
    ).spec.template.spec.containers[0].imagePullPolicy = "IfNotPresent";
    await apply(redis);
    await kube("rollout", "status", "deployment/redis", "--timeout=120s");
    const images = await applicationImages();
    report.images = images;
    const api = images.find((image) => image.target === "redirect");
    const migration = await render("deploy/k8s/migration.yaml");
    Object.assign(migration.spec.template.spec.containers[0], {
      image: api.image,
      imagePullPolicy: api.imagePullPolicy,
    });
    await apply(migration);
    await kube(
      "wait",
      "--for=condition=complete",
      "job/db-migrate",
      "--timeout=120s",
    );
    const apps = await render("deploy/k8s/apps.yaml");
    for (const image of images) {
      const profile = releaseTarget(image.target);
      const deployment = apps.items.find(
        (item) =>
          item.kind === "Deployment" &&
          item.metadata.name === profile.deployment,
      );
      Object.assign(
        deployment.spec.template.spec.containers.find(
          (item) => item.name === profile.container,
        ),
        { image: image.image, imagePullPolicy: image.imagePullPolicy },
      );
      deployment.spec.template.metadata.annotations = {
        "shortlink.dev/git-revision": revision,
        "shortlink.dev/image-digest": image.digest,
      };
    }
    await writeFile(
      `${artifacts}/applications.json`,
      `${JSON.stringify(apps, null, 2)}\n`,
    );
    await apply(apps);
    for (const deployment of ["redirect-service", "web"]) {
      await kube(
        "rollout",
        "status",
        `deployment/${deployment}`,
        "--timeout=180s",
      );
      assert.equal(
        (
          await kube(
            "exec",
            `deployment/${deployment}`,
            "--",
            "node",
            "-p",
            "process.env.APP_REVISION",
          )
        ).trim(),
        revision,
      );
    }
    const crds = join(process.env.RUNNER_TEMP, `${cluster}-gateway.yaml`);
    await run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "2",
      "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml",
      "--output",
      crds,
    ]);
    assert.equal(
      createHash("sha256")
        .update(await readFile(crds))
        .digest("hex"),
      "356c2b8e286a964dc20995435659ad1095386329974793af10bbfe3eff977fe5",
    );
    await run("kubectl", [
      ...kubeArgs,
      "apply",
      "--server-side",
      "--field-manager=shortlink-ci-gateway",
      "-f",
      crds,
    ]);
    await kube(
      "wait",
      "--for=condition=Established",
      "--timeout=60s",
      "crd/gatewayclasses.gateway.networking.k8s.io",
      "crd/gateways.gateway.networking.k8s.io",
      "crd/httproutes.gateway.networking.k8s.io",
    );
    await run("kubectl", [
      ...kubeArgs,
      "apply",
      "-f",
      "deploy/k8s/gateway-controller.yaml",
      "-f",
      "deploy/k8s/gateway.yaml",
    ]);
    await kube(
      "rollout",
      "status",
      "deployment/gateway-controller",
      "--timeout=180s",
    );
    await kube(
      "wait",
      "--for=condition=Accepted",
      "gatewayclass/shortlink",
      "--timeout=60s",
    );
    await kube(
      "wait",
      "--for=condition=Programmed",
      "gateway/shortlink",
      "--timeout=60s",
    );
    for (const route of ["web", "redirects"]) {
      for (const condition of ["Accepted", "ResolvedRefs"])
        await kube(
          "wait",
          `--for=jsonpath={.status.parents[0].conditions[?(@.type=="${condition}")].status}=True`,
          `httproute/${route}`,
          "--timeout=60s",
        );
    }
    for (const [host, path] of [
      ["app.localhost", "/"],
      ["go.localhost", "/readyz"],
    ])
      await run("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--retry",
        "10",
        "--retry-all-errors",
        "--retry-delay",
        "1",
        "--connect-timeout",
        "1",
        "--max-time",
        "3",
        "--resolve",
        `${host}:8080:127.0.0.1`,
        `http://${host}:8080${path}`,
        "--output",
        "/dev/null",
      ]);
    await appendFile(
      process.env.GITHUB_ENV,
      `WEB_TEST_CONTEXT=${context}\nWEB_TEST_KUBECONFIG=${kubeconfig}\nWEB_TEST_ARTIFACT_DIR=${artifacts}/test\n`,
    );
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = Date.now();
    await writeFile(
      `${artifacts}/bootstrap.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
}
async function owned() {
  if (!(await exists(marker))) return false;
  assert.equal(JSON.parse(await readFile(marker, "utf8")).cluster, cluster);
  return true;
}
async function collect() {
  if (!(await owned())) return;
  const attempts = [
    [
      "resources.json",
      [
        "get",
        "pods,deployments,services,endpointslices,jobs,pvc,events",
        "-o",
        "json",
      ],
    ],
  ];
  for (const name of [
    "web",
    "redirect-service",
    "gateway-controller",
    "postgres",
    "redis",
  ])
    attempts.push([
      `${name}.log`,
      [
        "logs",
        `deployment/${name}`,
        "--all-containers",
        "--timestamps",
        "--tail=500",
      ],
    ]);
  attempts.push([
    "migration.log",
    ["logs", "job/db-migrate", "--all-containers", "--timestamps"],
  ]);
  for (const [name, args] of attempts) {
    try {
      await writeFile(`${artifacts}/${name}`, await kube(...args));
    } catch (error) {
      await writeFile(`${artifacts}/${name}.error`, error.message);
    }
  }
}
if (action === "up") await up();
else if (action === "collect") await collect();
else if (await owned()) {
  await run("kind", ["delete", "cluster", "--name", cluster]);
  await writeFile(
    `${artifacts}/cleanup.json`,
    `${JSON.stringify({ cluster, deleted: true, finishedAt: Date.now() })}\n`,
  );
  await rm(kubeconfig, { force: true });
  await rm(marker, { force: true });
}
