#!/bin/sh
set -eu

if [ -z "${DOCKER_HOST:-}" ] && command -v docker >/dev/null 2>&1; then
  docker_context=$(docker context show)
  case "$docker_context" in
    colima|colima-*)
      # Testcontainers runs on the host; its cleanup container runs in Colima.
      DOCKER_HOST=$(docker context inspect "$docker_context" --format '{{.Endpoints.docker.Host}}')
      TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=${TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE:-/var/run/docker.sock}
      export DOCKER_HOST TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE
      ;;
  esac
fi

exec pnpm --filter @url-shortener/redirect-service test:integration "$@"
