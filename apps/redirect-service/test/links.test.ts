import Fastify from "fastify";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { registerLinkRoutes } from "../src/links.js";

const targetUrl = "https://example.com/guide";
const createdAt = new Date("2026-01-01T12:00:00Z");
type InsertLink = Parameters<typeof registerLinkRoutes>[1]["insert"];

function setup(generateCode?: () => string) {
  const app = Fastify();
  const insert = vi.fn<InsertLink>();
  registerLinkRoutes(app, { insert }, generateCode);
  onTestFinished(() => app.close());

  return {
    insert,
    post: (payload: Record<string, string>) =>
      app.inject({ method: "POST", url: "/links", payload }),
  };
}

describe("POST /links", () => {
  test("saves a normalized destination and returns the generated code", async () => {
    const { insert, post } = setup();
    insert.mockImplementation(async (code, url) => ({
      code,
      targetUrl: url,
      createdAt,
    }));

    const response = await post({ targetUrl: "HTTPS://Example.COM/guide" });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ code: string }>();
    expect(body).toEqual({
      code: expect.stringMatching(/^[A-Za-z0-9_-]{8}$/),
      targetUrl,
      createdAt: createdAt.toISOString(),
    });
    expect(insert).toHaveBeenCalledExactlyOnceWith(body.code, targetUrl);
  });

  test.each<{ label: string; payload: Record<string, string> }>([
    { label: "a missing URL", payload: {} },
    { label: "a relative URL", payload: { targetUrl: "/guide" } },
    { label: "an FTP URL", payload: { targetUrl: "ftp://example.com" } },
    {
      label: "a URL with credentials",
      payload: { targetUrl: "https://user:password@example.com" },
    },
    {
      label: "a URL over the length limit",
      payload: { targetUrl: `https://example.com/${"x".repeat(2048)}` },
    },
  ])("rejects $label without attempting an insert", async ({ payload }) => {
    const { insert, post } = setup();

    const response = await post(payload);

    expect(response.statusCode).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  test("tries a fresh code after a collision", async () => {
    const generateCode = vi
      .fn<() => string>()
      .mockReturnValueOnce("taken123")
      .mockReturnValueOnce("fresh123");
    const { insert, post } = setup(generateCode);
    insert
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ code: "fresh123", targetUrl, createdAt });

    const response = await post({ targetUrl });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ code: "fresh123" });
    expect(insert.mock.calls).toEqual([
      ["taken123", targetUrl],
      ["fresh123", targetUrl],
    ]);
  });

  test("returns 503 after three collisions", async () => {
    const { insert, post } = setup(() => "taken123");
    insert.mockResolvedValue(undefined);

    const response = await post({ targetUrl });

    expect(response.statusCode).toBe(503);
    expect(insert).toHaveBeenCalledTimes(3);
  });

  test("returns a generic 500 for a database error without retrying", async () => {
    const { insert, post } = setup(() => "fresh123");
    insert.mockRejectedValue(new Error("internal database details"));

    const response = await post({ targetUrl });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Could not create link" });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
