import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const artifacts = resolve(process.env.E2E_ARTIFACT_DIR ?? ".kind/playwright");
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.mjs",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: `${artifacts}/test-results`,
  reporter: [
    ["line"],
    ["html", { outputFolder: `${artifacts}/report`, open: "never" }],
    ["json", { outputFile: `${artifacts}/results.json` }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.E2E_BASE_URL ?? "http://app.localhost:8080",
    actionTimeout: 10000,
    navigationTimeout: 10000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
