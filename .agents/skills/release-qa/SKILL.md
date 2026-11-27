---
name: release-qa
description: Complete static QA, Helm chart matrix, Dockerfile Hadolint/Trivy, workflow audit, and migration verification checklist for wortlaut.
---

# Release, Security & Manifest QA

Load this skill when changing Dockerfiles, Helm charts, Docker Compose files, GitHub Actions workflows, or database migrations.

## Verification Checklist

1. **GitHub Actions Workflows:**
   ```sh
   docker run --rm -v "${PWD}:/repo:ro" -w /repo \
     docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
   uvx zizmor==1.32.0 .github/workflows
   ```
   All third-party actions must remain pinned to full commit SHAs with minimal `permissions`.

2. **Dockerfiles & Container CVEs:**
   ```sh
   hadolint services/asr/Dockerfile services/asr/Dockerfile.cpu services/meeting/Dockerfile services/worker/Dockerfile
   ```
   - Every Python image runs on **Python 3.14** (`python:3.14-slim-trixie`), removes unused system `pip`/`ensurepip`/`uv`, runs as non-root UID `10001`, and executes `py_compile` at build time.
   - Scan rebuilt images with:
     `trivy image --scanners vuln --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 <image>`

3. **Helm Chart & Kustomize Matrix (must all pass `kubeconform -strict`):**
   - Default (`qwen3` + GPU)
   - `--set bundled.enabled=true --set ingress.enabled=false`
   - `--set asr.backend=parakeet --set asr.device=cpu` (must select `images.asrCpu`, omit `nvidia.com/gpu`, set `WORTLAUT_ASR_ALLOW_CPU="true"`, and format large capacity values as `int64` integers — never `1.728e+09`)
   - `kubectl kustomize deploy/dev`

4. **Docker Compose & `.env.example`:**
   ```sh
   docker compose --env-file .env.example config --quiet
   docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.gpu.yml config --quiet
   ```
   Verify default Compose resolves to `parakeet`/`cpu` (`wortlaut-asr-cpu`) and GPU override resolves to `qwen3`/`cuda` (`wortlaut-asr`).

5. **Python/TS QA & Alembic Head:**
   ```sh
   make lint
   make qa
   ```
   Confirm `alembic heads` reports exactly 1 head.
