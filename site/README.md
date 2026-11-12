# wortlaut.cloud — Static Product & Open-Source Website

This directory contains the static, bilingual (**English / German**) product and open-source website for **`wortlaut.cloud`** (deployed via GitHub Pages).

## Files

- [`index.html`](index.html) – Landing page in **Astryx Stone Editorial Design** with OpenGraph/Twitter social preview metadata (`social-preview.png`) and 5 sections:
  1. **Hero (`#top`)** – Interactive product preview featuring Executive Summary (optional local Ollama AI), speaker filter chips, live waveform indicator, and 24h audio-snippet verification badges across Google Meet, Microsoft Teams, Cisco Webex, and Zoom.
  2. **How It Works (`#how-it-works`)** – 3-step workflow covering OAuth2 calendar sync / ad-hoc join, transparent presence + live in-call chat opt-out (`opt out` / `nein`), and automatic calendar event writeback.
  3. **Product Workflows (`#features`)** – Interactive tabs for Calendar Sync & Writeback, Ad-hoc Join & 30-Language Qwen3-ASR, Snippet Verification / Inline Editing / Local Ollama Summaries / Exports, and Pre-Mix WebRTC Speaker Separation.
  4. **Privacy, Consent & Security (`#privacy`)** – Self-hosted architecture, live individual chat opt-out, 24h raw-audio / 30d transcript retention, OIDC SSO isolation, and cloud-bot comparison matrix.
  5. **Self-Hosting & Quickstart (`#self-hosting`)** – Copy-ready commands for hardened Docker Compose (+ GPU overlay), OCI Helm Chart (`bundled.enabled=true` zero-dependency evaluation & production cluster), and local/contributor workflows (`make setup-local`, `make test-local`).
- [`styles.css`](styles.css) – Astryx Stone & Emerald design tokens, responsive layout grids, and live waveform animations.
- [`app.js`](app.js) – Bilingual dictionary (`EN` / `DE` with automatic browser locale detection, `localStorage` persistence, and `?lang=en|de` URL override), accessible feature tabs, interactive speaker filter & calendar toggle demos, and copy-to-clipboard buttons.
- [`favicon.svg`](favicon.svg) – `wortlaut` `AudioLines` mark.

## Local Preview

No build step is required — serve `site/` with any static HTTP server:

```bash
python3 -m http.server 8080 --directory site
# -> http://127.0.0.1:8080/?lang=en (English)
# -> http://127.0.0.1:8080/?lang=de (Deutsch)
```

## Deployment (`pages.yml`)

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) automatically publishes `site/` to GitHub Pages whenever changes on `site/**` land on `main`.
