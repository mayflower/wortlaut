SHELL := /bin/sh
WORTLAUT_NAMESPACE ?= wortlaut-$(shell id -un)
KUBECONFIG := $(CURDIR)/.dev/kubeconfig
export KUBECONFIG WORTLAUT_NAMESPACE

.PHONY: setup dev render test test-live test-live-login lint
setup:
	./scripts/setup.sh

dev:
	./scripts/dev.sh

render:
	kubectl kustomize deploy/dev

test:
	uv run --directory services/meeting pytest
	npm --prefix worker test

test-live:
	PROVIDER="$(PROVIDER)" npm --prefix worker run test:live

test-live-login:
	npm --prefix worker run test:live -- --save-host-session "$${PROVIDER:-google_meet}"

lint:
	uv run --directory services/meeting ruff check src tests
	npm --prefix worker run typecheck
