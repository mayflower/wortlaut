#!/bin/sh
# Runs an isolated end-to-end verification in a local kind cluster ("wortlaut-e2e")
# using charts/wortlaut (bundled PostgreSQL + RustFS + configurable ASR backend).
#
# Usage:
#   ./scripts/e2e-kind.sh                                   # In-cluster Parakeet CPU smoke
#   PROVIDER=google_meet ./scripts/e2e-kind.sh              # + real live Google Meet E2E
#   PROVIDER=google_meet,teams,webex,zoom ./scripts/e2e-kind.sh
#   KEEP_CLUSTER=false ./scripts/e2e-kind.sh                # Tear down kind cluster afterwards
set -eu
cd "$(dirname "$0")/.."

CLUSTER_NAME="${WORTLAUT_E2E_CLUSTER:-wortlaut-e2e}"
NAMESPACE="${WORTLAUT_E2E_NAMESPACE:-wortlaut}"
KC=".dev/kind-e2e-kubeconfig"
PORT="${WORTLAUT_E2E_PORT:-34612}"
ASR_BACKEND="${WORTLAUT_ASR_BACKEND:-parakeet}"
ASR_DEVICE="${WORTLAUT_ASR_DEVICE:-cpu}"
KEEP_CLUSTER="${KEEP_CLUSTER:-true}"
PROVIDERS="${PROVIDER:-}"
PF_PID=""

cleanup() {
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP_CLUSTER" = "false" ]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
    rm -f "$KC"
  fi
}
trap cleanup EXIT INT TERM

for tool in kind kubectl helm docker; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s (hint: run mise install)\n' "$tool" >&2; exit 1; }
done

mkdir -p .dev
chmod 700 .dev

if ! kind get clusters 2>/dev/null | grep -Fxq "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KC"
  chmod 600 "$KC"
elif [ ! -f "$KC" ]; then
  kind get kubeconfig --name "$CLUSTER_NAME" > "${KC}.tmp"
  chmod 600 "${KC}.tmp"
  mv "${KC}.tmp" "$KC"
fi

if [ "$ASR_BACKEND" = "parakeet" ] && [ "$ASR_DEVICE" = "cpu" ]; then
  ASR_DOCKERFILE="services/asr/Dockerfile.cpu"
  ASR_TAG="wortlaut-asr-cpu:e2e"
  ASR_SET="images.asrCpu=${ASR_TAG}"
else
  ASR_DOCKERFILE="services/asr/Dockerfile"
  ASR_TAG="wortlaut-asr:e2e"
  ASR_SET="images.asr=${ASR_TAG}"
fi

docker build --file services/meeting/Dockerfile --tag wortlaut-meeting:e2e .
docker build --file services/worker/Dockerfile --tag wortlaut-worker:e2e .
docker build --file "$ASR_DOCKERFILE" --tag "$ASR_TAG" .

kind load docker-image wortlaut-meeting:e2e wortlaut-worker:e2e "$ASR_TAG" --name "$CLUSTER_NAME"

helm --kubeconfig "$KC" upgrade --install wortlaut ./charts/wortlaut \
  --namespace "$NAMESPACE" --create-namespace \
  --set host=wortlaut.local \
  --set bundled.enabled=true \
  --set ingress.enabled=false \
  --set images.meeting=wortlaut-meeting:e2e \
  --set images.worker=wortlaut-worker:e2e \
  --set "$ASR_SET" \
  --set images.pullPolicy=Never \
  --set "asr.backend=${ASR_BACKEND}" \
  --set "asr.device=${ASR_DEVICE}"

for pair in "wortlaut-meet:.dev/meet.env" "wortlaut-teams:.dev/teams.env" "wortlaut-zoom:.dev/zoom.env" "wortlaut-webex:.dev/webex.env"; do
  name="${pair%%:*}"
  file="${pair#*:}"
  if [ -f "$file" ]; then
    kubectl --kubeconfig "$KC" -n "$NAMESPACE" create secret generic "$name" \
      --from-env-file="$file" --dry-run=client -o yaml | kubectl --kubeconfig "$KC" apply -f - >/dev/null
  fi
done

if [ -f .dev/meet.env ] && [ -f .dev/meet-storage-state.json ]; then
  meet_secret="$(awk -F= '$1 == "WORTLAUT_MEET_STORAGE_STATE_SECRET" { sub(/^[^=]*=/, ""); gsub(/["'\'']/, ""); print; exit }' .dev/meet.env)"
  if [ -n "$meet_secret" ]; then
    kubectl --kubeconfig "$KC" -n "$NAMESPACE" create secret generic "$meet_secret" \
      --from-file=storage-state.json=.dev/meet-storage-state.json --dry-run=client -o yaml | \
      kubectl --kubeconfig "$KC" apply -f - >/dev/null
  fi
fi

kubectl --kubeconfig "$KC" -n "$NAMESPACE" rollout status statefulset/wortlaut-postgres --timeout=180s
kubectl --kubeconfig "$KC" -n "$NAMESPACE" rollout status statefulset/wortlaut-rustfs --timeout=180s
kubectl --kubeconfig "$KC" -n "$NAMESPACE" rollout status deployment/wortlaut-asr --timeout=360s
kubectl --kubeconfig "$KC" -n "$NAMESPACE" rollout status deployment/wortlaut-meeting --timeout=180s

MEETING_POD="$(kubectl --kubeconfig "$KC" -n "$NAMESPACE" get pod -l app=wortlaut-meeting -o jsonpath='{.items[0].metadata.name}')"
kubectl --kubeconfig "$KC" -n "$NAMESPACE" cp worker/test/fixtures/german-a.wav "${MEETING_POD}:/tmp/e2e-german-a.wav"
kubectl --kubeconfig "$KC" -n "$NAMESPACE" exec -i deploy/wortlaut-meeting -- python3 - <<'PY'
import json, os, time, urllib.request, wave
import numpy as np

asr_url = os.environ["WORTLAUT_ASR_URL"]
asr_tok = os.environ["WORTLAUT_ASR_TOKEN"]
ready = json.loads(urllib.request.urlopen(asr_url + "/health/ready", timeout=15).read())
with wave.open("/tmp/e2e-german-a.wav", "rb") as wf:
    sr, ch = wf.getframerate(), wf.getnchannels()
    raw = wf.readframes(wf.getnframes())
arr = np.frombuffer(raw, dtype="<i2")
if ch > 1:
    arr = arr.reshape(-1, ch).mean(axis=1).astype("<i2")
if sr != 16000:
    arr = np.interp(
        np.linspace(0, 1, int(len(arr) * 16000 / sr), endpoint=False),
        np.linspace(0, 1, len(arr), endpoint=False),
        arr,
    ).astype("<i2")
t0 = time.monotonic()
req = urllib.request.Request(
    asr_url + "/v1/transcribe",
    data=arr.tobytes(),
    headers={
        "Authorization": "Bearer " + asr_tok,
        "X-Job-ID": "a" * 64,
        "Content-Type": "application/octet-stream",
    },
    method="POST",
)
body = json.loads(urllib.request.urlopen(req, timeout=240).read())
dt = time.monotonic() - t0
dur = len(arr) / 16000.0
assert "prüfen" in body["text"], f"Unexpected transcript: {body}"
print(
    f"In-cluster ASR OK: backend={ready.get('backend')} device={ready.get('device')} "
    f"quant={ready.get('quantization')} infer={dt:.2f}s RTF={dt/dur:.3f} text={body['text']!r}"
)
PY

kubectl --kubeconfig "$KC" -n "$NAMESPACE" port-forward svc/wortlaut-meeting "${PORT}:8000" >/dev/null 2>&1 &
PF_PID=$!
sleep 2
kill -0 "$PF_PID" 2>/dev/null || { printf 'Port-forward on 127.0.0.1:%s failed (port busy?)\n' "$PORT" >&2; exit 1; }

curl --fail --silent --retry 15 --retry-delay 1 "http://127.0.0.1:${PORT}/health/ready" >/dev/null
printf 'In-cluster meeting & ASR ready (%s/%s) on http://127.0.0.1:%s\n' "$ASR_BACKEND" "$ASR_DEVICE" "$PORT"

if [ -n "$PROVIDERS" ]; then
  API_TOKEN="$(kubectl --kubeconfig "$KC" -n "$NAMESPACE" get secret wortlaut-runtime -o jsonpath='{.data.WORTLAUT_API_TOKEN}' | base64 -d)"
  OLD_IFS=$IFS
  IFS=','
  for prov in $PROVIDERS; do
    IFS=$OLD_IFS
    printf '>>> Running live E2E (%s/%s): %s <<<\n' "$ASR_BACKEND" "$ASR_DEVICE" "$prov"
    docker run --rm --init --network host --ipc=host --security-opt seccomp=unconfined \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp \
      -e "WORTLAUT_LIVE_API_URL=http://127.0.0.1:${PORT}" \
      -e "WORTLAUT_LIVE_API_TOKEN=${API_TOKEN}" \
      -e "PROVIDER=${prov}" \
      -v "$(pwd):/repo" \
      -w /repo/worker \
      mcr.microsoft.com/playwright:v1.65.1-noble \
      node --import tsx test/live-provider-e2e.ts
  done
  IFS=$OLD_IFS
fi
