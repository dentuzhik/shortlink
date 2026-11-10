#!/bin/sh
set -efu

project="shortlink-bench-$$"
host_runner=${BENCH_HOST:-0}
redis_runner=${BENCH_REDIS:-0}
hot_key_runner=${BENCH_HOT_KEY:-0}
spike_runner=${BENCH_HOT_SPIKE:-0}
budget_runner=${BENCH_LATENCY_BUDGET:-0}
expiry_at_ms=0
spike_at_ms=0
unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

if [ "$host_runner" = 1 ] && ! command -v k6 >/dev/null 2>&1; then
  printf 'BENCH_HOST=1 requires k6 on PATH.\n' >&2
  exit 1
fi

if [ "$hot_key_runner" = 1 ] && [ "$redis_runner" != 1 ]; then
  printf 'BENCH_HOT_KEY=1 requires BENCH_REDIS=1.\n' >&2
  exit 1
fi

if [ "$spike_runner" = 1 ] && { [ "$hot_key_runner" != 1 ] || [ "$host_runner" != 1 ]; }; then
  printf 'BENCH_HOT_SPIKE=1 requires BENCH_REDIS=1 BENCH_HOT_KEY=1 BENCH_HOST=1.\n' >&2
  exit 1
fi

if [ "$budget_runner" = 1 ] && { [ "$redis_runner" != 1 ] || [ "$host_runner" != 1 ] || [ "$hot_key_runner" = 1 ]; }; then
  printf 'BENCH_LATENCY_BUDGET=1 requires BENCH_REDIS=1 BENCH_HOST=1 and a spread of codes.\n' >&2
  exit 1
fi

BENCH_REDIS_URL=
if [ "$redis_runner" = 1 ]; then
  if [ "${BENCH_FIXTURE_CONTROL:-0}" = 1 ]; then
    printf 'Run the Redis and fixture controls separately.\n' >&2
    exit 1
  fi
  BENCH_REDIS_URL=redis://redis:6379
  if [ "$budget_runner" = 1 ]; then
    BENCH_REDIS_URL=redis://redis-proxy:6379
  fi
fi
export BENCH_REDIS_URL

compose() {
  if [ "$budget_runner" = 1 ]; then
    set -- -f benchmarks/compose.budget.yaml "$@"
  fi
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

proxy_cli() {
  compose exec -T redis-proxy /toxiproxy-cli "$@"
}

if [ "$budget_runner" = 1 ]; then
  compose up -d --wait --wait-timeout 30 redis redis-proxy
  proxy_cli create -l 0.0.0.0:6379 -u redis:6379 redis
fi

set -- redirect-service
if [ "$redis_runner" = 1 ]; then
  set -- redis "$@"
fi
compose --parallel 1 up --build -d --wait --wait-timeout 60 "$@"
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
      -e BASE_URL="$benchmark_url" -e BENCH_LOOKUP="$3" \
      -e BENCH_EXPIRES_AT_MS="$expiry_at_ms" -e BENCH_SPIKE_AT_MS="$spike_at_ms" \
      "${4:-benchmarks/redirect.js}"
  else
    compose run --rm --no-deps -T -e RATE="$1" -e SECONDS="$2" \
      -e BENCH_VUS="${BENCH_VUS:-}" -e BENCH_LOOKUP="$3" \
      -e BENCH_EXPIRES_AT_MS="$expiry_at_ms" k6
  fi
}

seconds=${BENCH_SECONDS:-10}
status=0

measure() {
  printf '\n%s requests/s for %s seconds with pool max %s (%s lookup)\n' \
    "$1" "$seconds" "${BENCH_POOL_MAX:-5}" "$2"
  stage "$1" "$seconds" "$2" || status=1
}

run_lookup() {
  if [ "$host_runner" = 1 ]; then
    set_host_target
  fi
  printf '\nWarm-up: 20 requests/s for 3 seconds (%s lookup)\n' "$1"
  stage 20 3 "$1"

  for rate in ${BENCH_RATES:-50 150 300}; do
    measure "$rate" "$1"
  done
}

redis_cli() {
  compose exec -T redis redis-cli -e "$@"
}

redis_stat() {
  printf '%s\n' "$1" | awk -F: -v name="$2" '$1 == name { sub(/\r$/, "", $2); print $2 }'
}

run_latency_budget() {
  budget_seconds=${BENCH_SECONDS:-30}
  for budget_case in healthy timeout timeout healthy healthy timeout; do
    redis_cli FLUSHDB >/dev/null
    printf '\nPriming Redis through the 1,000 fixture redirects\n'
    stage 20 15 redis-prime
    test "$(redis_cli DBSIZE)" -eq 1000

    if [ "$budget_case" = timeout ]; then
      proxy_cli toxic add -t latency -a latency=75 redis
    fi
    printf '\nLatency budget (%s): 1,000 redirects/s and 10 creations/s for %s seconds.\n' \
      "$budget_case" "$budget_seconds"
    stage 1000 "$budget_seconds" "redis-$budget_case" benchmarks/latency-budget.js || status=1
    if [ "$budget_case" = timeout ]; then
      proxy_cli toxic remove -n latency_downstream redis
    fi
  done
}

measure_hot_key() {
  hot_key=shortlink:redirect:00000001
  stats_before=$(redis_cli INFO stats)
  test "$(redis_cli PEXPIRE "$hot_key" 6000)" -eq 1
  expiry_at_ms=$(redis_cli PEXPIRETIME "$hot_key")
  printf '\nHot key expires at %s (Unix milliseconds)\n' "$expiry_at_ms"
  measure "$1" redis-hot
  expiry_at_ms=0

  stats_after=$(redis_cli INFO stats)
  expirations=$(( $(redis_stat "$stats_after" expired_keys) - $(redis_stat "$stats_before" expired_keys) ))
  redis_misses=$(( $(redis_stat "$stats_after" keyspace_misses) - $(redis_stat "$stats_before" keyspace_misses) ))
  printf 'Redis expirations: %s. Redis key misses: %s.\n' "$expirations" "$redis_misses"
  test "$expirations" -eq 1 && test "$(redis_cli PTTL "$hot_key")" -gt 0
}

measure_hot_spike() {
  hot_key=shortlink:redirect:00000001
  stats_before=$(redis_cli INFO stats)
  ttl_ms=8000
  expected_expirations=1
  if [ "$1" = warm ]; then
    ttl_ms=60000
    expected_expirations=0
  fi
  test "$(redis_cli PEXPIRE "$hot_key" "$ttl_ms")" -eq 1
  deadline=$(redis_cli PEXPIRETIME "$hot_key")
  spike_at_ms=$(( deadline - ttl_ms + 8000 ))
  printf '\nHot spike (%s): 7,500 → 20,000 → 7,500 requests/s. Boundary: %s ms.\n' "$1" "$spike_at_ms"
  stage 20000 3 redis-hot || status=1
  spike_at_ms=0

  stats_after=$(redis_cli INFO stats)
  expirations=$(( $(redis_stat "$stats_after" expired_keys) - $(redis_stat "$stats_before" expired_keys) ))
  redis_misses=$(( $(redis_stat "$stats_after" keyspace_misses) - $(redis_stat "$stats_before" keyspace_misses) ))
  printf 'Redis expirations: %s. Redis key misses: %s.\n' "$expirations" "$redis_misses"
  test "$expirations" -eq "$expected_expirations"
  if [ "$1" = warm ]; then
    test "$redis_misses" -eq 0
  fi
  test "$(redis_cli PTTL "$hot_key")" -gt 0
}

if [ "$redis_runner" = 1 ]; then
  if [ "$host_runner" = 1 ]; then
    set_host_target
  fi
  if [ "$budget_runner" = 1 ]; then
    run_latency_budget
    exit "$status"
  fi
  if [ "$hot_key_runner" = 1 ]; then
    printf '\nWarm-up: 20 requests/s for 3 seconds (one hot key)\n'
    stage 20 3 redis-hot
    test "$(redis_cli DBSIZE)" -eq 1
    if [ "$spike_runner" = 1 ]; then
      for cache_case in warm expiry expiry warm; do
        measure_hot_spike "$cache_case"
      done
      exit "$status"
    fi
    for rate in ${BENCH_RATES:-50 150 300}; do
      measure_hot_key "$rate"
    done
    exit "$status"
  fi
  printf '\nWarm-up: 20 requests/s for 3 seconds (Redis lookup)\n'
  stage 20 3 redis-warm

  for rate in ${BENCH_RATES:-50 150 300}; do
    redis_cli FLUSHDB >/dev/null
    test "$(redis_cli DBSIZE)" -eq 0
    measure "$rate" redis-cold

    redis_cli FLUSHDB >/dev/null
    printf '\nPriming Redis through all 1,000 fixture redirects\n'
    stage 20 15 redis-prime
    cached_keys=$(redis_cli DBSIZE)
    if [ "$cached_keys" -ne 1000 ]; then
      printf 'Expected 1,000 cached fixture links, found %s.\n' "$cached_keys" >&2
      exit 1
    fi
    measure "$rate" redis-warm
  done
  exit "$status"
fi

run_lookup postgres
if [ "${BENCH_FIXTURE_CONTROL:-0}" = 1 ]; then
  compose exec -T redirect-service node --input-type=module < benchmarks/fixture-redirect.mjs
  compose restart redirect-service
  compose up -d --no-deps --no-recreate --wait --wait-timeout 60 redirect-service
  run_lookup fixture
fi
exit "$status"
