#!/bin/sh
# Builds a wortlaut component image for Tilt.
# - Local kind contexts (kind-*): native local `docker build` + `kind load docker-image`.
# - Remote clusters: namespaced Kubernetes BuildKit builder pushing to EXPECTED_REF.
set -eu

image_component=$1
namespace=${WORTLAUT_NAMESPACE:?}
kube_context=${WORTLAUT_KUBE_CONTEXT:-$(kubectl config current-context)}
expected_ref=${EXPECTED_REF:?}

case "$image_component" in
  asr-cpu) dockerfile="services/asr/Dockerfile.cpu" ;;
  *) dockerfile="services/$image_component/Dockerfile" ;;
esac

test "$(kubectl config current-context)" = "$kube_context"

case "$kube_context" in
  kind-*)
    kind_cluster="${kube_context#kind-}"
    docker build --file "$dockerfile" --tag "$expected_ref" .
    exec kind load docker-image "$expected_ref" --name "$kind_cluster"
    ;;
  *)
    platform="${WORTLAUT_BUILD_PLATFORM:-linux/amd64}"
    arch="${platform#linux/}"
    builder="${namespace}-builder"
    if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
      docker buildx create --name "$builder" --driver kubernetes \
        --driver-opt "namespace=$namespace,nodeselector=kubernetes.io/arch=$arch,requests.cpu=1,requests.memory=2Gi,limits.cpu=4,limits.memory=4Gi" \
        --platform "$platform" >/dev/null
    fi
    exec docker buildx build --builder "$builder" --platform "$platform" \
      --provenance=false --file "$dockerfile" \
      --tag "$expected_ref" --push .
    ;;
esac
