#!/bin/sh
set -eu

mkdir -p .kind/observability
curl --fail --silent --show-error --noproxy '*' --connect-timeout 1 --max-time 3 \
  --resolve go.localhost:8080:127.0.0.1 http://go.localhost:8080/readyz >/dev/null
printf 'Running a 225-second chart demo. Dashboard: http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview\n'
node --input-type=module - <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync('.kind/observability/last-run.json', JSON.stringify({ startedAt: Date.now() }, null, 2));
JS
if command -v k6 >/dev/null 2>&1; then
  K6_NO_USAGE_REPORT=true k6 run --no-color --quiet \
    --summary-export .kind/observability/last-summary.json \
    -e BASE_URL=http://127.0.0.1:8080 benchmarks/observability.js
else
  # Portable fallback; the native runner avoids sharing the VM's CPU with k6.
  docker run --rm --network kind --user "$(id -u):$(id -g)" \
    -e K6_NO_USAGE_REPORT=true \
    -v "$PWD/benchmarks:/benchmarks:ro" -v "$PWD/.kind/observability:/results" \
    grafana/k6:2.3.0 run --no-color --quiet --summary-export /results/last-summary.json \
    -e BASE_URL=http://shortlink-edge-bridge-1:8080 /benchmarks/observability.js
fi
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = '.kind/observability/last-run.json';
const run = JSON.parse(readFileSync(path, 'utf8'));
run.finishedAt = Date.now();
run.dashboardUrl = `http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview?from=${run.startedAt - 15000}&to=${run.finishedAt + 15000}`;
writeFileSync(path, JSON.stringify(run, null, 2));
console.log(`Recorded run: ${run.dashboardUrl}`);
JS
