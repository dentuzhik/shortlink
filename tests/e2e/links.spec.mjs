import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "@playwright/test";
import {
  createAndFollow,
  destinationServer,
  observePage,
  openCreator,
} from "./web-flow.mjs";

test("creates a link through the UI and follows its redirect", async ({
  page,
  baseURL,
}, testInfo) => {
  const appOrigin = new URL(baseURL).origin;
  const shortOrigin = new URL(
    process.env.E2E_REDIRECT_ORIGIN ?? "http://go.localhost:8080",
  ).origin;
  const destination = await destinationServer();
  const observed = observePage(page, appOrigin);
  try {
    await openCreator(page, baseURL);
    const link = await createAndFollow(
      page,
      appOrigin,
      shortOrigin,
      `${destination.origin}/${randomUUID()}`,
    );
    assert.deepEqual(
      observed.errors,
      [],
      "No JavaScript, application-request or asset failures are allowed",
    );
    await testInfo.attach("link", {
      body: JSON.stringify(link, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("created-link.png") });
  } finally {
    observed.dispose();
    await destination.close();
  }
});
