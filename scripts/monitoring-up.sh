#!/bin/sh
set -eu

kube() {
  kubectl --kubeconfig .kind/kubeconfig --context kind-shortlink --namespace shortlink "$@"
}
kube get gateway/shortlink >/dev/null
mkdir -p .kind/observability
mkdir -p .kind/resource-monitoring

# kind's kubelet has its own serving CA. This public bundle includes that CA;
# its DNS SAN is shortlink-control-plane even when discovery connects by IP.
docker exec shortlink-control-plane cat /var/lib/kubelet/pki/kubelet.crt \
  > .kind/resource-monitoring/kubelet-serving.crt
kube create configmap kubelet-metrics-ca \
  --from-file=ca.crt=.kind/resource-monitoring/kubelet-serving.crt \
  --dry-run=client -o yaml | kube apply -f -
kube apply -f deploy/k8s/resource-metrics.yaml
kube rollout status deployment/vm-metrics --timeout=180s
kube rollout status deployment/cluster-state-metrics --timeout=180s

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
kube create configmap grafana-dashboards \
  --from-file=shortlink.json=deploy/monitoring/shortlink.json \
  --from-file=resources.json=deploy/monitoring/resources.json \
  --dry-run=client -o yaml | kube apply -f -

existing=false
if kube get deployment/prometheus deployment/grafana >/dev/null 2>&1; then
  existing=true
  prometheus_template=$(kube get deployment/prometheus -o jsonpath='{.spec.template}')
  grafana_template=$(kube get deployment/grafana -o jsonpath='{.spec.template}')
fi
kube apply -f deploy/k8s/monitoring.yaml
if [ "$existing" = true ]; then
  # A template change already starts replacement pods. Restart only unchanged
  # templates to reload mounted configuration, avoiding a second replacement.
  if [ "$prometheus_template" = "$(kube get deployment/prometheus -o jsonpath='{.spec.template}')" ]; then
    kube rollout restart deployment/prometheus
  fi
  if [ "$grafana_template" = "$(kube get deployment/grafana -o jsonpath='{.spec.template}')" ]; then
    kube rollout restart deployment/grafana
  fi
fi
kube rollout status deployment/prometheus --timeout=240s
kube rollout status deployment/grafana --timeout=240s
kube exec deployment/web -- node --input-type=module -e '
const jobs = ["redirect-service", "colima-vm", "cluster-state", "kubelet"];
let lastTargets = [];
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch("http://prometheus:9090/api/v1/targets", { signal: AbortSignal.timeout(2000) });
    const targets = (await response.json()).data.activeTargets;
    lastTargets = targets.map(target => ({ job: target.labels.job, health: target.health, error: target.lastError }));
    if (jobs.every(job => targets.some(target => target.labels.job === job)) && targets.every(target => target.health === "up")) {
      console.log(`Healthy Prometheus targets: ${targets.length} across ${jobs.length} jobs`);
      process.exit(0);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error(`Metrics targets are not healthy: ${JSON.stringify(lastTargets)}`);
'
kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'=True \
  httproute/grafana --timeout=60s
kube wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}'=True \
  httproute/grafana --timeout=60s
curl --fail --silent --show-error --noproxy '*' --retry 10 --retry-all-errors \
  --retry-delay 1 --connect-timeout 1 --max-time 3 \
  --resolve grafana.localhost:8080:127.0.0.1 http://grafana.localhost:8080/api/health
printf '\nDashboard: http://grafana.localhost:8080/d/shortlink-overview/shortlink-overview\n'
printf 'Resources: http://grafana.localhost:8080/d/shortlink-resources/shortlink-resources\n'
printf 'Grafana user: admin. Retrieve the password using the command in README.md.\n'
