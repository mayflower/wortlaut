#!/bin/sh
# Runs the full lint + PostgreSQL/S3 integration + worker test suite locally
# using disposable Docker containers — no Kubernetes cluster required.
set -eu
cd "$(dirname "$0")/.."

PG_CONTAINER="wortlaut-test-pg-$$"
S3_CONTAINER="wortlaut-test-s3-$$"

cleanup() {
  docker rm -f "$PG_CONTAINER" "$S3_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm --name "$PG_CONTAINER" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=wortlaut_test \
  --env POSTGRES_PASSWORD=fixture-postgres-password \
  --env POSTGRES_DB=wortlaut_test \
  postgres:17.9-bookworm >/dev/null

docker run --detach --rm --name "$S3_CONTAINER" \
  --publish 127.0.0.1::9000 \
  --env RUSTFS_ACCESS_KEY=fixture-s3-user \
  --env RUSTFS_SECRET_KEY=fixture-s3-password \
  --env RUSTFS_OBS_LOG_DIRECTORY= \
  rustfs/rustfs:1.0.4 /data >/dev/null

PG_PORT="$(docker port "$PG_CONTAINER" 5432/tcp | head -n 1 | awk -F: '{print $NF}')"
S3_PORT="$(docker port "$S3_CONTAINER" 9000/tcp | head -n 1 | awk -F: '{print $NF}')"

i=0
until docker exec "$PG_CONTAINER" pg_isready -U wortlaut_test -d wortlaut_test >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "PostgreSQL fixture failed to start" >&2; exit 1; }
  sleep 1
done

curl --fail --silent --retry 30 --retry-delay 1 --retry-all-errors \
  "http://127.0.0.1:${S3_PORT}/health/ready" >/dev/null

export WORTLAUT_TEST_DATABASE_URL="postgresql+psycopg://wortlaut_test:fixture-postgres-password@127.0.0.1:${PG_PORT}/wortlaut_test"
export WORTLAUT_TEST_S3_ENDPOINT="http://127.0.0.1:${S3_PORT}"
export WORTLAUT_S3_ACCESS_KEY="fixture-s3-user"
export WORTLAUT_S3_SECRET_KEY="fixture-s3-password"

make lint
make test
