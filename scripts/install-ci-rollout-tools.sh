#!/bin/sh
set -eu

test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
tools_dir="${RUNNER_TEMP:?GitHub runner directory required}/shortlink-rollout-tools"
mkdir -p "$tools_dir"
fetch() {
  curl --fail --location --silent --show-error --retry 2 "$1" --output "$tools_dir/$2"
  printf '%s  %s\n' "$3" "$tools_dir/$2" | sha256sum --check
}
fetch https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 kind aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
fetch https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl kubectl c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
fetch https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-linux-amd64.tar.gz k6.tar.gz 39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1
tar -xzf "$tools_dir/k6.tar.gz" --directory "$tools_dir" k6-v2.3.0-linux-amd64/k6
mv "$tools_dir/k6-v2.3.0-linux-amd64/k6" "$tools_dir/k6"
chmod +x "$tools_dir/kind" "$tools_dir/kubectl" "$tools_dir/k6"
printf '%s\n' "$tools_dir" >> "${GITHUB_PATH:?GitHub path file required}"
