# Changelog

All notable changes to `wortlaut` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Hybrid RAG MCP Search (`search_protocols`):** Semantic + lexical cross-recording protocol search over `/mcp` powered by a bundled local INT8 ONNX embedding model (`multilingual-e5-small-int8`) and PostgreSQL `tsvector` with Reciprocal Rank Fusion (`RRF`), strict per-tenant isolation, pause-window exclusion, optional glossary/LLM query expansion, and synchronous chunk purging on opt-out, keyframe deletion, rejoin, and retention expiry.
- **OpenAI-Compatible LLM Summaries & Query Expansion:** Optional OpenAI-compatible chat completions backend (`WORTLAUT_OPENAI_BASE_URL`, `WORTLAUT_OPENAI_API_KEY`, `WORTLAUT_OPENAI_MODEL`, `WORTLAUT_OPENAI_TIMEOUT_SECONDS`) alongside local Ollama, with dynamic `/privacy` disclosure when external endpoints are configured.
- **Structured Decisions, Clickable Timestamp Citations & Visual Screen Context:** Protocol summaries extract explicit decisions with clickable `[HH:MM:SS]` transcript deep-links and integrate visual context captured from settled screen-share keyframes.
- **In-Call Off-the-Record Switch (`#pause` / `#resume`):** Participants in Google Meet, Microsoft Teams, Cisco Webex, and Zoom can pause recording on the spot via `#pause` (zeroing audio in worker RAM, halting screen-share keyframe sampling, recording `pause_windows`, and switching the live video tile to an amber **OFF THE RECORD** state) and resume via `#resume` / `#weiter`.
- **Live `1280×720` WebRTC Conference Video Tile:** Browser workers stream a real-time `1280×720` (`16:9` widescreen) canvas video feed into conference calls showing recent speaker-attributed transcript turns, live audio activity VU meter (`Ton wird aufgezeichnet` / `Recording audio`), recording/pause status, and on-screen chat command instructions (`"no"` / `"opt out"` & `#pause` / `#resume`).
- **Settled Screen-Share Slide Keyframes (`WORTLAUT_ENABLE_KEYFRAMES`):** Captures static PNG snapshots (`<= 1280 × 720`, `<= 60` per recording) strictly from verified screen-share tracks while rejecting participant camera feeds fail-closed, with 30-day S3 retention, single-slide deletion (`DELETE /v1/recordings/{id}/keyframes/{id}`), live presenter opt-out purging, inline Web-UI timeline cards, and MCP binary resources (`wortlaut://recordings/{id}/keyframes/{id}.png`).
- **Authenticated MCP Streamable HTTP Server (`/mcp` + OAuth 2.1):** Built-in Model Context Protocol server with RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata, RFC 7591 Dynamic Client Registration, PKCE `S256`, explicit browser consent, per-user tenant isolation (`mcp:read` / `mcp:write`), and Web-UI client grant management (`/ui#view=mcp`).
- **30-Language Qwen3-ASR Support & Domain Glossary:** Enabled all **30 Qwen3-ASR languages** out of the box (`WORTLAUT_ASR_LANGUAGES=*`), added per-recording language selection and live switching across the Web-UI, REST API (`POST`/`PATCH /v1/recordings`), and MCP (`schedule_recording` / `update_protocol`) with `X-ASR-Languages` forwarding, plus `WORTLAUT_ASR_GLOSSARY` vocabulary prompting and `WORTLAUT_MAX_OVERTIME_SECONDS` overtime extension.
- **Automated QA & Security Tooling:** Added `make hooks` / `make qa` (`pre-commit`, Conventional Commits `commit-msg`, and `pre-push` hooks) and continuous security workflows (`security.yml` with Gitleaks, Zizmor, Semgrep, CodeQL, Trivy, `pip-audit`, `npm audit`, and CycloneDX SBOM generation).

### Changed
- **Runtime & Dependency Upgrades:** Upgraded `wortlaut-meeting` to **Python 3.14** (`python:3.14-slim-trixie`), updated PostgreSQL manifests to `postgres:17.12-bookworm`, bumped `wortlaut` Helm chart & package versions to `0.2.0` (including OpenAI-compatible LLM values and `1Gi`/`4Gi` meeting memory limits for local ONNX RAG), and refreshed locked Python/Node dependencies.
- **Branded Email Sender Name:** Outgoing SMTP emails now default to the RFC 5322 display name `"Wortlaut.Cloud Robot"` when `WORTLAUT_SMTP_FROM` is configured as a bare address (while keeping envelope `MAIL FROM` and UI `botEmail` as the pure address, and preserving explicit display names).
- **Streamlined MCP Tool Surface:** Consolidated MCP tools to 8 focused operations (`list_recordings`, `search_protocols`, `get_recording`, `get_transcript`, `get_keyframe`, `schedule_recording`, `cancel_recording`, `update_protocol`) with concise structured responses.
- **All four conference platforms enabled by default:** Google Meet (`WORTLAUT_ENABLE_GOOGLE_MEET`), Microsoft Teams (`WORTLAUT_ENABLE_TEAMS`), Cisco Webex (`WORTLAUT_ENABLE_WEBEX_BROWSER`), and Zoom (`WORTLAUT_ENABLE_ZOOM`) are now enabled by default (`true`) across `Settings`, Docker Compose, Helm (`charts/wortlaut`), and local mode (`scripts/run-local.sh`); individual providers can still be disabled explicitly via `false`.
- **Speech-to-text model:** `wortlaut-asr` now runs **Qwen3-ASR 1.7B** (`Qwen/Qwen3-ASR-1.7B-hf`, Transformers) instead of NVIDIA Parakeet TDT. Supported languages change from Parakeet v3's 25 European languages to Qwen3-ASR's 30 languages; Bulgarian, Croatian, Estonian, Latvian, Lithuanian, Maltese, Slovak, Slovenian, and Ukrainian are no longer transcribed. Transcripts have segment-level times only, and each segment records the detected language.

### Fixed
- **Zoom WebClient Speaker Binding & Screen-Share Keyframes:** Parsed nested `worker:zoom` envelopes (`evt 4098`, `evt 7937` with Base64url `dn2` + `audioSsrc`, `evt 20225`), bound isolated `<audioSsrc>+CS+` WebRTC receivers deterministically to provider participant IDs, and added `<video>` share-surface keyframe capture with strict camera exclusion.
- **Webex Initial-Turn Speaker Binding:** Prevented mid-utterance `forceReattach` from dropping initial Webex speaker bindings before the first audio chunk flushes.
- **Web-UI & Protocol Accuracy (#15, #16, #17, #18):** Fixed wall-clock recording duration calculation instead of summing per-speaker audio time, deduplicated speakers across multiple provider IDs, synchronized live speaker pills with the speaker overview, and aligned glossary sidebar counts with visible entries.

## [0.1.0] - 2026-11-10

### Added
- **Multi-Provider Per-Speaker Conference Capture:** Parallel support for **Google Meet**, **Microsoft Teams**, **Cisco Webex**, and **Zoom** in a single instance using Playwright/Chromium and isolated pre-mix WebRTC `RTCRtpReceiver` audio capture (no biometric voiceprints or speaker diarization).
- **Self-Hosted Speech-to-Text (`wortlaut-asr`):** Shared GPU inference service powered by NVIDIA NeMo Parakeet TDT models, supporting both the German fine-tune (`primeline/parakeet-primeline`, `2.95%` WER) and multilingual **NVIDIA Parakeet TDT 0.6B v3** (`nvidia/parakeet-tdt-0.6b-v3`, 25 European languages) with optional CPU fallback (`WORTLAUT_ASR_ALLOW_CPU=true`).
- **OAuth2 Calendar Sync & Automatic Protocol Writeback:** Direct Google Calendar (`calendar.events`) and Microsoft 365 / Graph (`Calendars.ReadWrite`) integration with automatic scheduling for self-organized meetings, 1-click toggles for external invites, and automatic writeback of read-only transcript links (`wortlaut-read-…`) into calendar invite descriptions.
- **Live In-Call Chat Opt-Out:** Participants can type `opt out`, `optout`, `no`, or `nein` in the conference chat at any time during a live call to immediately discard their audio stream and purge any statements already captured from them.
- **Self-Contained Web-UI (`de` / `en`):** Bilingual German & English operator and reader interface with full-text search, speaker speaking-share bars, click-to-listen isolated audio snippet verification, domain term replacements, optional local **Ollama** executive summaries & action items, and exports in `.md`, `.txt`, `.vtt`, and `.json`.
- **OIDC Multi-Tenant Authentication & Scoped Reader Links:** Authorization Code + PKCE login (Dex, Keycloak, Authentik, Zitadel, Microsoft Entra ID, Google) with per-organizer isolation and HMAC-scoped read-only sharing tokens.
- **Flexible Deployment Targets:**
  - Hardened [`docker-compose.yml`](docker-compose.yml) (non-root `meeting` container via isolated `docker-socket-proxy` over TCP) + [`docker-compose.gpu.yml`](docker-compose.gpu.yml).
  - Production & zero-dependency evaluation Helm chart ([`charts/wortlaut`](charts/wortlaut/README.md), including `--set bundled.enabled=true` with embedded PostgreSQL 17, RustFS S3, and persistent auto-generated Secrets).
  - Multi-arch (`linux/amd64`, `linux/arm64`) `wortlaut-meeting` container images and OCI Helm chart publishing in [`.github/workflows/release.yml`](.github/workflows/release.yml).
  - Local contributor workflow (`make setup-local` / `make test-local`) requiring zero Kubernetes cluster access.
