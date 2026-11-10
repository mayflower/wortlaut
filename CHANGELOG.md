# Changelog

All notable changes to `wortlaut` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
