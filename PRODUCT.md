# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Enterprise, consulting, engineering, energy, and public-sector project teams** running daily meetings across Google Meet, Microsoft Teams, Cisco Webex, and Zoom.
- **Meeting organizers and operators** managing scheduled/ad-hoc recordings, OAuth2 calendar sync, domain glossaries, and shareable protocols in the Wortlaut.cloud Web-UI.
- **In-call meeting participants** who encounter Wortlaut as a live bot tile inside a `2×2` to `3×3` conference gallery grid and need immediate, trustworthy clarity on recording status, who is currently detected speaking, and how to pause or opt out via meeting chat.

## Product Purpose

Wortlaut (`Wortlaut.cloud`) is a self-hosted meeting transcription and protocol platform that captures pre-mix per-participant WebRTC audio streams directly in the conference web client, transcribes each speaker source locally with Qwen3-ASR, captures settled screen-share slide keyframes (never participant cameras, with local face anonymization), and produces structured, speaker-attributed protocols and summaries without sending media to external cloud APIs.

## Positioning

True pre-mix conference session attribution without biometric voiceprints, speaker diarization heuristics, or third-party media cloud APIs — paired with live, zero-login participant self-sovereignty directly inside the conference chat (`no` / `opt out` to purge one's own voice and slides, `#pause` / `#resume` for immediate in-memory Off-the-Record pauses).

## Operating Context

- Runs in the browser (`Wortlaut.cloud` Web-UI built with React and Astryx Design System Stone theme), via OAuth 2.1 MCP clients (`/mcp`), via calendar integrations (Google Calendar, Microsoft 365, IMAP `.ics`), and inside live conference rooms as an automated Chromium participant streaming a `1280×720` (`16:9`) virtual camera canvas (`worker/runtime/video-tile.ts`).
- During live calls, the conference video tile is predominantly viewed scaled down inside a `2×2` to `3×3` gallery grid (`~320×180` to `640×360` CSS pixels) with conference-client participant nameplates overlaid at the bottom-left corner.

## Capabilities and Constraints

- Four conference providers supported in parallel per recording: Google Meet, Microsoft Teams, Cisco Webex, and Zoom.
- Outbound bot microphone is permanently muted; camera feeds of human participants are never recorded.
- Conference video tile (`1280×720` 2D canvas captured via WebRTC) must maintain strict bottom-left nameplate clearance, `4:3` side-crop safety margins, unmistakable Off-the-Record (`#pause`) state, and distance-legible typography at `3×3` gallery scale, with live transcript text kept subordinate to status, active speaker, and chat controls.
- Persistent team (`WORTLAUT_ASR_GLOSSARY` + DB) and personal domain glossaries feed both ASR context and AI summaries while supporting lossless phonetic alias normalization.

## Brand Commitments

- **Brand name**: `Wortlaut.cloud` (`wortlaut`).
- **Incumbent visual identity**: Astryx Stone neutral surfaces paired with emerald brand accent (`#059669` light / `#10b981` & `#34d399` dark) and warm amber (`#f59e0b` / `#fbbf24`) reserved strictly for lobby/waiting and Off-the-Record paused states; flat editorial hierarchy without nested card-in-card chrome.

## Evidence on Hand

- Production Web-UI (`worker/src/ui/`), virtual camera canvas (`worker/runtime/video-tile.ts`), FastAPI meeting & MCP service (`services/meeting/`), and local GPU ASR service (`services/asr/`).
- Real multi-provider WebRTC E2E verification (`worker/test/video-display.test.ts`, `worker/test/chat-controls.test.ts`, `worker/test/sfu-comfort-noise.test.ts`).

## Product Principles

1. **Verifiable session identity over guesswork**: Never fake speaker attribution with voiceprints or mixed-audio heuristics; surface unverified bindings transparently.
2. **Participant agency in the room**: Every participant can see when recording is active or paused and can opt out (`no` / `opt out`) or pause (`#pause` / `#resume`) from the meeting chat without an account.
3. **Calm operational clarity at real viewing scale**: Design every surface for the actual distance and viewport it occupies — especially the `2×2`–`3×3` conference gallery tile where status, active speaker, and chat controls outrank dense text walls.
4. **Minimalism within existing infrastructure**: Favor flat, legible structure and durable self-hosted primitives over decorative chrome or speculative complexity.
