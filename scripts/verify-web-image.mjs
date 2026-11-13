import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2];
if (!image)
  throw new Error("Usage: verify-web-image.mjs <local-image-reference>");
const docker = async (...args) => (await execute("docker", args)).stdout.trim();

async function ready(url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
      await response.body?.cancel();
    } catch {}
    await setTimeout(200);
  }
  throw new Error("Web image did not become ready within 20 seconds");
}

for (const origin of [
  "http://go.localhost:8080",
  "https://links.example.com",
]) {
  const id = await docker(
    "run",
    "--detach",
    "--rm",
    "--publish",
    "127.0.0.1::3001",
    "--env",
    `SHORT_LINK_ORIGIN=${origin}`,
    image,
  );
  try {
    const address = await docker("port", id, "3001/tcp");
    assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
    const response = await ready(`http://${address}/`);
    const body = await response.text();
    // React serializes the server-provided prop into the page's initial payload.
    assert.ok(
      body.includes(origin),
      `Page did not receive runtime origin ${origin}`,
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    console.log(`Verified runtime hostname ${origin} in ${image}`);
  } finally {
    await docker("rm", "--force", id);
  }
}
