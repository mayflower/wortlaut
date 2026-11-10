SHELL := /bin/sh
WORTLAUT_NAMESPACE ?= wortlaut-$(shell id -un)
KUBECONFIG := $(CURDIR)/.dev/kubeconfig
export KUBECONFIG WORTLAUT_NAMESPACE

.PHONY: setup setup-local dev render test test-local test-live test-live-login lint
setup:
	./scripts/setup.sh

setup-local:
	uv sync --project services/meeting
	npm --prefix worker ci
	npm --prefix worker run build

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

test-live-login:
	npm --prefix worker run test:live -- --save-host-session "$${PROVIDER:-google_meet}"

lint:
	uv run --directory services/meeting ruff check src tests
	npm --prefix worker run typecheck
