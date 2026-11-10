# Contributing to wortlaut

Thank you for your interest in contributing to `wortlaut`!

## Core Architectural Principles

Before proposing changes, please keep our core invariants in mind:

1. **True Per-Participant Audio Capture**: Speaker attribution comes from isolated WebRTC receiver tracks bound to verified conference participant sessions — **never** mixed-audio diarization, voiceprints, or active-speaker name guessing.
2. **Parallel Multi-Provider Support**: Google Meet, Microsoft Teams, Cisco Webex, and Zoom run side-by-side in the same instance (selected per recording, never via a global mode switch). Missing credentials for one provider must never block another.
3. **Minimalism & Real Integration Boundaries**: Keep the stack lean (`services/meeting` FastAPI + PostgreSQL + S3, `services/asr` Parakeet GPU service, `worker` TypeScript/Playwright). Do not introduce external message queues or extra microservices. PostgreSQL and S3 behavior must be tested against real disposable instances, not mocked away.
4. **Honest Provider Verification**: Clearly distinguish synthetic browser/lifecycle fixture tests (`npm run test:audio`, `npm run test:meet`) from live conference verification (`make test-live`) in PR descriptions.

## Local Development Without a Kubernetes Cluster

You only need **Python 3.12 + [`uv`](https://docs.astral.sh/uv/)**, **Node.js 22+**, and **Docker** installed locally:

```bash
# 1. Install Python & Node.js dependencies and build the worker/UI bundles
make setup-local

# 2. Run linters (ruff + TypeScript typecheck) and the full PostgreSQL + S3 + worker test suite
#    (automatically starts and cleans up disposable PostgreSQL 17 & RustFS Docker containers)
make test-local
```

To run browser audio & Meet capture fixtures locally:

```bash
cd worker
npx playwright install --with-deps chromium
npm run test:audio
```

To start `wortlaut` locally in subprocess mode (`WORTLAUT_CONTROLLER_BACKEND=local`):

```bash
./scripts/run-local.sh
```

## Pull Request Checklist

- [ ] Follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat(calendar): ...`, `fix(worker): ...`, `docs: ...`).
- [ ] `make test-local` passes cleanly.
- [ ] Never commit tokens, `.env*` secrets, Playwright `storageState` cookies, or real meeting URLs.
- [ ] Preserve existing docstrings and comments unrelated to your change.
