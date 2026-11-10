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

if [ "$host_runner" = 1 ]; then
  address=$(compose port redirect-service 3000)
  case "$address" in
    127.0.0.1:[1-9]*) ;;
    *) printf 'Expected a published loopback port, got %s.\n' "$address" >&2; exit 1 ;;
  esac
  benchmark_url="http://$address"
  curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-connrefused \
    --retry-delay 1 --connect-timeout 1 --max-time 2 "$benchmark_url/readyz" >/dev/null
  printf '\nHost k6 target: %s\n' "$benchmark_url"
fi

stage() {
  if [ "$host_runner" = 1 ]; then
    K6_NO_USAGE_REPORT=true k6 run --quiet --no-color \
      -e RATE="$1" -e SECONDS="$2" -e BENCH_VUS="${BENCH_VUS:-}" \
      -e BASE_URL="$benchmark_url" benchmarks/redirect.js
  else
    compose run --rm --no-deps -T -e RATE="$1" -e SECONDS="$2" \
      -e BENCH_VUS="${BENCH_VUS:-}" k6
  fi
}

printf '\nWarm-up: 20 requests/s for 3 seconds (not part of the baseline)\n'
stage 20 3

seconds=${BENCH_SECONDS:-10}
status=0
for rate in ${BENCH_RATES:-50 150 300}; do
  printf '\n%s requests/s for %s seconds with pool max %s\n' \
    "$rate" "$seconds" "${BENCH_POOL_MAX:-5}"
  stage "$rate" "$seconds" || status=1
done
exit "$status"
