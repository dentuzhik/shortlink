#!/bin/sh
set -efu

project="shortlink-bench-$$"
host_runner=${BENCH_HOST:-0}
unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

if [ "$host_runner" = 1 ] && ! command -v k6 >/dev/null 2>&1; then
  printf 'BENCH_HOST=1 requires k6 on PATH.\n' >&2
  exit 1
fi

compose() {
  if [ "$host_runner" = 1 ]; then
    set -- -f benchmarks/compose.host.yaml "$@"
  fi
  docker compose --project-name "$project" --env-file benchmarks/.env.example \
    -f compose.yaml -f benchmarks/compose.yaml "$@"
}

cleanup() {
  compose down --volumes
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose --parallel 1 up --build -d --wait --wait-timeout 60 redirect-service
compose exec -T postgres sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < benchmarks/seed.sql

set_host_target() {
  address=$(compose port redirect-service 3000)
  case "$address" in
    127.0.0.1:[1-9]*) ;;
    *) printf 'Expected a published loopback port, got %s.\n' "$address" >&2; exit 1 ;;
  esac
  benchmark_url="http://$address"
  curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-connrefused \
    --retry-delay 1 --connect-timeout 1 --max-time 2 "$benchmark_url/readyz" >/dev/null
  printf '\nHost k6 target: %s\n' "$benchmark_url"
}

stage() {
  if [ "$host_runner" = 1 ]; then
    K6_NO_USAGE_REPORT=true k6 run --quiet --no-color \
      -e RATE="$1" -e SECONDS="$2" -e BENCH_VUS="${BENCH_VUS:-}" \
      -e BASE_URL="$benchmark_url" -e BENCH_LOOKUP="$3" benchmarks/redirect.js
  else
    compose run --rm --no-deps -T -e RATE="$1" -e SECONDS="$2" \
      -e BENCH_VUS="${BENCH_VUS:-}" -e BENCH_LOOKUP="$3" k6
  fi
}

seconds=${BENCH_SECONDS:-10}
status=0

run_lookup() {
  if [ "$host_runner" = 1 ]; then
    set_host_target
  fi
  printf '\nWarm-up: 20 requests/s for 3 seconds (%s lookup)\n' "$1"
  stage 20 3 "$1"

  for rate in ${BENCH_RATES:-50 150 300}; do
    printf '\n%s requests/s for %s seconds with pool max %s (%s lookup)\n' \
      "$rate" "$seconds" "${BENCH_POOL_MAX:-5}" "$1"
    stage "$rate" "$seconds" "$1" || status=1
  done
}

run_lookup postgres
if [ "${BENCH_FIXTURE_CONTROL:-0}" = 1 ]; then
  compose exec -T redirect-service node --input-type=module < benchmarks/fixture-redirect.mjs
  compose restart redirect-service
  compose up -d --no-deps --no-recreate --wait --wait-timeout 60 redirect-service
  run_lookup fixture
fi
exit "$status"
