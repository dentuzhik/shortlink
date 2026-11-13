import { imageDigest } from "./redirect-release.mjs";

export const redirectRepository = "ghcr.io/dentuzhik/shortlink-redirect";

export function platformDigest(index, architecture) {
  if (!["amd64", "arm64"].includes(architecture))
    throw new Error(`Unsupported architecture: ${architecture}`);
  const matches = (index.manifests ?? []).filter(
    (item) =>
      item.platform?.os === "linux" &&
      item.platform.architecture === architecture,
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one linux/${architecture} image in the published index`,
    );
  return imageDigest(matches[0].digest);
}

export function verifiedPlatforms(records, image, revision) {
  if (
    !/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(image) ||
    !/^[a-f0-9]{40}$/.test(revision)
  )
    throw new Error("Invalid published image or source revision");
  const expected = ["linux/amd64", "linux/arm64"];
  if (records.length !== 2)
    throw new Error(
      "Publishing requires exactly two verified platform records",
    );
  return expected.map((platform) => {
    const matches = records.filter((item) => item.platform === platform);
    if (
      matches.length !== 1 ||
      matches[0].image !== image ||
      matches[0].revision !== revision
    )
      throw new Error(
        `Missing or inconsistent verified artifact for ${platform}`,
      );
    return {
      platform,
      digest: imageDigest(matches[0].digest),
      indexDigest: imageDigest(matches[0].indexDigest),
    };
  });
}

export function verifyImageMetadata(info, revision, architecture) {
  if (
    info.Os !== "linux" ||
    info.Architecture !== architecture ||
    info.Config.Labels?.["org.opencontainers.image.revision"] !== revision ||
    !info.Config.Env?.includes(`APP_REVISION=${revision}`)
  )
    throw new Error(
      "Published image platform or baked revision does not match the requested release",
    );
}
