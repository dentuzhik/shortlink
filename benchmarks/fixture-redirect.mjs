import { readFileSync, writeFileSync } from "node:fs";

// Run inside the disposable benchmark container, after the Postgres run.
const appPath = "/app/apps/redirect-service/dist/app.js";
const registration =
  "registerRedirectRoute(app, linkStore.findTargetUrl, reportPoolWait);";
const appSource = readFileSync(appPath, "utf8");

if (appSource.split(registration).length !== 2) {
  throw new Error("Expected exactly one Postgres redirect registration");
}

// Match the codes and destinations in seed.sql.
const fixtureRegistration = `const fixtureTargets = new Map();
    for (let id = 1; id <= 1000; id++) {
      const code = String(id).padStart(8, "0");
      fixtureTargets.set(code, "https://example.com/benchmark/" + code);
    }
    registerRedirectRoute(app, async (code) => fixtureTargets.get(code), reportPoolWait);`;

writeFileSync(appPath, appSource.replace(registration, fixtureRegistration));
