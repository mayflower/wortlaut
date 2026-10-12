# wortlaut

Self-hosted meeting transcription for Google Meet and Webex. wortlaut joins as a browser participant, captures incoming WebRTC audio sources, transcribes them with a local Parakeet model, and produces TXT, WebVTT, and JSON exports.

Meetings can be scheduled through the HTTP API or email invitations. Meet and Webex run side by side, with a provider selected for each recording. They share storage, transcription, and capacity limits. Microsoft Teams is planned but not implemented.

## Current status

wortlaut is under active development. Browser participation and transcription work, but reliable speaker attribution is unfinished.

| Provider | Available path | Current limits |
| --- | --- | --- |
| Google Meet | Chromium web client; guest or saved browser session | Audio sources are not yet bound to verified participant sessions |
| Webex | Chromium guest join; separate SDK path also available | Browser join and intelligible transcription verified live; participant binding and source coverage remain unverified. SDK path needs separate live validation |
| Microsoft Teams | Planned | Not implemented |

The Webex browser trial on 12 October 2026 received intelligible speech on two sources, with some duplicated speech. Receiving multiple tracks does not prove that each track represents a different participant. Unbound sources are explicitly marked `speaker_id: null` and `attribution_unknown: true`; source coverage remains `unknown`.

The intended model is transcription per incoming source with a verified provider participant identity. Speaker diarization, voiceprints, and active-speaker name guesses are not substitutes for that binding. Meet uses the browser only: no Google Meet REST, Media, or Calendar API.

## Architecture

- **Meeting service** — Python/FastAPI, PostgreSQL-backed scheduling, Kubernetes worker management, audio ingest, exports, and email processing in one service.
- **Worker** — TypeScript, Playwright, and sandboxed Chromium; one short-lived Kubernetes Job per meeting. Browser workers use a virtual display under Linux. The alternative Webex SDK path uses a hosted HTTPS page.
- **ASR service** — a shared local Parakeet model for speech recognition.
- **Storage** — PostgreSQL for state and transcripts, S3-compatible storage for audio.

See [meeting service](services/meeting), [ASR service](services/asr), [worker](worker), and [deployment configuration](deploy).

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

Provider files use `NAME=value` lines. Keep them private (`chmod 600`) and never commit credentials or browser session files. Both providers can be enabled at once.

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

Exports support `txt`, `vtt`, and `json`. They return HTTP 409 while processing is pending and HTTP 410 after transcript retention expires. The recording detail includes participation, processing, audio gaps, source attribution, worker diagnostics, and delivery status. `GET /v1/recordings` lists recordings with cursor pagination; see the OpenAPI UI for filters and other endpoints.

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

Supported invitations include iCalendar messages for Meet/Webex and immediate Meet invitations containing a meeting link in text or HTML. Signed Google Meet notifications are supported with the inviter checked against the same domain allowlist. Immediate invitations default to 120 minutes from the signed sending time (`WORTLAUT_INSTANT_INVITE_MINUTES`). Duplicate messages do not create duplicate recordings.

Alternatively, `WORTLAUT_MAIL_SENDER_AUTH=gateway` uses `WORTLAUT_TRUSTED_SENDER_HEADER` and `WORTLAUT_ORGANIZER_PERMISSIONS`. This requires a trusted mail gateway that strips incoming copies of the configured header and sets it after authenticating the sender. Ordinary mailboxes must not rely on a sender-supplied header.

With `WORTLAUT_MAIL_REPLY_TO_SENDER=true`, results go to the validated organizer/inviter, not arbitrary Reply-To or CC addresses. Explicit recipient mappings are available through `WORTLAUT_RESULT_RECIPIENTS`. Results include TXT/VTT/JSON attachments; large results use ZIP or authenticated download instructions. An uncertain SMTP result is marked `delivery_unknown`; explicitly retrying delivery may send a duplicate.

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
