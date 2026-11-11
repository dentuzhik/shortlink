#!/bin/sh
set -eu

kube() {
  kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink --namespace shortlink "$@"
}
kube get gateway/shortlink >/dev/null
mkdir -p .kind/observability

# Preserve the local login across provisioning reruns and pod restarts.
if ! kube get secret/grafana-admin >/dev/null 2>&1; then
  node --input-type=module - <<'JS'
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = '.kind/grafana-admin.env';
if (!existsSync(path)) {
  writeFileSync(path, `GF_SECURITY_ADMIN_USER=admin\nGF_SECURITY_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
}
JS
  kube create secret generic grafana-admin --from-env-file=.kind/grafana-admin.env
fi
kube create configmap prometheus-config --from-file=prometheus.yaml=deploy/monitoring/prometheus.yaml \
  --dry-run=client -o yaml | kube apply -f -
kube create configmap grafana-provisioning \
  --from-file=datasource.yaml=deploy/monitoring/grafana-datasource.yaml \
  --from-file=dashboards.yaml=deploy/monitoring/grafana-dashboards.yaml \
  --dry-run=client -o yaml | kube apply -f -
kube create configmap grafana-dashboards --from-file=shortlink.json=deploy/monitoring/shortlink.json \
  --dry-run=client -o yaml | kube apply -f -

existing=false
if kube get deployment/prometheus deployment/grafana >/dev/null 2>&1; then
  existing=true
fi
kube apply -f deploy/k8s/monitoring.yaml
if [ "$existing" = true ]; then
  kube rollout restart deployment/prometheus deployment/grafana
fi
kube rollout status deployment/prometheus --timeout=240s
kube rollout status deployment/grafana --timeout=240s
kube exec deployment/web -- node --input-type=module -e '
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    const response = await fetch("http://prometheus:9090/api/v1/targets", { signal: AbortSignal.timeout(2000) });
    const targets = (await response.json()).data.activeTargets;
    if (targets.length && targets.every(target => target.health === "up")) {
      console.log(`Healthy Fastify scrape targets: ${targets.length}`);
      process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error("Fastify scrape target is not healthy; inspect Prometheus logs and discovery configuration");
'
kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'=True \
  httproute/grafana --timeout=60s
kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}'=True \
  httproute/grafana --timeout=60s
curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-all-errors \
  --retry-delay 1 --connect-timeout 1 --max-time 3 \
  --resolve grafana.localhost:8080:127.0.0.1 http://grafana.localhost:8080/api/health
printf '\nDashboard: http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview\n'
printf 'Grafana user: admin. Retrieve the password using the command in README.md.\n'
