# Changelog

All notable changes to `wortlaut` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **In-Call Off-the-Record Switch (`#pause` / `#resume`) & Live Chat Markers (`#decision` / `#todo`):** Participants in Google Meet, Microsoft Teams, Cisco Webex, and Zoom can pause recording on the spot via `#pause` (zeroing audio in worker RAM, halting screen-share keyframe sampling, and switching the live video tile to an amber **OFF THE RECORD** state) and resume via `#resume` / `#weiter`, or pin human-verified `#decision <text>` and `#todo <text>` markers onto the live video tile, Web-UI timeline, `.md`/`.txt`/`.json` exports, MCP responses, and Ollama summary prompts (with retroactive scrubbing if a participant later opts out).
- **Live `1280×720` WebRTC Conference Video Tile:** Browser workers stream a real-time `1280×720` canvas video feed into conference calls showing recent speaker-attributed transcript turns, live recording/pause status, and on-screen chat command instructions (`DE` / `EN`).
- **Settled Screen-Share Slide Keyframes (`WORTLAUT_ENABLE_KEYFRAMES`):** Captures static PNG snapshots (`<= 1280 × 720`, `<= 60` per recording) strictly from verified screen-share tracks while rejecting participant camera feeds fail-closed, with 30-day S3 retention, single-slide deletion (`DELETE /v1/recordings/{id}/keyframes/{id}`), live presenter opt-out purging, inline Web-UI timeline cards, and MCP binary resources (`wortlaut://recordings/{id}/keyframes/{id}.png`).
- **Authenticated MCP Streamable HTTP Server (`/mcp` + OAuth 2.1):** Built-in Model Context Protocol server with RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata, RFC 7591 Dynamic Client Registration, PKCE `S256`, explicit browser consent, per-user tenant isolation (`mcp:read` / `mcp:write`), and Web-UI client grant management (`/ui#view=mcp`).
- **ASR Domain Glossary & Automatic Overtime Extension:** Added `WORTLAUT_ASR_GLOSSARY` to bias `Qwen3-ASR` system context prompts with custom product/domain vocabulary alongside meeting titles and attendee names, `WORTLAUT_ASR_LANGUAGES` to constrain per-segment language detection (default `German,English`, `*` for all 30 languages), and `WORTLAUT_MAX_OVERTIME_SECONDS` to automatically extend active recordings running past `ends_at`.
- **Automated QA & Security Tooling:** Added `make hooks` / `make qa` (`pre-commit`, Conventional Commits `commit-msg`, and `pre-push` hooks) and continuous security workflows (`security.yml` with Gitleaks, Zizmor, Semgrep, CodeQL, Trivy, `pip-audit`, `npm audit`, and CycloneDX SBOM generation).

### Changed
- **Speech-to-text model:** `wortlaut-asr` now runs **Qwen3-ASR 1.7B** (`Qwen/Qwen3-ASR-1.7B-hf`, Transformers) instead of NVIDIA Parakeet TDT. Supported languages change from Parakeet v3's 25 European languages to Qwen3-ASR's 30 languages; Bulgarian, Croatian, Estonian, Latvian, Lithuanian, Maltese, Slovak, Slovenian, and Ukrainian are no longer transcribed. Transcripts have segment-level times only, and each segment records the detected language.

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
