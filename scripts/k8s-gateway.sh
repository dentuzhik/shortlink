#!/bin/sh
set -eu

kube() {
  kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink --namespace shortlink "$@"
}

# Gateway API types are CRDs, installed separately from their Traefik controller.
crds=.kind/gateway-api-v1.6.3.yaml
mkdir -p .kind
if [ ! -f "$crds" ]; then
  curl --fail --location --silent --show-error --retry 2 \
    https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml \
    --output "$crds.tmp"
  mv "$crds.tmp" "$crds"
fi
kube apply --server-side --field-manager=shortlink-gateway -f "$crds"
kube wait --for=condition=Established --timeout=60s \
  crd/gatewayclasses.gateway.networking.k8s.io \
  crd/gateways.gateway.networking.k8s.io \
  crd/httproutes.gateway.networking.k8s.io
kube apply -f deploy/k8s/gateway-controller.yaml
kube apply -f deploy/k8s/gateway.yaml
kube rollout status deployment/gateway-controller --timeout=180s
kube wait --for=condition=Accepted gatewayclass/shortlink --timeout=60s
kube wait --for=condition=Programmed gateway/shortlink --timeout=60s
for route in web redirects; do
  kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'=True \
    "httproute/$route" --timeout=60s
  kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}'=True \
    "httproute/$route" --timeout=60s
done

# Recreating this stateless bridge refreshes the kind node's Docker DNS address.
docker compose -f deploy/kind/compose.yaml up -d --force-recreate
curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-all-errors \
  --retry-delay 1 --connect-timeout 1 --max-time 3 \
  --resolve app.localhost:8080:127.0.0.1 http://app.localhost:8080/ >/dev/null
curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-all-errors \
  --retry-delay 1 --connect-timeout 1 --max-time 3 \
  --resolve go.localhost:8080:127.0.0.1 http://go.localhost:8080/readyz >/dev/null
printf '\nUI: http://app.localhost:8080\nShort links: http://go.localhost:8080/<code>\n'
