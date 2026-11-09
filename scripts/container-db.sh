#!/bin/sh
set -eu

# Both the migration job and Fastify get the same runtime connection settings.
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$(node --input-type=module - <<'JS'
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = required("POSTGRES_HOST");
const user = encodeURIComponent(required("POSTGRES_USER"));
const password = encodeURIComponent(required("POSTGRES_PASSWORD"));
const database = encodeURIComponent(required("POSTGRES_DB"));
process.stdout.write(`postgresql://${user}:${password}@${host}:5432/${database}`);
JS
  )
  export DATABASE_URL
fi

exec "$@"
