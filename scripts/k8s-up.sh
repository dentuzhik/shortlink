#!/bin/sh
set -eu

cluster=shortlink
kubeconfig="$PWD/.kind/kubeconfig"
test -f .env || cp .env.example .env
mkdir -p .kind

kube() {
  kubectl --kubeconfig "$kubeconfig" --context "kind-$cluster" --namespace shortlink "$@"
}

docker compose --parallel 1 build redirect-service web
docker image inspect postgres:18.6 >/dev/null 2>&1 || docker pull postgres:18.6
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
  shortlink-redirect:local shortlink-web:local postgres:18.6
kind load image-archive --name "$cluster" "$image_archive"

kube apply -f deploy/k8s/namespace.yaml
kube create secret generic postgres-credentials \
  --from-env-file=deploy/k8s/.env.example --dry-run=client -o yaml | kube apply -f -
kube apply -f deploy/k8s/postgres.yaml
kube rollout status deployment/postgres --timeout=120s

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
kube apply -f deploy/k8s/apps.yaml
if [ "$existing_apps" = true ]; then
  # Local images keep their tags, so explicitly replace the old pods on reruns.
  kube rollout restart deployment/redirect-service deployment/web
fi
kube rollout status deployment/redirect-service --timeout=120s
kube rollout status deployment/web --timeout=120s
kube get pods,services,jobs
printf '\nRun pnpm k8s:forward to open the stack on ports 3100 and 3101.\n'
