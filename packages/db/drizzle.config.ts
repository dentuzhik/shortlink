import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "drizzle-kit";

// The workspace scripts run from packages/db. An exported DATABASE_URL wins.
const envFile = "../../.env";
if (existsSync(envFile)) loadEnvFile(envFile);

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
});
