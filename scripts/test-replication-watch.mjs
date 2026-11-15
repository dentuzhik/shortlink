import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  appGet,
  appKube,
  directory,
  ensure,
} from "./lib/db-lab-connectivity.mjs";

const path = await directory("replication-watch-tests");
const id = randomUUID().slice(0, 8);
const report = { startedAt: new Date().toISOString(), passed: false };
const objects = [];
try {
  const cron = await appGet(["get", "cronjob", "migration-replication-watch"]);
  for (const negative of [false, true]) {
    const name = `migration-watch-${negative ? "negative" : "positive"}-${id}`;
    const metadata = {
      name,
      labels: { "shortlink.dev/exercise": "replication-watch-test" },
    };
    objects.push(name);
    await appKube(
      ["create", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata,
        data: {
          "check.sql": (
            await readFile("deploy/migration/replication-watch.sql", "utf8")
          ).replaceAll(
            "shortlink_migration_sub",
            negative ? `missing_test_${id}` : "shortlink_migration_sub",
          ),
          "watch.sh": await readFile("scripts/watch-replication.sh", "utf8"),
          "require-slot": "true",
        },
      }),
    );
    const spec = structuredClone(cron.spec.jobTemplate.spec);
    spec.template.spec.volumes.find((v) => v.name === "check").configMap.name =
      name;
    await appKube(
      ["create", "-f", "-"],
      JSON.stringify({ apiVersion: "batch/v1", kind: "Job", metadata, spec }),
    );
    let job;
    for (let i = 0; i < 40; i++) {
      job = await appGet(["get", "job", name]);
      if (job.status.succeeded || job.status.failed) break;
      await delay(500);
    }
    const output = await appKube(["logs", `job/${name}`]);
    await writeFile(
      `${path}/${negative ? "negative" : "positive"}.log`,
      output,
    );
    const state = output
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l))
      .find((s) => "healthy" in s);
    ensure(
      state && state.healthy === !negative,
      "Monitor did not report the expected semantic result",
    );
    ensure(
      negative ? job.status.failed > 0 : job.status.succeeded === 1,
      "Monitor Job exit status did not match its health result",
    );
    report[negative ? "negative" : "positive"] = {
      healthy: state.healthy,
      jobFailed: !!job.status.failed,
    };
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const name of objects)
    await appKube(
      [
        "delete",
        "job,configmap",
        name,
        "--ignore-not-found=true",
        "--wait=true",
        "--timeout=30s",
      ],
      undefined,
      40000,
    );
  report.completedAt = new Date().toISOString();
  await writeFile(
    `${path}/result.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ passed: report.passed, evidence: `${path}/result.json` }),
  );
}
