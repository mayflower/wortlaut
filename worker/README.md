# worker

## Overview
Playwright/Chromium meeting media receiver worker package supporting Webex, Google Meet, and Microsoft Teams per-receiver WebRTC audio capture and build configurations.

## Interface
- `[package.json:scripts]`: `build` (`node scripts/assets.mjs && vite build && vite build --config vite.meet.config.ts && tsc -p tsconfig.worker.json`), `typecheck`, `test`, `start` (`node dist-worker/runtime/main.js`), `test:audio`, `test:meet`, `test:receiver`.
- `[vite.config.ts:default]`: Vite build configuration for the internal SDK receiver page (`base: '/sdk/'`, `target: 'es2022'`).
- `[vite.meet.config.ts:default]`: Vite IIFE library build configuration compiling `src/meet-page.ts` into `dist/meet/capture.js` (`name: 'WortlautMeet'`).
- `[index.html]`: HTML entry point for the internal Webex SDK receiver page loading `/sdk/vendor/meetings.min.js` and `/src/page.ts`.
- Subdirectories:
  - [public](./public/README.md): Browser-side WebRTC encoded audio frame observer worker and `AudioWorklet` 16 kHz mono `s16le` PCM capture processor.
  - [runtime](./runtime/README.md): Node.js/Playwright worker runtime orchestrating meeting attempt claim/bootstrap, sandboxed Chromium and `Xvfb`/`xdotool` lifecycle, and provider-specific join/capture/status loops.
  - [scripts](./scripts/README.md): Build-time asset staging script that copies the pinned Webex Meetings UMD bundle into `public/vendor/`.
  - [src](./src/README.md): In-page browser media capture, 5-second PCM chunking, WebSocket ingest transport, and provider SDK/WebRTC inspection modules.

## Invariants
- `[package.json:dependencies]`: Pins `@alexanderolsen/libsamplerate-js` (`2.1.2`), `playwright` (`1.63.0`), and `webex` (`3.12.0`).
- `[vite.meet.config.ts:default]`: Bundles `src/meet-page.ts` with `publicDir: false` into a self-contained IIFE script `dist/meet/capture.js` for injection into external provider frames.

## Side Effects
- `[package.json:scripts.build]`: Populates `public/vendor/`, `dist/`, `dist/meet/`, and `dist-worker/` build artifacts.

## Verification
- Run: `npm --prefix worker test`
