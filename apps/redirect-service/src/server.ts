import { buildApp } from "./app.js";
import { readDatabaseUrl } from "./database.js";

const app = buildApp(readDatabaseUrl(process.env.DATABASE_URL));

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down");

  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({
    host: process.env.LISTEN_HOST ?? "127.0.0.1",
    port: 3000,
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
