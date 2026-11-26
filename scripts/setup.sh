#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for tool in kubectl tilt docker uv npm; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
mkdir -p .dev
chmod 700 .dev
source_config=${WORTLAUT_SOURCE_KUBECONFIG:-"$HOME/.kube/config"}
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
if [ -d .git ]; then
  if command -v pre-commit >/dev/null 2>&1 && pre-commit --version >/dev/null 2>&1; then
    pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push >/dev/null
  elif command -v mise >/dev/null 2>&1 && mise x pre-commit@latest -- pre-commit --version >/dev/null 2>&1; then
    mise x pre-commit@latest -- pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push >/dev/null
  else
    uv tool install pre-commit >/dev/null 2>&1 || true
    uvx pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push >/dev/null
  fi
fi
printf 'wortlaut ready for make dev (context data; no workloads started by setup).\n'
