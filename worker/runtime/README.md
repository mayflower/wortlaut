# runtime

## Overview
Node.js and Playwright worker runtime orchestrating meeting attempt claim/bootstrap, sandboxed Chromium and `Xvfb`/`xdotool` lifecycle, and provider-specific join, capture, and status loops for Google Meet, Webex, and Microsoft Teams.

## Interface
- `[browser.ts:MeetInput]`: Input driver interface `{click(locator: Locator): Promise<void>; fill(locator: Locator, text: string): Promise<void>}`.
- `[browser.ts:nativeMeetInput]`: X11 `xdotool` pointer and keyboard input driver for Google Meet prejoin and in-call controls.
- `[browser.ts:launchBrowser]`: Launches headless Playwright Chromium for Webex SDK mode or a regular sandboxed Chromium process over CDP (with `Xvfb` on Linux when `DISPLAY` is unset) for `google_meet`, `teams`, or browser-based `webex`.
- `[http.ts:serviceRequest]`: Idempotent HTTP client with retry and backoff for `/v1/attempts/...` control-plane requests.
- `[main.ts:run]`: Entry point claiming `/v1/attempts/${attemptId}/claim`, fetching `/v1/attempts/${attemptId}/bootstrap`, running provider session lifecycle, renewing guest tokens, and posting `/v1/attempts/${attemptId}/status`.
- `[meet.ts:MeetBootstrap]`: Bootstrap configuration type for `google_meet` attempts.
- `[meet.ts:MeetError]`: Structured provider failure error carrying a machine-readable `reason`.
- `[meet.ts:installMeetCapture]`: Installs `window.wortlautMeetBridge` binding and `RTCPeerConnection` / `RTCDataChannel` init-script hooks (`connections`, `received`, `encodedReserved`, `receiverStreams`, `dataChannels`, `dataMessages`, `onDataMessage`), then evaluates `dist/meet/capture.js` in the verified provider frame.
- `[meet.ts:MeetBrowser]`: Playwright controller for Google Meet prejoin device muting, guest/account join, reCAPTCHA/consent/lobby detection, and capture teardown.
- `[teams-browser.ts:TeamsBootstrap]`: Bootstrap configuration type for `teams` attempts.
- `[teams-browser.ts:TeamsBrowser]`: Playwright controller for Microsoft Teams web client prejoin, sender-track verification, and per-receiver WebRTC audio capture.
- `[webex-browser.ts:WebexBrowserBootstrap]`: Bootstrap configuration type for browser-based `webex` attempts.
- `[webex-browser.ts:WebexBrowser]`: Playwright controller for `https://web.webex.com/meeting` iframe join and capture.

## Invariants
- `[main.ts:run]`: Requires `WORTLAUT_API_URL`, `WORTLAUT_ATTEMPT_ID`, and `WORTLAUT_BOOTSTRAP_CREDENTIAL` environment variables; enforces `https:` provider URLs without credentials and validates provider-specific hostnames and paths.
- `[main.ts:run]`: Reports `participation: 'ended'` only after `browser.close()` completes; upgrades `normal` end reason to `audio_drain_incomplete` if `diagnostics.drained === false`.
- `[main.ts:run]`: Never logs raw SDK error messages or tokens on failure; logs only stack locations matching `/app/worker/dist-worker/...`.
- `[http.ts:serviceRequest]`: Disallows HTTP redirects (`redirect: 'error'`) and retries only transient errors or HTTP status codes `408`, `429`, `500`, `502`, `503`, `504` up to `Math.min(Date.now() + 120000, deadline)`.
- `[meet.ts:installMeetCapture]`: Rejects bridge messages with `MeetError('browser_bridge_rejected')` unless frame origin/path, `attempt_id`, `meeting_id`, `16000` Hz mono `pcm_s16le` format, UUID `stream_id`/`epoch`, control frame type (`stream_begin`, `bind`, `stream_end`, `gap`), active stream cap (`<= 64`), and base64 chunk bounds (`<= 80000` samples) match.
- `[meet.ts:MeetBrowser.join]`: Refuses to join unless both microphone and camera send controls are confirmed off (or permissions are denied with no matching media devices) and detects visible reCAPTCHA challenges as `human_verification_required` without interacting with them.
- `[teams-browser.ts:TeamsBrowser.disableDevices]` & `[teams-browser.ts:TeamsBrowser.join]`: Aborts with `teams_sending_device_active` if any `RTCPeerConnection` sender has a live enabled track, hooks `RTCPeerConnection` (`receiverStreams`) and `RTCDataChannel` (`dataChannels`, `dataMessages`, `onDataMessage`) to bind or rebind incoming WebRTC audio receivers (`attribution_unknown: false` when signaled, falling back to `attribution_unknown: true` when unverified), and forwards `participant_sources` in status snapshots.

## Side Effects
- `[browser.ts:launchBrowser]`: Spawns `Xvfb` and `chromium` child processes, allocates temporary profile directories `/tmp/wortlaut-meet-*`, connects Playwright over local CDP, and removes the temporary profile on disconnect.
- `[browser.ts:nativeMeetInput]`: Executes `xdotool` child processes against the browser's `DISPLAY` to raise/focus windows and synthesize curved pointer movements, clicks, and keystrokes.
- `[main.ts:run]`: Performs HTTP requests to `/v1/attempts/${attemptId}/claim`, `/v1/attempts/${attemptId}/bootstrap`, and `/v1/attempts/${attemptId}/status`, registers `SIGTERM`/`SIGINT` handlers, and sets `process.exitCode`.
- `[meet.ts:MeetBrowser]`: Opens WebSocket audio ingest streams via `AudioTransport` to `/v1/attempts/${bootstrap.attempt_id}/audio` and mutates browser DOM state via Playwright.
- `[webex-browser.ts:WebexBrowser]`: Opens WebSocket audio ingest streams via `AudioTransport` to `/v1/attempts/${bootstrap.attempt_id}/audio` and interacts with the `https://web.webex.com/meeting` iframe.

## Verification
- Run: `npm --prefix worker test`
