#!/bin/sh
# Installs pre-commit, commit-msg, and pre-push git QA hooks.
set -eu
cd "$(dirname "$0")/.."

[ -d .git ] || exit 0

if command -v pre-commit >/dev/null 2>&1 && pre-commit --version >/dev/null 2>&1; then
  exec pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push
elif command -v mise >/dev/null 2>&1 && mise x pre-commit@latest -- pre-commit --version >/dev/null 2>&1; then
  exec mise x pre-commit@latest -- pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push
else
  uv tool install pre-commit >/dev/null 2>&1 || true
  exec uvx pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg --hook-type pre-push
fi
