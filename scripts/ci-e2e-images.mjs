import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { imageDigest } from "./lib/redirect-release.mjs";

const directory = process.argv[2];
const values = [];
for (const [target, name] of [
  ["redirect", "API"],
  ["web", "WEB"],
]) {
  const record = JSON.parse(
    await readFile(
      join(directory, `digests-${target}-amd64`, "amd64.json"),
      "utf8",
    ),
  );
  if (
    record.image !== `ghcr.io/${process.env.GITHUB_REPOSITORY}-${target}` ||
    record.revision !== process.env.GITHUB_SHA ||
    record.platform !== "linux/amd64"
  )
    throw new Error(`Inconsistent verified ${target} artifact`);
  values.push(
    `E2E_${name}_IMAGE=${record.image}@${imageDigest(record.digest)}`,
  );
}
await appendFile(process.env.GITHUB_ENV, `${values.join("\n")}\n`);
