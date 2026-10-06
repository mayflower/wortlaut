#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export KUBECONFIG="$(pwd)/.dev/kubeconfig"
export WORTLAUT_NAMESPACE=${WORTLAUT_NAMESPACE:-wortlaut-$(id -un)}
export TILT_HOST=${TILT_HOST:-127.0.0.1}
export TILT_PORT=${TILT_PORT:-34604}
test -f "$KUBECONFIG" || { printf 'Run make setup first.\n' >&2; exit 1; }
if tilt get tiltfiles -o json --host "$TILT_HOST" --port "$TILT_PORT" > .dev/tiltfiles.json 2>/dev/null; then
  printf 'Tilt already listens on %s:%s. Inspect .dev/tiltfiles.json before reusing it.\n' "$TILT_HOST" "$TILT_PORT" >&2
  exit 1
fi
kubectl --context data --request-timeout=10s get --raw=/version >/dev/null
kubectl --context data create namespace "$WORTLAUT_NAMESPACE" --dry-run=client -o yaml | kubectl --context data apply -f - >/dev/null
exec tilt up --context data --namespace "$WORTLAUT_NAMESPACE" --host "$TILT_HOST" --port "$TILT_PORT"
