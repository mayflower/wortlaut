# wortlaut

[![Checks](https://github.com/mayflower/wortlaut/actions/workflows/checks.yml/badge.svg)](https://github.com/mayflower/wortlaut/actions/workflows/checks.yml)
[![Website](https://img.shields.io/badge/Website-wortlaut.cloud-10b981)](https://wortlaut.cloud)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-Docker%20Compose%20%7C%20Helm%20%7C%20Kubernetes-6366f1)](#self-hosting--deployment-options)

**Website:** [https://wortlaut.cloud](https://wortlaut.cloud) · **Quickstart:** [Docker Compose](docker-compose.yml) · **Helm Chart:** [`charts/wortlaut`](charts/wortlaut) · **REST API:** [`/docs`](services/meeting/src/wortlaut/app.py)

Self-hosted, GDPR-compliant meeting transcription for **Google Meet**, **Cisco Webex**, **Microsoft Teams**, and **Zoom**. `wortlaut` joins conferences as a browser participant, captures incoming WebRTC audio sources per receiver before mixing, transcribes them locally with a shared **Parakeet** ASR model (GPU or CPU fallback — no external cloud speech APIs), and delivers speaker-attributed **Markdown (`.md`)**, **TXT**, **WebVTT (`.vtt`)**, **JSON**, and **HTML email** protocols.

Meetings can be started ad hoc or scheduled through the integrated Web-UI (`/` and `/ui`), the HTTP REST API, OAuth2 calendar synchronization (`calendar_oauth.py` for Google Calendar & Microsoft 365), or `.ics` email invitations (`robot@wortlaut.cloud`). Meet, Webex, Teams, and Zoom run side by side in the same instance, sharing storage, transcription, and capacity limits.

## Current status

wortlaut is under active development. Browser participation, per-receiver WebRTC audio capture, and local Parakeet transcription work across Google Meet, Webex, Microsoft Teams, and Zoom. Participant names are resolved from the browser DOM, SDP, and signaling channels when unambiguously matched to a receiver source.

| Provider | Available path | Current status & limits |
| --- | --- | --- |
| Google Meet | Chromium web client ([capture.ts](worker/src/meet/capture.ts)); guest or saved browser session | Per-receiver WebRTC audio capture and participant binding verified live |
| Webex | Chromium guest join ([webex-browser.ts](worker/runtime/webex-browser.ts)); separate SDK path also available | Browser join, multistream `AUDIO-MAIN` receiver capture, and `activeSpeakerNotification` DataChannel attribution verified live. SDK path needs separate live validation |
| Microsoft Teams | Chromium guest join with English/German controls ([teams-browser.ts](worker/runtime/teams-browser.ts)) | Per-receiver WebRTC audio capture and CSI participant rebinding verified live |
| Zoom | Chromium web client ([zoom-browser.ts](worker/runtime/zoom-browser.ts), [zoom-url.ts](worker/src/zoom-url.ts)); guest or saved browser session | Anonymous browser join, waiting room admission, DOM roster inspection, and `RTCRtpReceiver` Opus audio capture verified live (`attribution_unknown: true` when Zoom's web client does not expose per-participant SSRC signaling) |

Unbound sources are explicitly marked `speaker_id: null` and `attribution_unknown: true` when transcribed speech cannot be attributed to a verified participant session; source coverage remains `unknown` unless complete signaling coverage is proven.

The intended model is transcription per incoming source with a verified provider participant identity. Speaker diarization, voiceprints, and active-speaker name guesses are not substitutes for that binding. Meet uses the browser only for conference participation and audio capture (no Google Meet REST or Media API); for calendar event discovery, OAuth2 read-only calendar synchronization (Google Calendar `calendar.readonly` and Microsoft Graph `Calendars.Read` in [calendar_oauth.py](services/meeting/src/wortlaut/calendar_oauth.py)) is supported alongside IMAP/`.ics` invitations.

## Architecture

- **Meeting service** ([app.py](services/meeting/src/wortlaut/app.py), [models.py](services/meeting/src/wortlaut/models.py)) — Python/FastAPI, integrated Web-UI ([ui.py](services/meeting/src/wortlaut/ui.py) serving `/` and `/ui`), Dex OIDC authentication ([oidc.py](services/meeting/src/wortlaut/oidc.py)), calendar & OAuth2 sync ([calendar.py](services/meeting/src/wortlaut/calendar.py), [calendar_oauth.py](services/meeting/src/wortlaut/calendar_oauth.py)), PostgreSQL-backed scheduling, Kubernetes worker management ([controller.py](services/meeting/src/wortlaut/controller.py)), audio ingest, exports ([exports.py](services/meeting/src/wortlaut/exports.py)), and email processing ([mail.py](services/meeting/src/wortlaut/mail.py)) in one service.
- **Worker** ([worker](worker)) — TypeScript, Playwright, and sandboxed Chromium; one short-lived Kubernetes Job per meeting. Browser workers use a virtual display under Linux. The alternative Webex SDK path uses a hosted HTTPS page.
- **ASR service** ([services/asr](services/asr)) — a shared local Parakeet model for speech recognition.
- **Storage** — PostgreSQL for state and transcripts, S3-compatible storage for audio.

See [meeting service](services/meeting), [ASR service](services/asr), [worker](worker), [Helm chart](charts/wortlaut), [Docker Compose](docker-compose.yml), and [Kubernetes Kustomize manifests](deploy).

## Self-hosting & deployment options

wortlaut supports four deployment setups depending on your environment ([runtime_backends.py](services/meeting/src/wortlaut/runtime_backends.py)):

1. **Docker Compose (`WORTLAUT_CONTROLLER_BACKEND=docker`)** — Single-server / VM deployment ([docker-compose.yml](docker-compose.yml)). Starts `wortlaut-meeting`, `wortlaut-asr`, PostgreSQL 17, and MinIO S3, and spawns isolated short-lived `wortlaut-worker` containers via the Docker Engine socket:
   ```sh
   docker compose up -d --build
   # Web-UI: http://127.0.0.1:8000/ui
   ```
2. **Helm Chart for Kubernetes (`WORTLAUT_CONTROLLER_BACKEND=kubernetes`)** — Production Kubernetes deployment ([charts/wortlaut](charts/wortlaut)):
   ```sh
   helm install wortlaut ./charts/wortlaut \
     --namespace wortlaut --create-namespace \
     --set config.apiUrl=https://wortlaut.example.org/ \
     --set config.sdkPageUrl=https://wortlaut.example.org/sdk/ \
     --set secrets.apiToken="$WORTLAUT_API_TOKEN" \
     --set secrets.databaseUrl="$DATABASE_URL"
   ```
   *(Alternatively, declarative Kubernetes manifests via Kustomize are available under [deploy/k8s/base](deploy/k8s/base).)*
3. **Local Process / Bare-Metal Mode (`WORTLAUT_CONTROLLER_BACKEND=local`)** — Runs `wortlaut-meeting` directly on Linux and spawns isolated `node dist-worker/runtime/main.js` subprocesses per recording ([scripts/run-local.sh](scripts/run-local.sh)):
   ```sh
   ./scripts/run-local.sh
   ```
4. **CPU Fallback for ASR (`WORTLAUT_ASR_ALLOW_CPU=true`)** — For production scale, an NVIDIA GPU node is recommended for `wortlaut-asr`. For evaluation, CI, or small setups without a GPU, setting `WORTLAUT_ASR_ALLOW_CPU=true` loads the Parakeet ASR model on CPU (`map_location="cpu"` in [services/asr/app.py](services/asr/app.py); enabled by default in `docker-compose.yml`).

## Development setup

The included Tilt setup targets the existing `data` Kubernetes cluster. It is not a standalone Docker quickstart: it requires access to that cluster, its registry, GPU resources, and configured ingress domain. Another environment needs corresponding changes to [Tiltfile](Tiltfile) and [deploy/dev](deploy/dev).

Install `uv`, Node.js/npm, `kubectl`, Tilt, and Docker with Buildx, then run:

```sh
make setup
make dev
```

`make setup` installs locked dependencies and creates a private `.dev/kubeconfig` from `~/.kube/data-lan-mayflower`. Set `WORTLAUT_SOURCE_KUBECONFIG` to use another source containing context `data`. The global Kubernetes context is unchanged.

Tilt builds `linux/amd64` images using Kubernetes BuildKit and deploys to `wortlaut-$(id -un)`. Credentials are generated under the ignored `.dev/` directory and copied into Kubernetes Secrets.

| Service | Local address |
| --- | --- |
| Tilt | http://127.0.0.1:34604 |
| Meeting Web-UI | http://127.0.0.1:34601/ui |
| Meeting API / OpenAPI UI | http://127.0.0.1:34601/docs |
| ASR | http://127.0.0.1:34602 |
| PostgreSQL | `127.0.0.1:34632` |
| S3 | http://127.0.0.1:34609 |

Workers use the configured HTTPS ingress to reach the meeting service. For direct cluster commands, always select the project kubeconfig, context, and namespace explicitly:

```sh
kubectl --kubeconfig .dev/kubeconfig --context data \
  -n "wortlaut-$(id -un)" get pods
```

## Enable meeting providers

Provider files use `NAME=value` lines. Keep them private (`chmod 600`) and never commit credentials or browser session files. All providers can be enabled at once.

**Google Meet — `.dev/meet.env`:**

```dotenv
WORTLAUT_ENABLE_GOOGLE_MEET=true
WORTLAUT_MEET_LOCALE=de-DE
```

Guest access depends on meeting settings and host admission. To use an authorized saved browser session, place its Playwright storage state in `.dev/meet-storage-state.json` and set `WORTLAUT_MEET_STORAGE_STATE_SECRET=wortlaut-meet-browser`. Only Meet workers receive that Secret.

**Webex browser guest — `.dev/webex.env`:**

```dotenv
WORTLAUT_ENABLE_WEBEX_BROWSER=true
```

This path needs no Service-App token. The host must start the room and admit the participant when required. The current browser flow was tested with a Webex personal room; other join flows may need additional handling.

For the alternative Webex SDK path, leave the browser flag disabled and configure `WORTLAUT_WEBEX_SERVICE_TOKEN`. Optional Service-App refresh uses `WORTLAUT_ENABLE_WEBEX_REFRESH`, `WORTLAUT_WEBEX_CLIENT_ID`, `WORTLAUT_WEBEX_CLIENT_SECRET`, and `WORTLAUT_WEBEX_REFRESH_TOKEN` in the same private file.

**Teams browser guest — `.dev/teams.env`:**

```dotenv
WORTLAUT_ENABLE_TEAMS=true
WORTLAUT_TEAMS_LOCALE=en-US
```

Use `provider: "teams"` with the full invitation URL, including its query parameters. Teams supports API scheduling, OAuth2 calendar sync, and iCalendar invitations, with the same capacity limits as Meet, Webex, and Zoom.

The browser worker handles English/German join controls and the admission lobby, captures incoming WebRTC receiver tracks, and streams them to ASR. Browser fixtures and live CSI participant rebinding have been verified.

**Zoom browser guest — `.dev/zoom.env`:**

```dotenv
WORTLAUT_ENABLE_ZOOM=true
WORTLAUT_ZOOM_LOCALE=en-US
```

Use `provider: "zoom"` with a `https://*.zoom.us/j/<id>?pwd=...` or `https://app.zoom.us/wc/<id>/join?pwd=...` invitation URL (normalized automatically to the Zoom web client `/wc/<id>/join`). To use an authorized saved browser session when a meeting requires Zoom sign-in, place its Playwright storage state in `.dev/zoom-storage-state.json` and set `WORTLAUT_ZOOM_STORAGE_STATE_SECRET=wortlaut-zoom-browser`.

After changing provider or mail configuration in a running environment:

```sh
KUBECONFIG="$PWD/.dev/kubeconfig" WORTLAUT_NAMESPACE="wortlaut-$(id -un)" \
  python3 scripts/dev-secrets.py
kubectl --kubeconfig .dev/kubeconfig --context data \
  -n "wortlaut-$(id -un)" rollout restart deployment/wortlaut-meeting
```

## Authentication, scheduling, and exporting a recording

wortlaut supports three credential types ([oidc.py](services/meeting/src/wortlaut/oidc.py), [app.py](services/meeting/src/wortlaut/app.py)):
1. **Dex OIDC User Sessions (`wortlaut-user-…`)**: Browser users sign in via OIDC Authorization Code + PKCE (`GET /auth/callback`, `POST /v1/auth/oidc/exchange`, `GET /v1/auth/me` configured via `WORTLAUT_OIDC_ISSUER` and `WORTLAUT_OIDC_CLIENT_ID`). Regular users only see and manage their own recordings (`owner_sub` / `owner_email`), while emails listed in `WORTLAUT_OIDC_ADMIN_EMAILS` have full operator access.
2. **Operator API Token (`WORTLAUT_API_TOKEN`)**: Generated in `.dev/runtime.env` for full operator and automation access. Supply it privately via the `Authorization: Bearer` header; do not put it in URLs.
3. **Scoped Reader Token (`wortlaut-read-<recording_id>.<mac>`)**: Issued per recording (`POST /v1/recordings/{id}/reader-token` or included as `#token=wortlaut-read-…` in result emails) for read-only access to a single recording's transcript and exports.

Set `MEETING_URL` to a real meeting you are authorized to record, and `STARTS_AT` / `ENDS_AT` to ISO 8601 timestamps including a timezone.

```sh
# Requires jq. Use provider=webex for Webex, provider=teams for Teams, or provider=zoom for Zoom.
IDEMPOTENCY_KEY=$(uuidgen) # Keep this value for retries of this request.
jq -n --arg url "$MEETING_URL" --arg start "$STARTS_AT" --arg end "$ENDS_AT" \
  '{provider:"google_meet", meeting_url:$url, starts_at:$start, ends_at:$end}' |
  curl --fail-with-body http://127.0.0.1:34601/v1/recordings \
    -H "Authorization: Bearer $WORTLAUT_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" --data-binary @-
```

Save the returned `id` as `RECORDING_ID`. Reusing an idempotency key with the same request returns the same recording; a different request returns HTTP 409. Retain the original key when retrying a request whose outcome is unknown.

```sh
curl --fail-with-body "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN"

curl --fail-with-body "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID/exports/json" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN" -o recording.json

# End a recording early or cancel a scheduled recording.
curl --fail-with-body -X POST "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID/cancel" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN"
```

Exports ([exports.py](services/meeting/src/wortlaut/exports.py)) support `txt`, `vtt`, `md` (GitHub-Flavored Markdown), and `json` via `GET /v1/recordings/{id}/exports/{format}` (or `?format=`). They return HTTP 409 while processing is pending and HTTP 410 after transcript retention expires. The recording detail includes participation, processing, audio gaps, source attribution, worker diagnostics, `live_status`, and delivery status. `GET /v1/recordings/{id}/transcript` returns live or completed transcript segments, `GET /v1/recordings` lists recordings with cursor pagination and full-text/speaker search (`?q=`), `POST /v1/recordings/{id}/rejoin` triggers a fresh worker join attempt, `POST /v1/recordings/{id}/reader-token` issues a scoped read-only link token, `POST /v1/recordings/{id}/delivery/retry` retries SMTP delivery, and `GET /metrics` exposes Prometheus metrics; see the OpenAPI UI (`/docs`) for all parameters.

By default ([settings.py](services/meeting/src/wortlaut/settings.py)), the scheduler starts workers 60 seconds before a meeting, allows 15 active meetings (`max_active_meetings`) across all providers, waits up to ten minutes for admission, and stops a worker after five minutes if no remote participants or active audio are observed (`room_empty`). Completed transcription does not imply complete audio coverage or correct speaker attribution.

## Email invitations and results

IMAP and SMTP are disabled by default. For a regular mailbox, configure `.dev/mail.env` with your provider's settings:

```dotenv
WORTLAUT_ENABLE_IMAP=true
WORTLAUT_IMAP_HOST=imap.example.org
WORTLAUT_IMAP_USERNAME=bot@example.org
WORTLAUT_IMAP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_MAIL_SENDER_AUTH=dkim
WORTLAUT_MAIL_ALLOWED_SENDER_DOMAINS=["example.org"]
WORTLAUT_MAIL_REPLY_TO_SENDER=true
WORTLAUT_ENABLE_SMTP=true
WORTLAUT_SMTP_HOST=smtp.example.org
WORTLAUT_SMTP_USERNAME=bot@example.org
WORTLAUT_SMTP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_SMTP_FROM=bot@example.org
```

Defaults are IMAP over TLS on port 993 and SMTP with STARTTLS on port 587. DKIM mode verifies signatures against DNS and requires an allowed sender domain; the visible From address alone is insufficient. Calendar organizers must match the authenticated sender.

Supported invitations include iCalendar messages and immediate email invitations containing a meeting link in text or HTML for Google Meet, Webex, Microsoft Teams, and Zoom. Signed Google Meet notifications are supported with the inviter checked against the same domain allowlist. Immediate invitations default to 120 minutes from the signed sending time (`WORTLAUT_INSTANT_INVITE_MINUTES`). Duplicate messages do not create duplicate recordings. In addition to email invitations, users can connect Google Calendar (`calendar.readonly`) or Microsoft 365 Calendar (`Calendars.Read`) via OAuth2 PKCE in the Web-UI (`POST /v1/calendar/oauth/exchange`, `POST /v1/calendar/oauth/connections/{id}/sync`, `PATCH /v1/calendar/oauth/connections/{id}`, `DELETE /v1/calendar/oauth/connections/{id}`, `POST /v1/calendar/oauth/events/{id}/toggle`).

Alternatively, `WORTLAUT_MAIL_SENDER_AUTH=gateway` uses `WORTLAUT_TRUSTED_SENDER_HEADER` and `WORTLAUT_ORGANIZER_PERMISSIONS`. This requires a trusted mail gateway that strips incoming copies of the configured header and sets it after authenticating the sender. Ordinary mailboxes must not rely on a sender-supplied header.

With `WORTLAUT_MAIL_REPLY_TO_SENDER=true`, results go to the validated organizer/inviter, not arbitrary Reply-To or CC addresses. Explicit recipient mappings are available through `WORTLAUT_RESULT_RECIPIENTS`. Results include TXT/VTT/JSON attachments; large results use ZIP or authenticated download instructions. When a calendar-invited recording or a recording ending with a known join/lobby failure finishes without recorded audio, wortlaut sends a failure notification email. An uncertain SMTP result is marked `delivery_unknown`; explicitly retrying delivery may send a duplicate.

## Optional Local LLM Protocol Summary

Structured protocol summaries, topic blocks, and action items are disabled by default (`WORTLAUT_ENABLE_LLM_SUMMARY=false`). When a local Ollama endpoint is available in the cluster, enable it with:

```dotenv
WORTLAUT_ENABLE_LLM_SUMMARY=true
WORTLAUT_OLLAMA_URL=http://ollama.ollama.svc.cluster.local:11434
WORTLAUT_OLLAMA_MODEL=qwen3.8:latest
```

## Tests

```sh
make lint
make test
npm --prefix worker run build
npm --prefix worker run test:audio
npm --prefix worker run test:meet
```

Database and storage tests use isolated PostgreSQL schemas and S3 buckets. Run the development environment or configure `WORTLAUT_TEST_DATABASE_URL` and the S3 settings; tests requiring unavailable services may be skipped. Browser tests also require Playwright Chromium (`cd worker && npx playwright install chromium`). On Linux, the Meet browser suite also needs an X11 display, Xvfb, and `xdotool`. It includes the Webex guest-flow fixture. Fixtures verify controlled behavior, not live provider compatibility or participant identity.

## Operational limits

- Audio retention defaults to 24 hours after completion; transcript retention is 30 days. Unfinished processing expires 72 hours after the scheduled end.
- Worker buffering, stored audio, and ASR backlog have bounded capacities. Dropped audio and incomplete capture remain visible in status and exports.
- Browser UI changes, guest-access rules, and admission requirements can affect joins. A successful click is not proof of admission.
- Chromium runs as UID 1000 with its sandbox enabled. Worker Jobs currently use outer `Unconfined` seccomp for user namespaces; a preinstalled local profile can be configured instead.
- Calendar `RANGE=THISANDFUTURE`, changes to a series master's time basis, and high-frequency recurrence rules are unsupported.

All meeting-service settings and defaults are in [settings.py](services/meeting/src/wortlaut/settings.py). Development contributions should follow [AGENTS.md](AGENTS.md).
