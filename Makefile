SHELL := /bin/sh
WORTLAUT_NAMESPACE ?= wortlaut-$(shell id -un)
KUBECONFIG := $(CURDIR)/.dev/kubeconfig
export KUBECONFIG WORTLAUT_NAMESPACE

.PHONY: setup setup-local hooks qa dev render test test-local test-live test-live-video test-live-sfu4 test-canary test-live-login lint
setup:
	./scripts/setup.sh

setup-local:
	uv sync --project services/meeting
	npm --prefix worker ci
	npm --prefix worker run build
	@$(MAKE) --no-print-directory hooks

hooks:
	@if [ -d .git ]; then \
		if command -v pre-commit >/dev/null 2>&1 && pre-commit --version >/dev/null 2>&1; then \
			pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push; \
		elif command -v mise >/dev/null 2>&1 && mise x pre-commit@latest -- pre-commit --version >/dev/null 2>&1; then \
			mise x pre-commit@latest -- pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push; \
		else \
			uv tool install pre-commit >/dev/null 2>&1 || true; \
			uvx pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push; \
		fi; \
	fi

qa:
	@if command -v pre-commit >/dev/null 2>&1 && pre-commit --version >/dev/null 2>&1; then \
		pre-commit run --all-files && pre-commit run --hook-stage pre-push --all-files; \
	elif command -v mise >/dev/null 2>&1 && mise x pre-commit@latest -- pre-commit --version >/dev/null 2>&1; then \
		mise x pre-commit@latest -- pre-commit run --all-files && mise x pre-commit@latest -- pre-commit run --hook-stage pre-push --all-files; \
	else \
		uvx pre-commit run --all-files && uvx pre-commit run --hook-stage pre-push --all-files; \
	fi

dev:
	./scripts/dev.sh

render:
	kubectl kustomize deploy/dev

test:
	uv run --directory services/meeting pytest
	npm --prefix worker test

test-local:
	./scripts/test-local.sh

test-live:
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live

test-live-video:
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --video-only

test-live-sfu4:
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --four-speakers

test-canary:
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live -- --canary

test-live-login:
	npm --prefix worker run test:live -- --save-host-session "$${PROVIDER:-google_meet}"

lint:
	uv run --directory services/meeting ruff check src tests ../../services/asr
	npm --prefix worker run typecheck
