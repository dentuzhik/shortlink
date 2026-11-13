import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { platformDigest, verifiedPlatforms } from "./lib/published-image.mjs";
import { imageDigest } from "./lib/redirect-release.mjs";

const execute = promisify(execFile);
const [image, revision, directory] = process.argv.slice(2);
const records = await Promise.all(
  (await readdir(directory))
    .filter((name) => name.endsWith(".json") && name !== "published.json")
    .map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
);
const platforms = verifiedPlatforms(records, image, revision);
await execute("docker", [
  "buildx",
  "imagetools",
  "create",
  "--tag",
  `${image}:${revision}`,
  ...platforms.map((item) => `${image}@${item.indexDigest}`),
]);
const indexDigest = imageDigest(
  (
    await execute("docker", [
      "buildx",
      "imagetools",
      "inspect",
      `${image}:${revision}`,
      "--format",
      "{{.Manifest.Digest}}",
    ])
  ).stdout.trim(),
);
const index = JSON.parse(
  (
    await execute("docker", [
      "buildx",
      "imagetools",
      "inspect",
      `${image}@${indexDigest}`,
      "--raw",
    ])
  ).stdout,
);
for (const { platform, digest } of platforms) {
  if (platformDigest(index, platform.split("/")[1]) !== digest)
    throw new Error(
      `Published index differs from the verified ${platform} artifact`,
    );
}
const report = { image, revision, indexDigest, platforms };
await writeFile(
  join(directory, "published.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
await writeFile(
  process.env.GITHUB_STEP_SUMMARY,
  `### Published ${image}\n\nCommit: \`${revision}\`\n\nIndex: \`${image}@${indexDigest}\`\n\n${platforms.map((item) => `- ${item.platform}: \`${item.digest}\``).join("\n")}\n`,
  { flag: "a" },
);
