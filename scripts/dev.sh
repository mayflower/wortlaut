#!/bin/sh
# Starts Tilt against the project-local .dev/kubeconfig (local kind by default,
# or any configured remote cluster context via WORTLAUT_KUBE_CONTEXT).
set -eu
cd "$(dirname "$0")/.."

KUBECONFIG="$(pwd)/.dev/kubeconfig"
export KUBECONFIG
test -f "$KUBECONFIG" || { printf 'Run make setup first.\n' >&2; exit 1; }

read_dev_env() {
  key=$1
  [ -f .dev/dev.env ] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .dev/dev.env
}

KUBE_CONTEXT="${WORTLAUT_KUBE_CONTEXT:-$(read_dev_env WORTLAUT_KUBE_CONTEXT)}"
if [ -z "$KUBE_CONTEXT" ]; then
  KUBE_CONTEXT="$(kubectl --kubeconfig "$KUBECONFIG" config current-context)"
fi
export WORTLAUT_KUBE_CONTEXT="$KUBE_CONTEXT"
export WORTLAUT_NAMESPACE="${WORTLAUT_NAMESPACE:-wortlaut-$(id -un)}"
export TILT_HOST="${TILT_HOST:-127.0.0.1}"
export TILT_PORT="${TILT_PORT:-34604}"

if tilt get tiltfiles -o json --host "$TILT_HOST" --port "$TILT_PORT" > .dev/tiltfiles.json 2>/dev/null; then
  printf 'Tilt already listens on %s:%s. Inspect .dev/tiltfiles.json before reusing it.\n' "$TILT_HOST" "$TILT_PORT" >&2
  exit 1
fi

kubectl --context "$WORTLAUT_KUBE_CONTEXT" --request-timeout=10s get --raw=/version >/dev/null
kubectl --context "$WORTLAUT_KUBE_CONTEXT" create namespace "$WORTLAUT_NAMESPACE" --dry-run=client -o yaml | \
  kubectl --context "$WORTLAUT_KUBE_CONTEXT" apply -f - >/dev/null
exec tilt up --context "$WORTLAUT_KUBE_CONTEXT" --namespace "$WORTLAUT_NAMESPACE" --host "$TILT_HOST" --port "$TILT_PORT"
