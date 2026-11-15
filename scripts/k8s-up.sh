#!/bin/sh
set -eu

cluster=shortlink
kubeconfig="$PWD/.kind/kubeconfig"
test -f .env || cp .env.example .env
mkdir -p .kind

kube() {
  kubectl --kubeconfig "$kubeconfig" --context "kind-$cluster" --namespace shortlink "$@"
}

docker compose build redirect-service
docker compose build web
docker image inspect postgres:18.6 >/dev/null 2>&1 || docker pull postgres:18.6
docker image inspect redis:8.10.3-alpine >/dev/null 2>&1 || docker pull redis:8.10.3-alpine
clusters=$(kind get clusters)
if printf '%s\n' "$clusters" | grep -Fxq "$cluster"; then
  kind export kubeconfig --name "$cluster" --kubeconfig "$kubeconfig"
else
  kind create cluster --name "$cluster" --kubeconfig "$kubeconfig" --wait 120s
fi
# Docker can have just one platform locally under a multi-platform image tag.
architecture=$(kube get node "$cluster-control-plane" -o jsonpath='{.status.nodeInfo.architecture}')
image_archive=$(mktemp "${TMPDIR:-/tmp}/shortlink-images.XXXXXX")
trap 'rm -f "$image_archive"' EXIT
docker image save --platform "linux/$architecture" --output "$image_archive" \
  shortlink-redirect:local shortlink-web:local postgres:18.6 redis:8.10.3-alpine
kind load image-archive --name "$cluster" "$image_archive"

kube apply -f deploy/k8s/namespace.yaml
kube create secret generic postgres-credentials \
  --from-env-file=deploy/k8s/.env.example --dry-run=client -o yaml | kube apply -f -
kube apply -f deploy/k8s/postgres.yaml
# Retain the completed source migration configuration on ordinary local reruns.
# Prepared Secrets alone must never trigger the one-time maintenance restart.
if [ "$(kube get configmap source-maintenance-state -o jsonpath='{.data.status}' 2>/dev/null || true)" = completed ]; then
  kube patch deployment postgres --type=strategic --patch-file=deploy/migration/source-settings.patch.yaml
fi
kube rollout status deployment/postgres --timeout=120s
kube apply -f deploy/k8s/redis.yaml
kube rollout status deployment/redis --timeout=120s

kube delete job db-migrate --ignore-not-found
kube apply -f deploy/k8s/migration.yaml
if ! kube wait --for=condition=complete job/db-migrate --timeout=120s; then
  kube logs job/db-migrate || true
  exit 1
fi

existing_apps=false
if kube get deployment redirect-service web >/dev/null 2>&1; then
  existing_apps=true
fi
kube apply -f deploy/k8s/runtime-maintenance.yaml
# Create the initial control object once; never overwrite a live maintenance gate.
if ! kube get configmap shortlink-runtime >/dev/null 2>&1; then
  kube create -f deploy/k8s/runtime-control.yaml
fi
# Render enabled runtime credentials before applying a Pod template, so a local
# rerun cannot briefly reintroduce the administrator Secret into Fastify.
kube create --dry-run=client -f deploy/k8s/apps.yaml -o json \
  | node scripts/render-application-roles.mjs \
  | kube apply -f -
if [ "$existing_apps" = true ]; then
  # Local images keep their tags, so explicitly replace the old pods on reruns.
  kube rollout restart deployment/redirect-service deployment/web
fi
kube rollout status deployment/redirect-service --timeout=120s
kube rollout status deployment/web --timeout=120s
kube get pods,services,jobs
sh scripts/k8s-gateway.sh
sh scripts/monitoring-up.sh
