#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for tool in kubectl tilt docker uv npm; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
mkdir -p .dev
chmod 700 .dev
source_config=${WORTLAUT_SOURCE_KUBECONFIG:-"$HOME/.kube/data-lan-mayflower"}
if [ ! -f .dev/kubeconfig ]; then
  if [ ! -f "$source_config" ]; then
    printf 'Set WORTLAUT_SOURCE_KUBECONFIG to a kubeconfig containing data.\n' >&2
    exit 1
  fi
  # Flatten into a local file without printing credentials or changing the source.
  kubectl --kubeconfig "$source_config" --context data config view --minify --flatten --raw > .dev/kubeconfig.tmp
  chmod 600 .dev/kubeconfig.tmp
  mv .dev/kubeconfig.tmp .dev/kubeconfig
  kubectl --kubeconfig .dev/kubeconfig config use-context data >/dev/null
fi
test "$(kubectl --kubeconfig .dev/kubeconfig config current-context)" = data
uv sync --project services/meeting
npm --prefix worker ci
npm --prefix worker run build
printf 'wortlaut ready for make dev (context data; no workloads started by setup).\n'
