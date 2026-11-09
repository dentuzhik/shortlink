import Fastify from "fastify";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { registerRedirectRoute } from "../src/redirect.js";

const code = "aB3kP9_x";

function setup() {
  const app = Fastify();
  const findTargetUrl = vi.fn<Parameters<typeof registerRedirectRoute>[1]>();
  registerRedirectRoute(app, findTargetUrl);
  onTestFinished(() => app.close());

  return {
    findTargetUrl,
    visit: () => app.inject({ method: "GET", url: `/${code}` }),
  };
}

describe("GET /:code", () => {
  test("returns the current destination on each visit with 302 and no-store", async () => {
    const { findTargetUrl, visit } = setup();
    const oldUrl = "https://example.com/old";
    const newUrl = "https://example.com/new";
    findTargetUrl.mockResolvedValueOnce(oldUrl).mockResolvedValueOnce(newUrl);

    for (const expectedUrl of [oldUrl, newUrl]) {
      const response = await visit();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(expectedUrl);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(findTargetUrl.mock.calls).toEqual([[code], [code]]);
  });

  test("returns an uncached 404 for a missing code", async () => {
    const { findTargetUrl, visit } = setup();
    findTargetUrl.mockResolvedValue(undefined);

    const response = await visit();

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("distinguishes a database failure from a missing link", async () => {
    const { findTargetUrl, visit } = setup();
    findTargetUrl.mockRejectedValue(new Error("internal database details"));

    const response = await visit();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Could not look up link" });
  });
});
