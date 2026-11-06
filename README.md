# wortlaut Blueprint

## System Overview

Self-hosted meeting transcription for Google Meet and Webex. `wortlaut` joins as a browser participant, captures incoming WebRTC audio sources per receiver before mixing, transcribes them with a shared local NVIDIA Parakeet (`nvidia/parakeet-tdt-0.6b-v3`) model, and produces TXT, WebVTT, and JSON exports.

Meetings can be scheduled through the HTTP API or email invitations. Meet, Webex, and Microsoft Teams run side by side, with a provider selected for each recording. They share storage, transcription, and capacity limits.

## Subdirectories & System Boundaries

- `scripts`: [./scripts/README.md](./scripts/README.md) - Developer environment bootstrap (`setup.sh`), secret provisioning (`dev-secrets.py`), Tilt startup (`dev.sh`), and Kubernetes BuildKit image build scripts (`build.sh`) for context `data`.
- `services`: [./services/README.md](./services/README.md) - Backend Python services grouping the GPU Parakeet ASR inference service ([./services/asr/README.md](./services/asr/README.md)) and the FastAPI meeting coordination, ingest, VAD/ASR orchestration, Kubernetes controller, and mail/calendar service ([./services/meeting/README.md](./services/meeting/README.md)).
- `worker`: [./worker/README.md](./worker/README.md) - TypeScript/Playwright/Chromium meeting media receiver worker package supporting Webex, Google Meet, and Microsoft Teams per-receiver WebRTC audio capture ([./worker/runtime/README.md](./worker/runtime/README.md), [./worker/src/README.md](./worker/src/README.md), [./worker/public/README.md](./worker/public/README.md), [./worker/scripts/README.md](./worker/scripts/README.md)).

## Global Invariants

- `[worker/src/capture.ts:AudioCapture]` & `[services/meeting/src/wortlaut/ingest.py:SourceBinding]`: Incoming WebRTC audio tracks are captured in isolated `AudioWorkletNode` streams (`16000` Hz mono `pcm_s16le`) without mixing; speaker streams must either carry a verified `speaker_id` or explicitly set `attribution_unknown=True` (with `speaker_id=None`, `participant_id=None`, `participant_name=None`).
- `[worker/runtime/teams-browser.ts:TeamsBrowser.disableDevices]` & `[worker/src/meet-page.ts:resolveReceiver]`: Microsoft Teams worker sessions verify all `RTCPeerConnection` senders before joining and abort with `teams_sending_device_active` if any sender has a live enabled track; incoming WebRTC audio receivers are bound or mid-stream rebound (`AudioCapture.rebind`) with `attribution_unknown: false` when `RTCDataChannel` participant signaling and RTP `csrc`/`ssrc`/`track_id`/`stream_id` match unambiguously, falling back to `attribution_unknown: true` when unverified.
- `[services/meeting/src/wortlaut/ingest.py:accept_chunk]` & `[services/meeting/src/wortlaut/controller.py:reconcile_attempt]`: Cross-component admission and state transitions are serialized in PostgreSQL using advisory locks (`749836123` for audio/ASR capacity, `749836124` for scheduler job starts, `749836125` for calendar/mail mutations), and worker bootstrap `Secret`s are retained until Pod termination (`wortlaut/termination-observed`) is recorded.
- `[services/asr/app.py:infer]` & `[services/meeting/src/wortlaut/asr.py:commit_result]`: The GPU ASR service executes at most one Parakeet inference at a time (`HTTP 429` with `Retry-After: 5` when busy, `HTTP 503` on latched `torch.AcceleratorError`), and committed `TranscriptSegment` rows in PostgreSQL are never overwritten or duplicated.
- `[scripts/setup.sh:tool]` & `[scripts/dev-secrets.py:WORTLAUT_NAMESPACE]`: Local cluster operations target Kubernetes context `data` via `.dev/kubeconfig` in namespace `wortlaut-$(id -un)` without mutating global kubeconfig state, and credentials are stored exclusively in `0600` `.dev/*.env` files and Kubernetes `Secret`s.

## Global Side Effects

- `[services/meeting/src/wortlaut/database.py:get_engine]` & `[services/meeting/migrations/env.py]`: Connects to PostgreSQL to apply Alembic migrations (`0001`–`0022`) and mutate recording, attempt, stream, chunk, control, ASR job, transcript segment, calendar, and mail delivery tables.
- `[services/meeting/src/wortlaut/storage.py:AudioStorage]`: Writes (`IfNoneMatch="*"`), reads, and expires `WORTLAUT1`-framed PCM objects under `audio/{recording_id}/...` in S3-compatible storage.
- `[services/meeting/src/wortlaut/controller.py:controller_pass]` & `[worker/runtime/main.ts:run]`: Reconciles per-attempt Kubernetes `batch/v1` `Job`s, `v1` `Secret`s, and `Pod` finalizers; worker pods launch sandboxed Chromium (`Xvfb`/`xdotool` on Linux) and stream captured PCM over WebSocket `/v1/attempts/{attempt_id}/audio` to the meeting service.
- `[services/meeting/src/wortlaut/asr.py:inference_pass]` & `[services/asr/app.py:transcribe]`: Streams segmented 16 kHz mono PCM over HTTP `POST /v1/transcribe` to the CUDA-backed NVIDIA Parakeet (`nvidia/parakeet-tdt-0.6b-v3`) service.
- `[services/meeting/src/wortlaut/calendar.py:imap_pass]`, `[services/meeting/src/wortlaut/mail.py:transmit]`, & `[services/meeting/src/wortlaut/webex.py:guest_token]`: Polls IMAP over TLS with DNS TXT DKIM verification, sends transcript exports over SMTP/STARTTLS, and exchanges Webex guest/OAuth tokens with `https://webexapis.com`.

## System Verification

- Run: `make test`
- Run: `make lint`

## Current status

wortlaut is under active development. Browser participation and transcription work, but reliable speaker attribution is unfinished.

| Provider | Available path | Current limits |
| --- | --- | --- |
| Google Meet | Chromium web client; guest or saved browser session | Audio sources are not yet bound to verified participant sessions |
| Webex | Chromium guest join; separate SDK path also available | Browser join and intelligible transcription verified live; participant binding and source coverage remain unverified. SDK path needs separate live validation |
| Microsoft Teams | Chromium guest join with English/German controls | Audio sources are captured per WebRTC receiver (`attribution_unknown: true`, `capability: "unverified"`); live admission and participant binding remain unverified |

The Webex browser trial on 12 October 2026 received intelligible speech on two sources, with some duplicated speech. Receiving multiple tracks does not prove that each track represents a different participant. Unbound sources are explicitly marked `speaker_id: null` and `attribution_unknown: true`; source coverage remains `unknown`.

The intended model is transcription per incoming source with a verified provider participant identity. Speaker diarization, voiceprints, and active-speaker name guesses are not substitutes for that binding. Meet uses the browser only: no Google Meet REST, Media, or Calendar API.

## Architecture

- **Meeting service** — Python/FastAPI, integrated Web-UI (`/` and `/ui`), PostgreSQL-backed scheduling, Kubernetes worker management, audio ingest, exports, and email processing in one service.
- **Worker** — TypeScript, Playwright, and sandboxed Chromium; one short-lived Kubernetes Job per meeting. Browser workers use a virtual display under Linux. The alternative Webex SDK path uses a hosted HTTPS page.
- **ASR service** — a shared local Parakeet model for speech recognition.
- **Storage** — PostgreSQL for state and transcripts, S3-compatible storage for audio.

See [meeting service](./services/meeting/README.md), [ASR service](./services/asr/README.md), [worker](./worker/README.md), and [deployment configuration](./deploy/dev/kustomization.yaml).

## Development setup

The included Tilt setup targets the existing `data` Kubernetes cluster. It is not a standalone Docker quickstart: it requires access to that cluster, its registry, GPU resources, and configured ingress domain. Another environment needs corresponding changes to [Tiltfile](./Tiltfile) and [deploy/dev/kustomization.yaml](./deploy/dev/kustomization.yaml).

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

Use `provider: "teams"` with the full invitation URL, including its query parameters. Teams supports API scheduling and iCalendar invitations, with the same capacity limits as Meet and Webex.

The browser worker handles English/German join controls and the admission lobby, captures incoming WebRTC receiver tracks with `attribution_unknown: true` (`capability: "unverified"`), and streams them to ASR. Browser fixtures pass; a live Teams test is still required.

After changing provider or mail configuration in a running environment:

```sh
KUBECONFIG="$PWD/.dev/kubeconfig" WORTLAUT_NAMESPACE="wortlaut-$(id -un)" \
  python3 scripts/dev-secrets.py
kubectl --kubeconfig .dev/kubeconfig --context data \
  -n "wortlaut-$(id -un)" rollout restart deployment/wortlaut-meeting
```

## Schedule, inspect, and export a recording

The operator API token is generated in `.dev/runtime.env`. Supply it privately as `WORTLAUT_API_TOKEN`; do not put it in URLs. Set `MEETING_URL` to a real meeting you are authorized to record, and `STARTS_AT` / `ENDS_AT` to ISO 8601 timestamps including a timezone.

```sh
# Requires jq. Use provider=webex for a Webex URL.
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

Exports support `txt`, `vtt`, and `json`. They return HTTP 409 while processing is pending and HTTP 410 after transcript retention expires. The recording detail includes participation, processing, audio gaps, source attribution, worker diagnostics, and delivery status. `GET /v1/recordings/{id}/transcript` returns live or completed transcript segments, and `PATCH /v1/recordings/{id}/sources` assigns manual speaker labels per `provider_source_id` (also available in the integrated Web-UI at `/ui`). `GET /v1/recordings` lists recordings with cursor pagination; see the OpenAPI UI for filters and other endpoints.

By default, the scheduler starts workers 60 seconds before a meeting, allows two active meetings across all providers, and waits up to ten minutes for admission. Completed transcription does not imply complete audio coverage or correct speaker attribution.

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

Supported invitations include iCalendar messages and immediate email invitations containing a meeting link in text or HTML for Google Meet, Webex, and Microsoft Teams. Signed Google Meet notifications are supported with the inviter checked against the same domain allowlist. Immediate invitations default to 120 minutes from the signed sending time (`WORTLAUT_INSTANT_INVITE_MINUTES`). Duplicate messages do not create duplicate recordings.

Alternatively, `WORTLAUT_MAIL_SENDER_AUTH=gateway` uses `WORTLAUT_TRUSTED_SENDER_HEADER` and `WORTLAUT_ORGANIZER_PERMISSIONS`. This requires a trusted mail gateway that strips incoming copies of the configured header and sets it after authenticating the sender. Ordinary mailboxes must not rely on a sender-supplied header.

With `WORTLAUT_MAIL_REPLY_TO_SENDER=true`, results go to the validated organizer/inviter, not arbitrary Reply-To or CC addresses. Explicit recipient mappings are available through `WORTLAUT_RESULT_RECIPIENTS`. Results include TXT/VTT/JSON attachments; large results use ZIP or authenticated download instructions. When a calendar-invited recording or a recording ending with a known join/lobby failure (`FAILURE_REASONS`) finishes without recorded audio, `wortlaut` sends a failure notification email explaining the termination reason. An uncertain SMTP result is marked `delivery_unknown`; explicitly retrying delivery may send a duplicate.

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

All meeting-service settings and defaults are in [settings.py](./services/meeting/src/wortlaut/settings.py). Development contributions should follow [AGENTS.md](./AGENTS.md).
