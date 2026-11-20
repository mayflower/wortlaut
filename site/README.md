# wortlaut.cloud — Static Product & Open-Source Website

This directory contains the static, bilingual (**English / German**) product and open-source website for **`wortlaut.cloud`** (deployed via GitHub Pages).

## Design System

Aligned with **`DESIGN.md` ("The Quiet Acoustic Ledger")** and the production Astryx Stone Web-UI (`worker/src/ui/`):
- Warm Stone light (`#fafaf9` / `#ffffff`) and dark (`#111113` / `#181920`) surfaces with a live header theme switch (`?theme=light|dark`).
- Flat hairline-divided sections (`1px solid`), zero nested card-in-card wrappers, zero uppercase eyebrow kickers, and zero rainbow speaker stripes.
- **State-Only Chroma**: Acoustic Emerald (`#059669` / `#10b981`) for active capture, focus, and verified states; Off-the-Record Amber (`#d97706` / `#fbbf24`) exclusively for `#pause` Off-the-Record state.

## Files

- [`index.html`](index.html) – Landing page with 5 sections reflecting **`wortlaut` 0.2.0**:
  1. **Hero (`#top`)** – Interactive Astryx Stone workspace showcase with `Meetings / Calendar / Glossary / MCP / System` sidebar, structured protocol & Decisions with clickable `[HH:MM:SS]` transcript citations, verified screen-share keyframes, interactive speaker filter chips, inline Off-the-Record `#pause` marker, and 24h verification snippets across Google Meet, Microsoft Teams, Cisco Webex, and Zoom.
  2. **How It Works (`#how-it-works`)** – 3-step editorial workflow from OAuth2 calendar sync / on-demand dispatch through the `1280×720` Horizon live video tile to structured protocols, writeback, `Wortlaut.Cloud Robot` mail, and Hybrid RAG MCP indexing.
  3. **Interactive Features (`#features`)** – 5 tabs:
     - **Hybrid RAG & MCP (`/mcp`)** with interactive `search_protocols()` demo (local CPU INT8 ONNX `multilingual-e5-small-int8` + PostgreSQL FTS RRF, 8 OAuth 2.1 tools, native `get_keyframe` PNGs).
     - **Horizon Video Tile & `#pause`** with interactive `16:9` preview toggling between **Recording Active (Emerald)** and **Off the Record `#pause` (Amber)**.
     - **Protocols & Screen-Share Slides** (local Ollama or OpenAI-compatible API with live `/privacy` disclosure, fail-closed camera exclusion, `.md`/`.txt`/`.vtt`/`.json` exports).
     - **Calendar & Writeback** with interactive per-event recording toggle.
     - **Pre-Mix Audio & 30 Languages** (Qwen3-ASR 1.7B, zero voiceprints, domain glossary, 24h verification snippets).
  4. **Privacy & Comparison (`#privacy`)** – Architectural privacy guarantees and side-by-side comparison against typical Cloud SaaS meeting bots.
  5. **Self-Hosting & Quickstart (`#self-hosting`)** – Dark Acoustic Ledger quickstart for Docker Compose (+ GPU overlay), OCI Helm Chart `0.2.0` (`1Gi/4Gi` meeting memory, `bundled.enabled=true`), and MCP client configuration (`claude mcp add` / JSON), plus the v0.2.0 stack overview (Python 3.14, PostgreSQL 17.12, RustFS S3, local ONNX RAG).
- [`styles.css`](styles.css) – Light & Dark Warm Stone tokens, flat hairline layout, interactive Horizon tile styling, and responsive rules.
- [`app.js`](app.js) – Bilingual dictionary (`EN` / `DE`, `?lang=en|de`), Light/Dark theme persistence (`?theme=light|dark`), interactive citation jump, speaker filter, RAG demo, Horizon tile toggle, calendar toggle, tabs, and copy buttons.
- [`favicon.svg`](favicon.svg) – `wortlaut` waveform mark.

## Local Preview

No build step is required — serve `site/` with any static HTTP server:

```bash
python3 -m http.server 8080 --directory site
# -> http://127.0.0.1:8080/?lang=en (English, Light Stone)
# -> http://127.0.0.1:8080/?lang=de (Deutsch, Light Stone)
# -> http://127.0.0.1:8080/?lang=de&theme=dark (Deutsch, Dark Stone)
```

## Deployment (`pages.yml`)

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) automatically publishes `site/` to GitHub Pages whenever changes on `site/**` land on `main`.
