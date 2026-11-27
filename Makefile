SHELL := /bin/sh
.DEFAULT_GOAL := help
WORTLAUT_NAMESPACE ?= wortlaut-$(shell id -un)
KUBECONFIG := $(CURDIR)/.dev/kubeconfig
export KUBECONFIG WORTLAUT_NAMESPACE

.PHONY: help setup setup-local hooks qa format lint dev render test test-local test-e2e-kind test-live test-live-video test-live-sfu4 test-canary test-live-login

help: ## Show available development & QA targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Prepare local kind cluster (or WORTLAUT_KUBE_CONTEXT), deps & hooks
	./scripts/setup.sh

setup-local: ## Install Python/Node deps, build bundles & install hooks (no K8s)
	uv sync --project services/meeting
	npm --prefix worker ci
	npm --prefix worker run build
	@$(MAKE) --no-print-directory hooks

hooks: ## Install pre-commit, commit-msg & pre-push git QA hooks
	./scripts/install-hooks.sh

qa: ## Run all pre-commit & pre-push QA checks (secrets, lint, Helm, Trivy)
	@if command -v pre-commit >/dev/null 2>&1 && pre-commit --version >/dev/null 2>&1; then \
		pre-commit run --all-files && pre-commit run --hook-stage pre-push --all-files; \
	elif command -v mise >/dev/null 2>&1 && mise x pre-commit@latest -- pre-commit --version >/dev/null 2>&1; then \
		mise x pre-commit@latest -- pre-commit run --all-files && mise x pre-commit@latest -- pre-commit run --hook-stage pre-push --all-files; \
	else \
		uvx pre-commit run --all-files && uvx pre-commit run --hook-stage pre-push --all-files; \
	fi

format: ## Auto-format Python code (meeting & asr)
	uv run --directory services/meeting ruff format src tests ../../services/asr
	uv run --directory services/meeting ruff check --fix src tests ../../services/asr

dev: ## Start Tilt development loop against .dev/kubeconfig (default: local kind)
	./scripts/dev.sh

render: ## Render Helm chart manifests for the current namespace
	helm template wortlaut charts/wortlaut --namespace "$(WORTLAUT_NAMESPACE)"

test: ## Run Python pytest and worker unit tests (requires Postgres + S3 env)
	uv run --directory services/meeting pytest
	npm --prefix worker test

test-local: ## Run linters + full Postgres/S3/worker suite in disposable containers
	./scripts/test-local.sh

test-e2e-kind: ## Run isolated kind E2E (set PROVIDER=google_meet,teams,webex,zoom for live calls)
	./scripts/e2e-kind.sh

test-live: ## Run live conference provider E2E (PROVIDER=google_meet|teams|webex|zoom)
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live

test-live-video: ## Run live provider E2E (video tile check only)
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --video-only

test-live-sfu4: ## Run live provider E2E with 4 concurrent speakers
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --four-speakers

test-canary: ## Run canary live provider check
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --canary

test-live-login: ## Save interactive host session cookies for live E2E
	npm --prefix worker run test:live -- --save-host-session "$${PROVIDER:-google_meet}"

lint: ## Run Ruff, Basedpyright, Vulture, tsc, Biome & Knip
	uv run --directory services/meeting ruff check src tests ../../services/asr
	uv run --directory services/meeting ruff format --check src tests ../../services/asr
	uv run --directory services/meeting basedpyright
	uv run --directory services/meeting vulture
	npm --prefix worker run typecheck
	npm --prefix worker run lint
	npm --prefix worker run knip
