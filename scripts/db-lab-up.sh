#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# This command never targets the application's default profile or kind cluster.
profile=shortlink-db
cluster=shortlink-db
export DOCKER_CONTEXT=colima-shortlink-db
export KIND_EXPERIMENTAL_PROVIDER=docker
kubeconfig="$PWD/.kind/db-cluster/kubeconfig"
versions=deploy/db-lab/versions.json
mkdir -p .kind/db-cluster/vendor
chmod 700 .kind/db-cluster
kube() {
  kubectl --kubeconfig "$kubeconfig" --context "kind-$cluster" "$@"
}
for dependency in colima docker kind kubectl jq curl shasum rg; do
  command -v "$dependency" >/dev/null
done
kind version | rg --fixed-strings --quiet "kind $(jq -r .kindVersion "$versions")"

check_host_pressure() {
  if [ "$(sysctl -n kern.memorystatus_vm_pressure_level)" != 1 ]; then
    printf '%s\n' 'Host memory pressure is not normal; pause expansion and inspect capacity.' >&2
    exit 1
  fi
}
check_host_pressure

profiles=$(colima list --json)
profile_state=$(printf '%s\n' "$profiles" | jq --slurp -r --arg name "$profile" '[.[] | select(.name==$name)][0].status // "absent"')
if [ "$profile_state" = absent ]; then
  colima start "$profile" --activate=false --runtime docker --cpus 4 --memory 4 --disk 40 \
    --vm-type vz --arch aarch64 --kubernetes=false --mount none --ssh-config=false
elif [ "$profile_state" != Running ]; then
  printf '%s\n' "Database profile exists but is not running; inspect it before starting." >&2
  exit 1
fi
colima list --json | jq --slurp --exit-status --arg name "$profile" \
  '[.[] | select(.name==$name and .cpus==4 and .memory==4294967296 and .disk==42949672960 and .runtime=="docker")] | length==1' >/dev/null

clusters=$(kind get clusters)
if printf '%s\n' "$clusters" | rg -qx "$cluster"; then
  kind export kubeconfig --name "$cluster" --kubeconfig "$kubeconfig"
else
  kind create cluster --name "$cluster" --config deploy/db-lab/kind.yaml \
    --image "$(jq -r .nodeImage "$versions")" --kubeconfig "$kubeconfig" --wait 180s
fi
chmod 600 "$kubeconfig"
kube wait --for=condition=Ready nodes --all --timeout=180s
kube get nodes -o json | jq --exit-status '.items | length==4' >/dev/null
kube get nodes -o json | jq --exit-status --arg version "$(jq -r .kubernetesVersion "$versions")" \
  'all(.items[]; .status.nodeInfo.kubeletVersion==$version)' >/dev/null

upstream=.kind/db-cluster/vendor/cnpg-1.30.1.yaml
curl --fail --location --silent --show-error "$(jq -r .operatorManifestUrl "$versions")" --output "$upstream"
printf '%s  %s\n' "$(jq -r .operatorManifestSha256 "$versions")" "$upstream" | shasum --algorithm 256 --check
# Convert locally before patching: the large upstream CRDs stay out of our Git diff.
kube create --dry-run=client --validate=false -f "$upstream" -o json > .kind/db-cluster/vendor/operator-objects.json
jq --slurp --arg image "$(jq -r .operatorImage "$versions")" '
  {apiVersion:"v1",kind:"List",items:[.[] | if .kind=="List" then .items[] else . end]} |
  (.items[] | select(.kind=="Deployment" and .metadata.name=="cnpg-controller-manager") | .spec.template.spec) |= (
    .nodeSelector={"node-role.kubernetes.io/control-plane":""} |
    .tolerations=[{key:"node-role.kubernetes.io/control-plane",operator:"Exists",effect:"NoSchedule"}] |
    .containers[0].image=$image |
    .containers[0].imagePullPolicy="IfNotPresent" |
    .containers[0].resources.limits.cpu="500m" |
    .containers[0].env |= ([.[] | select(.name!="WATCH_NAMESPACE")] + [{name:"WATCH_NAMESPACE",value:"database-lab"}]) |
    (.containers[0].env[] | select(.name=="OPERATOR_IMAGE_NAME") | .value)=$image
  )' .kind/db-cluster/vendor/operator-objects.json > .kind/db-cluster/vendor/operator.json

# Pause before another controller can create workloads if host pressure rises.
check_host_pressure
# Create the watched namespace before starting its operator.
kube apply --server-side --field-manager=shortlink-db-lab -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: database-lab
  labels:
    shortlink.dev/exercise: database-ha
YAML
kube apply --server-side --field-manager=shortlink-db-lab -f .kind/db-cluster/vendor/operator.json
kube wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=90s
kube --namespace cnpg-system rollout status deployment/cnpg-controller-manager --timeout=180s
check_host_pressure
kube apply --server-side --dry-run=server -f deploy/db-lab/cluster.yaml >/dev/null
kube apply --server-side --field-manager=shortlink-db-lab -f deploy/db-lab/cluster.yaml
kube --namespace database-lab wait --for=condition=Ready cluster/shortlink-lab --timeout=360s
kube --namespace database-lab get clusters,pods,services,pvc -o wide
printf '%s\n' 'Database lab is ready. Run pnpm db:lab:check to verify replication and TLS connectivity.'
