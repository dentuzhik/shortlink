import assert from "node:assert/strict";
import test from "node:test";
import { shortLinkOrigin } from "../../apps/web/lib/runtime-config.ts";

test("public origin is read at request time rather than captured on import", () => {
  const previous = process.env.SHORT_LINK_ORIGIN;
  try {
    process.env.SHORT_LINK_ORIGIN = "http://go.localhost:8080/";
    assert.equal(shortLinkOrigin(), "http://go.localhost:8080");
    process.env.SHORT_LINK_ORIGIN = "https://links.example.com";
    assert.equal(shortLinkOrigin(), "https://links.example.com");
    for (const invalid of [
      "not-a-url",
      "javascript:alert(1)",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?secret=value",
      "https://example.com#fragment",
    ]) {
      process.env.SHORT_LINK_ORIGIN = invalid;
      assert.throws(() => shortLinkOrigin());
    }
  } finally {
    if (previous === undefined) delete process.env.SHORT_LINK_ORIGIN;
    else process.env.SHORT_LINK_ORIGIN = previous;
  }
});
