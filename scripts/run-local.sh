#!/bin/sh
# Startet wortlaut im lokalen Prozess-Modus (WORTLAUT_CONTROLLER_BACKEND=local)
# ohne Kubernetes-Cluster; Worker-Prozesse laufen als isolierte Node.js-Subprozesse.
set -eu

export WORTLAUT_CONTROLLER_BACKEND="${WORTLAUT_CONTROLLER_BACKEND:-local}"
export WORTLAUT_ENABLE_CONTROLLER="${WORTLAUT_ENABLE_CONTROLLER:-true}"
export WORTLAUT_LOCAL_WORKER_DIR="${WORTLAUT_LOCAL_WORKER_DIR:-$(pwd)/worker}"
export WORTLAUT_SDK_DIRECTORY="${WORTLAUT_SDK_DIRECTORY:-$(pwd)/worker/dist}"
export WORTLAUT_SITE_DIRECTORY="${WORTLAUT_SITE_DIRECTORY:-$(pwd)/site}"
export WORTLAUT_API_URL="${WORTLAUT_API_URL:-http://127.0.0.1:34601/}"
export WORTLAUT_SDK_PAGE_URL="${WORTLAUT_SDK_PAGE_URL:-http://127.0.0.1:34601/sdk/}"
export WORTLAUT_ENABLE_GOOGLE_MEET="${WORTLAUT_ENABLE_GOOGLE_MEET:-true}"
export WORTLAUT_ENABLE_TEAMS="${WORTLAUT_ENABLE_TEAMS:-true}"
export WORTLAUT_ENABLE_ZOOM="${WORTLAUT_ENABLE_ZOOM:-true}"

npm --prefix worker run build
uv run --directory services/meeting alembic upgrade head
exec uv run --directory services/meeting uvicorn wortlaut.app:app --host 127.0.0.1 --port "${WORTLAUT_PORT:-34601}"
