#!/bin/sh
# Prepares local dependencies, git QA hooks, and an isolated project-local
# .dev/kubeconfig without ever modifying ~/.kube/config.
#
# Default target: local kind cluster ("kind-wortlaut-dev").
# Remote cluster opt-in:
#   WORTLAUT_KUBE_CONTEXT=<context> WORTLAUT_SOURCE_KUBECONFIG=~/.kube/config make setup
set -eu
cd "$(dirname "$0")/.."

mkdir -p .dev
chmod 700 .dev

read_dev_env() {
  key=$1
  [ -f .dev/dev.env ] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .dev/dev.env
}

TARGET_CONTEXT="${WORTLAUT_KUBE_CONTEXT:-$(read_dev_env WORTLAUT_KUBE_CONTEXT)}"
TARGET_CONTEXT="${TARGET_CONTEXT:-kind-wortlaut-dev}"

for tool in kubectl helm tilt docker uv npm; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s (hint: run mise install)\n' "$tool" >&2; exit 1; }
done

CURRENT_CTX=""
if [ -f .dev/kubeconfig ]; then
  CURRENT_CTX="$(kubectl --kubeconfig .dev/kubeconfig config current-context 2>/dev/null || true)"
fi

case "$TARGET_CONTEXT" in
  kind-*)
    command -v kind >/dev/null || { printf 'Missing tool: kind (hint: run mise install)\n' >&2; exit 1; }
    KIND_CLUSTER="${TARGET_CONTEXT#kind-}"
    if ! kind get clusters 2>/dev/null | grep -Fxq "$KIND_CLUSTER"; then
      kind create cluster --name "$KIND_CLUSTER" --kubeconfig .dev/kubeconfig
      chmod 600 .dev/kubeconfig
    elif [ "$CURRENT_CTX" != "$TARGET_CONTEXT" ]; then
      kind get kubeconfig --name "$KIND_CLUSTER" > .dev/kubeconfig.tmp
      chmod 600 .dev/kubeconfig.tmp
      mv .dev/kubeconfig.tmp .dev/kubeconfig
    fi
    ;;
  *)
    SOURCE_CONFIG="${WORTLAUT_SOURCE_KUBECONFIG:-$HOME/.kube/config}"
    if [ "$CURRENT_CTX" != "$TARGET_CONTEXT" ]; then
      if [ ! -f "$SOURCE_CONFIG" ]; then
        printf 'Set WORTLAUT_SOURCE_KUBECONFIG to a kubeconfig containing context %s.\n' "$TARGET_CONTEXT" >&2
        exit 1
      fi
      # Flatten only the target context into a project-local file without touching source config.
      kubectl --kubeconfig "$SOURCE_CONFIG" --context "$TARGET_CONTEXT" config view --minify --flatten --raw > .dev/kubeconfig.tmp
      chmod 600 .dev/kubeconfig.tmp
      mv .dev/kubeconfig.tmp .dev/kubeconfig
      kubectl --kubeconfig .dev/kubeconfig config use-context "$TARGET_CONTEXT" >/dev/null
    fi
    ;;
esac

test "$(kubectl --kubeconfig .dev/kubeconfig config current-context)" = "$TARGET_CONTEXT"

if [ ! -f .dev/dev.env ]; then
  printf 'WORTLAUT_KUBE_CONTEXT=%s\n' "$TARGET_CONTEXT" > .dev/dev.env
  chmod 600 .dev/dev.env
elif ! grep -q '^WORTLAUT_KUBE_CONTEXT=' .dev/dev.env; then
  printf 'WORTLAUT_KUBE_CONTEXT=%s\n' "$TARGET_CONTEXT" >> .dev/dev.env
  chmod 600 .dev/dev.env
elif [ "$(read_dev_env WORTLAUT_KUBE_CONTEXT)" != "$TARGET_CONTEXT" ]; then
  awk -F= -v ctx="$TARGET_CONTEXT" '$1 == "WORTLAUT_KUBE_CONTEXT" { print "WORTLAUT_KUBE_CONTEXT=" ctx; next } { print }' .dev/dev.env > .dev/dev.env.tmp
  chmod 600 .dev/dev.env.tmp
  mv .dev/dev.env.tmp .dev/dev.env
fi

uv sync --project services/meeting
npm --prefix worker ci
npm --prefix worker run build
./scripts/install-hooks.sh >/dev/null

printf 'wortlaut ready for make dev (context %s; no workloads started by setup).\n' "$TARGET_CONTEXT"
