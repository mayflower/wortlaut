---
name: provider-driver
description: Architectural invariants and verification checklist when modifying Google Meet, Microsoft Teams, Cisco Webex, or Zoom browser capture drivers in worker/.
---

# Conference Provider Driver Invariants

Load this skill before editing `worker/runtime/*.ts`, `worker/src/*.ts`, or `worker/test/*.ts` for any conference provider (`google_meet`, `teams`, `webex`, `zoom`).

## Non-Negotiable Architecture Rules

1. **Isolated Pre-Mix Audio Only:** Capture separate incoming WebRTC receiver tracks (`RTCRtpReceiver`) before conference mixing. Never substitute mixed-audio diarization, voiceprints, or active-speaker name heuristics.
2. **Verified Participant Binding:** Speaker identity is the verified provider participant session. Missing display names are acceptable when participant binding is preserved; anonymous source labels without participant binding must surface `attribution_unknown: true`.
3. **Parallel Multi-Provider Isolation:** All four providers run side-by-side in the same instance (selected per recording). Missing credentials or broken selectors in one provider must never affect the others.
4. **Fail-Closed Slide Keyframes:** Only capture settled static PNG snapshots (`<= 1280x720`) from verified screen-share tracks (`WORTLAUT_ENABLE_KEYFRAMES=true`). Participant camera feeds and `wortlaut`'s own self-tile must always be rejected fail-closed.
5. **In-Call Controls:** Preserve live chat opt-out (`no`, `opt out`, `optout`, `stop`, `nein`) and off-the-record pause/resume (`#pause`/`#resume`) — pausing zeroes PCM in worker RAM, halts slide sampling, and switches the 1280×720 video tile to amber `OFF THE RECORD`.

## Mandatory Build & Verification Steps

After editing any file under `worker/src/` or `worker/runtime/`:

```sh
npm --prefix worker run build
npm --prefix worker run typecheck
npm --prefix worker run lint
npm --prefix worker run knip
npm --prefix worker test
```

When touching audio capture or Meet page injection specifically, also run:
```sh
npm --prefix worker run test:audio
npm --prefix worker run test:meet
```
