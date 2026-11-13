import assert from "node:assert/strict";
import test from "node:test";
import {
  platformDigest,
  verifiedPlatforms,
  verifyImageMetadata,
} from "../lib/published-image.mjs";

const revision = "a".repeat(40);
const image = "ghcr.io/dentuzhik/shortlink-redirect";
const digest = `sha256:${"b".repeat(64)}`;
const arm = { platform: { os: "linux", architecture: "arm64" }, digest };
const records = ["amd64", "arm64"].map((arch) => ({
  image,
  revision,
  platform: `linux/${arch}`,
  digest,
  indexDigest: `sha256:${"c".repeat(64)}`,
}));

test("platform selection excludes attestations and rejects ambiguous or missing architectures", () => {
  assert.equal(
    platformDigest(
      { manifests: [arm, { platform: { architecture: "unknown" } }] },
      "arm64",
    ),
    digest,
  );
  assert.throws(
    () => platformDigest({ manifests: [arm] }, "amd64"),
    /Expected one/,
  );
  assert.throws(
    () => platformDigest({ manifests: [arm, arm] }, "arm64"),
    /Expected one/,
  );
  assert.throws(
    () => platformDigest({ manifests: [arm] }, "other"),
    /Unsupported/,
  );
  assert.throws(
    () =>
      platformDigest({ manifests: [{ ...arm, digest: "latest" }] }, "arm64"),
    /Missing image digest/,
  );
});

test("publication refuses mixed commits, repositories, or duplicate platform records", () => {
  assert.deepEqual(
    verifiedPlatforms([...records].reverse(), image, revision).map(
      (x) => x.platform,
    ),
    ["linux/amd64", "linux/arm64"],
  );
  for (const field of ["image", "revision"]) {
    const wrong = structuredClone(records);
    wrong[1][field] = "other";
    assert.throws(
      () => verifiedPlatforms(wrong, image, revision),
      /inconsistent/,
    );
  }
  assert.throws(
    () => verifiedPlatforms([records[0], records[0]], image, revision),
    /inconsistent/,
  );
  assert.throws(
    () => verifiedPlatforms([records[0]], image, revision),
    /exactly two/,
  );
});

test("pulled artifacts must match architecture and both baked revision signals", () => {
  const info = {
    Os: "linux",
    Architecture: "arm64",
    Config: {
      Labels: { "org.opencontainers.image.revision": revision },
      Env: [`APP_REVISION=${revision}`],
    },
  };
  verifyImageMetadata(info, revision, "arm64");
  assert.throws(
    () => verifyImageMetadata(info, revision, "amd64"),
    /does not match/,
  );
  const wrong = structuredClone(info);
  wrong.Config.Env = ["APP_REVISION=development"];
  assert.throws(
    () => verifyImageMetadata(wrong, revision, "arm64"),
    /does not match/,
  );
  wrong.Config.Env = info.Config.Env;
  wrong.Config.Labels["org.opencontainers.image.revision"] = "other";
  assert.throws(
    () => verifyImageMetadata(wrong, revision, "arm64"),
    /does not match/,
  );
});
