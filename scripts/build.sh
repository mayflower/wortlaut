#!/bin/sh
set -eu
image_component=$1
namespace=${WORTLAUT_NAMESPACE:?}
builder="${namespace}-builder"
test "$(kubectl config current-context)" = data
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver kubernetes \
    --driver-opt "namespace=$namespace,nodeselector=kubernetes.io/arch=amd64,requests.cpu=1,requests.memory=2Gi,limits.cpu=4,limits.memory=4Gi" \
    --platform linux/amd64 >/dev/null
fi
exec docker buildx build --builder "$builder" --platform linux/amd64 \
  --provenance=false --file "services/$image_component/Dockerfile" \
  --tag "${EXPECTED_REF:?}" --push .
