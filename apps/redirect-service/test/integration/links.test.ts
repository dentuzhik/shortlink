import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.js";

const run = promisify(execFile);

describe("links with Postgres", () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:18.6")
      .withDatabase("shortener_test")
      .start();
    const databaseUrl = postgres.getConnectionUri();

    // Run the same migration command as local development, on the test DB.
    await run("pnpm", ["--workspace-root", "run", "db:migrate"], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 30_000,
    });

    app = buildApp(databaseUrl);
    app.log.level = "silent";
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await postgres?.stop();
    }
  }, 30_000);

  test("creates a link and redirects from its stored code", async () => {
    const targetUrl = "https://example.com/guide";
    const created = await app.inject({
      method: "POST",
      url: "/links",
      payload: { targetUrl },
    });

    expect(created.statusCode).toBe(201);
    const { code } = created.json<{ code: string }>();
    expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);

    const redirect = await app.inject({ method: "GET", url: `/${code}` });

    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(targetUrl);
    expect(redirect.headers["cache-control"]).toBe("no-store");
  });

  test("returns 404 when Postgres has no matching code", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/not-created",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Link not found" });
  });
});
