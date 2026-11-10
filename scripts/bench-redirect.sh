#!/bin/sh
set -efu

project="shortlink-bench-$$"
unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

compose() {
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

stage() {
  compose run --rm --no-deps -T -e RATE="$1" -e SECONDS="$2" k6
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
