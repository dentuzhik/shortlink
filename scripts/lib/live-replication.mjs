import { readFile } from "node:fs/promises";
import {
  appGet,
  appKube,
  dbGet,
  dbKube,
  ensure,
} from "./db-lab-connectivity.mjs";

export const config = JSON.parse(
  await readFile("deploy/migration/live-copy.json", "utf8"),
);
export const sourceSql = (text) =>
  appKube(
    [
      "exec",
      "-i",
      "deployment/postgres",
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "shortener",
      "-d",
      "shortener",
    ],
    `SET statement_timeout='8s'; SET lock_timeout='2s';\n${text}`,
  );
export async function primary() {
  const cluster = await dbGet(["get", "cluster", "shortlink-lab"]);
  ensure(
    cluster.status.readyInstances === 3,
    "Expected three healthy destination instances",
  );
  return cluster.status.currentPrimary;
}
export const targetSql = async (text, database = config.database, pod) =>
  dbKube(
    [
      "exec",
      "-i",
      pod ?? (await primary()),
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      database,
    ],
    `SET statement_timeout='8s'; SET lock_timeout='2s';\n${text}`,
  );
export const digestSql = `SET timezone='UTC'; SELECT json_build_object(
'linksCount',(SELECT count(*) FROM public.links),
'links',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text COLLATE "C"),''),'UTF8')),'hex') FROM public.links x),
'historyCount',(SELECT count(*) FROM drizzle.__drizzle_migrations),
'history',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E'\\n' ORDER BY to_jsonb(x)::text COLLATE "C"),''),'UTF8')),'hex') FROM drizzle.__drizzle_migrations x));`;
export const localeSql =
  "SELECT row_to_json(x) FROM (SELECT pg_encoding_to_char(encoding) AS encoding,datlocprovider,datcollate,datctype,datlocale,datcollversion FROM pg_database WHERE datname=current_database())x;";
export const schemaSql = `SELECT json_agg(x ORDER BY schema,name) FROM (
 SELECT n.nspname AS schema,c.relname AS name,
 (SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'default',pg_get_expr(d.adbin,d.adrelid),'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
 (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid) AS constraints,
 (SELECT json_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid=c.oid) AS indexes
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid IN ('public.links'::regclass,'drizzle.__drizzle_migrations'::regclass)
)x;`;
export async function state() {
  const source = JSON.parse(
    await sourceSql(
      `SELECT json_build_object('time',clock_timestamp(),'walLsn',pg_current_wal_lsn()::text,'slots',(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT slot_name,plugin,slot_type,active,wal_status,invalidation_reason,pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::text AS retained_bytes,pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn)::text AS unconfirmed_bytes FROM pg_replication_slots WHERE database=current_database())x),'sender',(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT r.application_name,r.state,s.ssl FROM pg_stat_replication r JOIN pg_stat_ssl s ON r.pid=s.pid WHERE r.usename='shortlink_migrator')x));`,
    ),
  );
  const destination = JSON.parse(
    await targetSql(
      `SELECT json_build_object('relations',(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT srrelid::regclass::text AS name,srsubstate AS state FROM pg_subscription_rel WHERE srsubid=(SELECT oid FROM pg_subscription WHERE subname='shortlink_migration_sub'))x),'workers',(SELECT coalesce(json_agg(x),'[]'::json) FROM (SELECT worker_type,pid,received_lsn::text,last_msg_receipt_time,latest_end_lsn::text FROM pg_stat_subscription WHERE subname='shortlink_migration_sub')x),'errors',(SELECT json_build_object('apply',apply_error_count,'sync',sync_error_count) FROM pg_stat_subscription_stats WHERE subname='shortlink_migration_sub'));`,
    ),
  );
  const slot = source.slots.find(
    (s) => s.slot_name === "shortlink_migration_sub",
  );
  ensure(
    !slot ||
      (slot.wal_status !== "lost" &&
        !slot.invalidation_reason &&
        Number(slot.retained_bytes) < 96 * 1024 * 1024),
    "Source slot is invalid or retained WAL reached the stop/re-copy threshold",
  );
  ensure(
    !destination.errors ||
      (Number(destination.errors.apply) === 0 &&
        Number(destination.errors.sync) === 0),
    "Logical replication recorded apply/synchronization errors",
  );
  return { source, destination };
}
export async function watcher(required) {
  const metadata = {
    name: "migration-replication-watch",
    namespace: "shortlink",
    labels: { "shortlink.dev/exercise": "live-replication" },
  };
  await appKube(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata,
      data: {
        "check.sql": await readFile(
          "deploy/migration/replication-watch.sql",
          "utf8",
        ),
        "watch.sh": await readFile("scripts/watch-replication.sh", "utf8"),
        "require-slot": String(required),
      },
    }),
  );
  const sourcePod = (await appGet(["get", "pods", "-l", "app=postgres"])).items;
  ensure(sourcePod.length === 1, "Expected one source Postgres pod");
  const image = JSON.parse(
    await readFile("deploy/migration/rehearsal.json", "utf8"),
  ).publisherImage;
  await appKube(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata,
      spec: {
        schedule: "* * * * *",
        concurrencyPolicy: "Forbid",
        startingDeadlineSeconds: 30,
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: 30,
            template: {
              metadata: { labels: metadata.labels },
              spec: {
                restartPolicy: "Never",
                automountServiceAccountToken: false,
                nodeSelector: {
                  "kubernetes.io/hostname": sourcePod[0].spec.nodeName,
                },
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 999,
                  runAsGroup: 999,
                },
                containers: [
                  {
                    name: "watch",
                    image,
                    command: ["sh", "/check/watch.sh"],
                    env: [
                      {
                        name: "PGHOST",
                        value: "postgres.shortlink.svc.cluster.local",
                      },
                      { name: "PGSSLMODE", value: "verify-full" },
                      { name: "PGSSLROOTCERT", value: "/trust/ca.crt" },
                      { name: "PGCONNECT_TIMEOUT", value: "3" },
                      ...[
                        ["PGUSER", "username"],
                        ["PGPASSWORD", "password"],
                        ["PGDATABASE", "dbname"],
                      ].map(([name, key]) => ({
                        name,
                        valueFrom: {
                          secretKeyRef: {
                            name: "source-replication-login",
                            key,
                          },
                        },
                      })),
                    ],
                    resources: {
                      requests: { cpu: "10m", memory: "32Mi" },
                      limits: { cpu: "100m", memory: "64Mi" },
                    },
                    securityContext: {
                      readOnlyRootFilesystem: true,
                      allowPrivilegeEscalation: false,
                      capabilities: { drop: ["ALL"] },
                    },
                    volumeMounts: [
                      { name: "check", mountPath: "/check", readOnly: true },
                      { name: "trust", mountPath: "/trust", readOnly: true },
                      {
                        name: "source-data",
                        mountPath: "/source-data",
                        readOnly: true,
                      },
                    ],
                  },
                ],
                volumes: [
                  { name: "check", configMap: { name: metadata.name } },
                  {
                    name: "trust",
                    secret: {
                      secretName: "source-publisher-ca",
                      items: [{ key: "ca.crt", path: "ca.crt" }],
                    },
                  },
                  {
                    name: "source-data",
                    persistentVolumeClaim: {
                      claimName: "postgres-data",
                      readOnly: true,
                    },
                  },
                ],
              },
            },
          },
        },
      },
    }),
  );
}

// Administrative lock transport only. Replication still uses its private TLS path.
export async function holdCopy(pod, database) {
  const { spawn } = await import("node:child_process");
  ensure(/^[a-z0-9_-]+$/.test(database), "Unexpected lock database name");
  const child = spawn(
    "kubectl",
    [
      "--kubeconfig",
      ".kind/db-cluster/kubeconfig",
      "--context",
      "kind-shortlink-db",
      "-n",
      "database-lab",
      "exec",
      "-i",
      pod,
      "--",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      database,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error("Destination copy-lock session exited unexpectedly"),
          ),
    );
  });
  done.catch(() => {});
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdin.end("ROLLBACK;\\q\n");
      reject(new Error("Could not acquire destination copy-test lock"));
    }, 8000);
    let data = "";
    child.stdout.on("data", (chunk) => {
      data += chunk;
      if (data.includes("COPY_LOCK_HELD")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error("Copy lock exited before acquisition"));
    });
    child.stdin.write(
      "SET idle_in_transaction_session_timeout='30s'; SET lock_timeout='2s'; BEGIN; LOCK TABLE public.links IN SHARE MODE;\n\\echo COPY_LOCK_HELD\n",
    );
  });
  return {
    heldAt: new Date().toISOString(),
    isHeld: () => child.exitCode === null,
    release: async () => {
      child.stdin.end("ROLLBACK;\n\\q\n");
      await done;
    },
  };
}
