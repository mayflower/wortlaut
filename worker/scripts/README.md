# scripts

## Overview
Build-time asset staging script that copies the pinned Webex Meetings UMD bundle into `public/vendor/`.

## Interface
- `[assets.mjs]`: Build script copying `node_modules/webex/umd/meetings.min.js` to `public/vendor/meetings.min.js`.

## Invariants
- `[assets.mjs]`: Expects `node_modules/webex/umd/meetings.min.js` to be present prior to Vite bundling.

## Side Effects
- `[assets.mjs]`: Creates directory `public/vendor` (`recursive: true`) and writes `public/vendor/meetings.min.js` on the local filesystem.

## Verification
- Run: `npm --prefix worker test`
