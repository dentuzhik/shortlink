import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertHaRolePolicy,
  caPath,
  hbaBlock,
  renderRuntimeRoles,
  runtimeTemplate,
  sourceHostname,
  sourceTemplate,
  sourceUrl,
  withoutRuntimeCredentials,
  withoutSourceCredentials,
} from "../lib/application-roles.mjs";

const template = {
  metadata: { labels: { app: "redirect-service" } },
  spec: {
    serviceAccountName: "redirect-runtime-control",
    containers: [
      {
        name: "api",
        image: "example@sha256:pinned",
        envFrom: [{ secretRef: { name: "postgres-credentials" } }],
        env: [
          { name: "POSTGRES_HOST", value: "postgres" },
          {
            name: "HA_DATABASE_URL",
            valueFrom: {
              secretKeyRef: { name: "fastify-ha-target", key: "url" },
            },
          },
        ],
        volumeMounts: [{ name: "ha-database-trust", mountPath: "/ha" }],
      },
    ],
    volumes: [
      {
        name: "ha-database-trust",
        secret: { secretName: "fastify-ha-target" },
      },
    ],
  },
};
test("runtime credentials replace the administrator injection while retaining image, HA wiring and runtime control", () => {
  const next = sourceTemplate(template);
  assert.deepEqual(
    withoutSourceCredentials(next),
    withoutSourceCredentials(template),
  );
  assert.deepEqual(sourceTemplate(next), next);
  assert.equal(next.spec.containers[0].envFrom, undefined);
  assert.ok(!JSON.stringify(next).includes("postgres-credentials"));
  assert.equal(
    next.spec.containers[0].image,
    template.spec.containers[0].image,
  );
  const bad = structuredClone(template);
  bad.spec.volumes.push({
    name: "admin",
    secret: { secretName: "postgres-credentials" },
  });
  assert.throws(() => sourceTemplate(bad));
});
test("the source URL requires verified TLS and the application role, and escapes passwords", () => {
  const password = "a@:/?#% value";
  const url = new URL(sourceUrl(password));
  assert.equal(url.username, "shortlink_app");
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.hostname, sourceHostname);
  assert.equal(url.pathname, "/shortener");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(url.searchParams.get("sslrootcert"), caPath);
});
test("only enabled, owned credential state changes the rendered API deployment", () => {
  const list = {
    kind: "List",
    items: [
      {
        kind: "Deployment",
        metadata: { name: "redirect-service" },
        spec: { template },
      },
      {
        kind: "Deployment",
        metadata: { name: "web" },
        spec: { template: { unchanged: true } },
      },
    ],
  };
  const state = {
    metadata: { labels: { "shortlink.dev/exercise": "application-roles" } },
    data: {
      role: "shortlink_app",
      secret: "source-app-credentials",
      status: "prepared",
    },
  };
  assert.equal(renderRuntimeRoles(list, null), list);
  assert.equal(renderRuntimeRoles(list, state), list);
  const enabled = renderRuntimeRoles(list, {
    ...state,
    data: { ...state.data, status: "enabled" },
  });
  assert.deepEqual(enabled.items[1], list.items[1]);
  assert.deepEqual(enabled.items[0].spec.template, runtimeTemplate(template));
  assert.throws(() =>
    renderRuntimeRoles(list, { ...state, metadata: { labels: {} } }),
  );
});
test("application HBA rules precede permissive local rules and the grant SQL names only runtime objects", async () => {
  const hba = await readFile(
    new URL("../../deploy/migration/pg_hba.conf", import.meta.url),
    "utf8",
  );
  assert.ok(hba.includes(hbaBlock));
  assert.ok(
    hba.indexOf(hbaBlock) < hba.indexOf("host all all 127.0.0.1/32 trust"),
  );
  const grants = await readFile(
    new URL(
      "../../deploy/migration/application-runtime-role.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(grants.includes("GRANT SELECT,INSERT ON TABLE public.links"));
  assert.ok(grants.includes("GRANT USAGE ON SEQUENCE public.links_id_seq"));
  assert.ok(!grants.includes("GRANT ALL"));
  assert.ok(!grants.includes("ALTER DEFAULT PRIVILEGES"));
  assert.ok(!grants.includes("ON ALL TABLES"));
});

test("combined credential wiring retains application behavior while removing both owner logins", () => {
  const next = runtimeTemplate(template);
  assert.deepEqual(
    withoutRuntimeCredentials(next),
    withoutRuntimeCredentials(template),
  );
  assert.deepEqual(runtimeTemplate(next), next);
  assert.ok(!JSON.stringify(next).includes('"postgres-credentials"'));
  assert.ok(!JSON.stringify(next).includes('"fastify-ha-target"'));
});

test("CNPG omission of false/empty role fields is equivalent, but elevated rights or disabled login are rejected", () => {
  const policy = {
    name: "shortlink_app",
    superuser: false,
    inherit: false,
    login: true,
    inRoles: [],
  };
  assert.doesNotThrow(() =>
    assertHaRolePolicy(
      { name: "shortlink_app", inherit: false, login: true },
      policy,
    ),
  );
  assert.throws(() =>
    assertHaRolePolicy({ ...policy, superuser: true }, policy),
  );
  assert.throws(() => assertHaRolePolicy({ ...policy, login: false }, policy));
  assert.throws(() =>
    assertHaRolePolicy({ ...policy, inRoles: ["shortener"] }, policy),
  );
});
