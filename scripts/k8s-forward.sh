#!/bin/sh
set -eu

kube() {
  exec kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink --namespace shortlink "$@"
}

kube port-forward --address 127.0.0.1 service/redirect-service 3100:3000 &
api_pid=$!
kube port-forward --address 127.0.0.1 service/web 3101:3001 &
web_pid=$!

trap 'kill "$api_pid" "$web_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done
exit 1
