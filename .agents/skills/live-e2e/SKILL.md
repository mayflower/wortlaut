---
name: live-e2e
description: Run isolated kind Kubernetes E2E tests and real live conference provider E2E verification (Google Meet, Microsoft Teams, Cisco Webex, Zoom) against wortlaut.
---

# Live & `kind` E2E Verification

Use this skill when running end-to-end verification in a local `kind` cluster or executing real conference provider tests (`worker/test/live-provider-e2e.ts`).

## Hard Rules

1. **Never touch `~/.kube/config` or existing unrelated clusters.** Always use a dedicated cluster (`wortlaut-e2e`) and project-local kubeconfig (`.dev/kind-e2e-kubeconfig`).
2. **Never claim provider acceptance from synthetic tests.** Always report synthetic/in-cluster ASR checks separately from real live conference runs (`google_meet`, `teams`, `webex`, `zoom`).
3. **Never print or commit secrets.** Host storage states live under ignored `.dev/*-host-state.json` and `.dev/*.env`.

## Fast Path (`scripts/e2e-kind.sh`)

```sh
# 1. In-cluster Helm + Parakeet CPU smoke (zero external calls):
make test-e2e-kind

# 2. Live provider E2E against the isolated kind cluster (all 4 platforms):
PROVIDER=google_meet,teams,webex,zoom make test-e2e-kind

# 3. Switch ASR backend (e.g. Qwen3 on CPU/GPU):
WORTLAUT_ASR_BACKEND=qwen3 WORTLAUT_ASR_DEVICE=cpu make test-e2e-kind
```

## Headless Live Browser Notes (Wayland / Linux without host Xvfb)

`worker/test/live-provider-e2e.ts` launches speaker Chromium instances under `Xvfb`. When `Xvfb` is not installed on the host, run the harness inside `mcr.microsoft.com/playwright:v1.65.1-noble` (which `scripts/e2e-kind.sh` does automatically):

- Always pass `--init --network host --ipc=host --security-opt seccomp=unconfined` (Chromium sandbox inside Docker requires seccomp unconfined or `SYS_ADMIN`).
- Pass `--user "$(id -u):$(id -g)" -e HOME=/tmp` so result JSONs/screenshots written under `.dev/` retain host user ownership.
- If a host session cookie has expired, ask the user to refresh it via `PROVIDER=<provider> make test-live-login` rather than simulating success.

## Expected Evidence per Provider

Verify and report individually for each tested provider:
- Isolated per-speaker tracks (`liveDisjointSpeakers=true`, disjoint channels & speakers A vs. B)
- Verified participant session binding (`Sprecherbindung verifiziert: true`)
- Camera exclusion (`0 Keyframes bei aktiver Teilnehmerkamera`)
- Screen-share slide keyframes (`verified=true`, where host guest UI allows screen share)
- Live 1280×720 bot video tile (`receiving=true`, `liveUpdated=true`) & chat opt-out (`no`) where available
