const assert = require("node:assert/strict");

async function denied(client, text) {
  await client.query("BEGIN");
  try {
    let error;
    try {
      await client.query(text);
    } catch (value) {
      error = value;
    }
    assert.equal(
      error?.code,
      "42501",
      "An application privilege boundary was not enforced",
    );
  } finally {
    await client.query("ROLLBACK");
  }
}
async function verifyPrivileges(client, fixture = false) {
  const {
    rows: [identity],
  } =
    await client.query(`SELECT current_user AS role,current_database() AS database,
    (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
    (SELECT count(*)::int FROM pg_class WHERE relowner=r.oid) AS owned_relations,
    (SELECT count(*)::int FROM pg_namespace WHERE nspowner=r.oid) AS owned_schemas,
    (SELECT count(*)::int FROM pg_database WHERE datdba=r.oid) AS owned_databases,
    has_table_privilege(current_user,'public.links','SELECT') AS can_read,
    has_table_privilege(current_user,'public.links','INSERT') AS can_insert,
    has_table_privilege(current_user,'public.links','UPDATE') AS can_update,
    has_table_privilege(current_user,'public.links','DELETE') AS can_delete,
    has_table_privilege(current_user,'public.links','TRUNCATE') AS can_truncate,
    has_schema_privilege(current_user,'public','CREATE') AS can_create_table,
    has_database_privilege(current_user,current_database(),'CREATE') AS can_create_schema,
    has_sequence_privilege(current_user,'public.links_id_seq','USAGE') AS can_allocate,
    has_sequence_privilege(current_user,'public.links_id_seq','UPDATE') AS can_setval,
    has_table_privilege(current_user,'drizzle.__drizzle_migrations','SELECT') AS can_read_history,
    has_table_privilege(current_user,'drizzle.__drizzle_migrations','INSERT') AS can_write_history,
    has_sequence_privilege(current_user,'drizzle.__drizzle_migrations_id_seq','USAGE') AS can_allocate_history
    FROM pg_roles r WHERE rolname=current_user`);
  assert.equal(identity.role, "shortlink_app");
  assert.equal(identity.database, "shortener");
  assert.equal(identity.tls, true);
  for (const key of [
    "can_read",
    "can_insert",
    "can_allocate",
    "can_read_history",
  ])
    assert.equal(identity[key], true, key);
  for (const key of [
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolinherit",
    "rolreplication",
    "rolbypassrls",
    "can_update",
    "can_delete",
    "can_truncate",
    "can_create_table",
    "can_create_schema",
    "can_setval",
    "can_write_history",
    "can_allocate_history",
  ])
    assert.equal(identity[key], false, key);
  for (const key of [
    "memberships",
    "owned_relations",
    "owned_schemas",
    "owned_databases",
  ])
    assert.equal(identity[key], 0, key);
  await client.query(
    "SELECT code,target_url,created_at FROM public.links LIMIT 1",
  );
  await client.query("SELECT hash FROM drizzle.__drizzle_migrations LIMIT 1");
  const {
    rows: [owner],
  } = await client.query(
    "SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='public.links'::regclass",
  );
  const ownerName = `"${owner.name.replaceAll('"', '""')}"`;
  const queries = [
    "UPDATE public.links SET target_url='https://example.test/denied' WHERE false",
    "DELETE FROM public.links WHERE false",
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT 'denied',0 WHERE false",
    `SET ROLE ${ownerName}`,
    `SET SESSION AUTHORIZATION ${ownerName}`,
  ];
  if (fixture)
    queries.push(
      "TRUNCATE public.links",
      "ALTER TABLE public.links ADD COLUMN forbidden integer",
      "CREATE SCHEMA forbidden",
      "SELECT setval('public.links_id_seq',1,false)",
    );
  for (const query of queries) await denied(client, query);
  return { identity, deniedQueries: queries.length };
}
async function main() {
  const { Client } = require("/app/apps/redirect-service/node_modules/pg");
  const secured = new URL(process.env.DATABASE_URL);
  secured.searchParams.set("sslmode", "verify-full");
  secured.searchParams.set("sslrootcert", "/source-db/ca.crt");
  const url = secured.href;
  assert.equal(new URL(url).username, "shortlink_app");
  assert.equal(new URL(url).pathname, "/shortener");
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    const result = await verifyPrivileges(client);
    for (const wrong of ["plaintext", "database", "password"]) {
      const candidate = new URL(url);
      if (wrong === "plaintext") {
        candidate.search = "";
        candidate.searchParams.set("sslmode", "disable");
      }
      if (wrong === "database") candidate.pathname = "/postgres";
      if (wrong === "password")
        candidate.password = "deliberately-incorrect-password";
      const invalid = new Client({
        connectionString: candidate.href,
        connectionTimeoutMillis: 3000,
      });
      let failed = false;
      try {
        await invalid.connect();
      } catch {
        failed = true;
      } finally {
        await invalid.end().catch(() => {});
      }
      assert.equal(failed, true, `Connection control failed: ${wrong}`);
    }
    process.stdout.write(
      JSON.stringify({ passed: true, ...result, connectionDenials: 3 }),
    );
  } finally {
    await client.end();
  }
}
module.exports = { verifyPrivileges };
if (require.main === module)
  main().catch(() => {
    console.error("Application-role probe failed; no credentials are printed");
    process.exitCode = 1;
  });
