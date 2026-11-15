import assert from "node:assert/strict";
export const roleName = "shortlink_app";
export const secretName = "source-app-credentials";
export const stateName = "runtime-application-roles";
export const sourceHostname = "postgres.shortlink.svc.cluster.local";
export const caPath = "/source-db/ca.crt";
export const hbaBlock =
  "# Dedicated application login: verified TLS, one database.\nhostssl shortener shortlink_app all scram-sha-256\nhost all shortlink_app all reject\nhost replication shortlink_app all reject\n";
export function sourceUrl(password) {
  assert.ok(password);
  return `postgresql://${roleName}:${encodeURIComponent(password)}@${sourceHostname}:5432/shortener?sslmode=verify-full&sslrootcert=${caPath}`;
}
export function sourceTemplate(template) {
  const next = structuredClone(template);
  const api = next.spec.containers.filter((c) => c.name === "api");
  assert.equal(api.length, 1);
  api[0].envFrom = (api[0].envFrom ?? []).filter(
    (item) => item.secretRef?.name !== "postgres-credentials",
  );
  if (!api[0].envFrom.length) delete api[0].envFrom;
  api[0].env = (api[0].env ?? []).filter(
    (item) =>
      ![
        "DATABASE_URL",
        "POSTGRES_HOST",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "POSTGRES_DB",
      ].includes(item.name),
  );
  api[0].env.push({
    name: "DATABASE_URL",
    valueFrom: { secretKeyRef: { name: secretName, key: "url" } },
  });
  api[0].volumeMounts = [
    ...(api[0].volumeMounts ?? []).filter((v) => v.name !== "source-db-trust"),
    { name: "source-db-trust", mountPath: "/source-db", readOnly: true },
  ];
  next.spec.volumes = [
    ...(next.spec.volumes ?? []).filter((v) => v.name !== "source-db-trust"),
    {
      name: "source-db-trust",
      secret: {
        secretName,
        defaultMode: 292,
        items: [{ key: "ca.crt", path: "ca.crt" }],
      },
    },
  ];
  assert.ok(
    !JSON.stringify(next).includes('"postgres-credentials"'),
    "The API pod must not receive the administrator Secret",
  );
  return next;
}
export function withoutSourceCredentials(template) {
  const next = structuredClone(template);
  for (const c of next.spec.containers.filter((item) => item.name === "api")) {
    c.envFrom = (c.envFrom ?? []).filter(
      (item) => item.secretRef?.name !== "postgres-credentials",
    );
    if (!c.envFrom.length) delete c.envFrom;
    c.env = (c.env ?? []).filter(
      (item) =>
        ![
          "DATABASE_URL",
          "POSTGRES_HOST",
          "POSTGRES_USER",
          "POSTGRES_PASSWORD",
          "POSTGRES_DB",
        ].includes(item.name),
    );
    c.volumeMounts = (c.volumeMounts ?? []).filter(
      (item) => item.name !== "source-db-trust",
    );
    if (!c.volumeMounts.length) delete c.volumeMounts;
  }
  next.spec.volumes = (next.spec.volumes ?? []).filter(
    (item) => item.name !== "source-db-trust",
  );
  if (!next.spec.volumes.length) delete next.spec.volumes;
  return next;
}
export function renderRuntimeRoles(list, state) {
  assert.ok(list.kind === "List" && Array.isArray(list.items));
  if (!state) return list;
  assert.equal(
    state.metadata.labels?.["shortlink.dev/exercise"],
    "application-roles",
  );
  assert.equal(state.data.role, roleName);
  assert.equal(state.data.secret, secretName);
  if (state.data.status === "prepared") return list;
  assert.equal(state.data.status, "enabled");
  return {
    ...list,
    items: list.items.map((item) =>
      item.kind === "Deployment" && item.metadata.name === "redirect-service"
        ? {
            ...item,
            spec: {
              ...item.spec,
              template: runtimeTemplate(item.spec.template),
            },
          }
        : item,
    ),
  };
}

export const haSecretName = "ha-app-credentials";
export const haHostname = "db-lab-primary.shortlink.svc.cluster.local";
export function haUrl(password) {
  assert.ok(password);
  return `postgresql://${roleName}:${encodeURIComponent(password)}@${haHostname}:5432/shortener`;
}
export function runtimeTemplate(template) {
  const next = sourceTemplate(template);
  const api = next.spec.containers.find((c) => c.name === "api");
  api.env = api.env.filter(
    (e) =>
      ![
        "HA_DATABASE_URL",
        "HA_DATABASE_CA_FILE",
        "HA_DATABASE_SERVERNAME",
      ].includes(e.name),
  );
  api.env.push(
    {
      name: "HA_DATABASE_URL",
      valueFrom: { secretKeyRef: { name: haSecretName, key: "url" } },
    },
    { name: "HA_DATABASE_CA_FILE", value: "/etc/shortlink/ha-database/ca.crt" },
    { name: "HA_DATABASE_SERVERNAME", value: haHostname },
  );
  api.volumeMounts = api.volumeMounts.filter(
    (v) => v.name !== "ha-database-trust",
  );
  api.volumeMounts.push({
    name: "ha-database-trust",
    mountPath: "/etc/shortlink/ha-database",
    readOnly: true,
  });
  next.spec.volumes = next.spec.volumes.filter(
    (v) => v.name !== "ha-database-trust",
  );
  next.spec.volumes.push({
    name: "ha-database-trust",
    secret: {
      secretName: haSecretName,
      defaultMode: 292,
      items: [{ key: "ca.crt", path: "ca.crt" }],
    },
  });
  assert.ok(
    !JSON.stringify(next).includes('"fastify-ha-target"'),
    "Runtime pods must not receive the old HA owner login",
  );
  return next;
}
export function withoutRuntimeCredentials(template) {
  const next = withoutSourceCredentials(template);
  const api = next.spec.containers.find((c) => c.name === "api");
  api.env = api.env.filter(
    (e) =>
      ![
        "HA_DATABASE_URL",
        "HA_DATABASE_CA_FILE",
        "HA_DATABASE_SERVERNAME",
      ].includes(e.name),
  );
  api.volumeMounts = (api.volumeMounts ?? []).filter(
    (v) => v.name !== "ha-database-trust",
  );
  if (!api.volumeMounts.length) delete api.volumeMounts;
  next.spec.volumes = (next.spec.volumes ?? []).filter(
    (v) => v.name !== "ha-database-trust",
  );
  if (!next.spec.volumes.length) delete next.spec.volumes;
  return next;
}

// CNPG omits false/empty fields when it writes the reconciled CR back.
export function assertHaRolePolicy(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const observed =
      actual[key] ??
      (value === false
        ? false
        : Array.isArray(value) && value.length === 0
          ? []
          : undefined);
    assert.deepEqual(observed, value, `HA role policy differs: ${key}`);
  }
}
