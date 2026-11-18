---
version: 1
slug: "worker-runtime-video-tile-ts"
primary_target: "worker/runtime/video-tile.ts"
related_targets: []
---

# Conference Video Tile (`worker/runtime/video-tile.ts`)

- **Mode**: `operate`
- **Scope**: Outbound `1280×720` (`16:9`) virtual camera canvas streamed via WebRTC into Google Meet, Microsoft Teams, Cisco Webex, and Zoom rooms; primarily viewed inside a `2×2` to `3×3` gallery grid (`~320×180` to `640×360` CSS pixels) with conference-client participant nameplates overlaid at bottom-left.
- **Job**: Give every meeting participant calm, distance-legible certainty on recording state, who is currently detected speaking, and how to pause (`#pause` / `#resume`) or opt out (`no` / `opt out`) via meeting chat, while keeping transcript text subordinate.
- **Constraints**: Bottom-left nameplate safe zone (`x < 520, y > 620`), `84px` horizontal `4:3` crop clearance, zero outbound audio, unmistakable amber Off-the-Record state, no eyebrow/kicker labels above headings, and WebRTC receiver frame-burst reliability.

## Direction contract

- **THESIS**: A calm acoustic horizon tile where live recording status, active speaker presence, and distance-legible chat commands lead, refusing the cramped multi-paragraph scrolling transcript box that turns unreadable inside a `3×3` conference grid.
- **OWN-WORLD**: Astryx Stone dark neutral ground (`#111113` to `#151518`), `1px` Stone hairlines (`rgba(255,255,255,0.08)`), high-contrast monospace chat keycaps (`no`, `opt out`, `#pause`, `#resume`), emerald live-voice horizon (`#10b981` / `#34d399`), and warm amber (`#f59e0b` / `#fbbf24`) reserved strictly for lobby and Off-the-Record states.
- **STORY**: Meeting participants recognize at a glance that Wortlaut is recording (or paused Off-the-Record), see whose isolated WebRTC track is currently active, know the exact two-word chat commands to opt out or pause without leaving the call, and see a quiet subordinate proof line of the latest transcribed sentence.
- **FIRST VIEWPORT**: Single `1280×720` widescreen frame: top header (`y: 44..108`) pairs the emerald `AudioLines` mark, `Wortlaut.cloud` + meeting/inviter subtitle on the left with a high-contrast status pill (`Aufzeichnung aktiv` / `Off the Record` / `Wartet im Warteraum`) on the right; upper command band (`y: 120..186`) displays two large, `3×3`-legible chat keycap groups (`no` / `opt out` and `#pause` / `#resume`); spacious central stage (`y: 210..475`) centers the large active speaker name (or calm listening/paused state) directly above a full-width emerald acoustic horizon line whose center blooms into live voice-reactive bars; lower right-aligned subordinate proof zone (`y: 504..596`, clearing the bottom-left nameplate) renders at most the latest 1–2 lines of recognized speech with circular speaker initials and timestamp.
- **FORM**: Ruhiger Sprach-Horizont, #6 of 7, seed:8e72008158689425.
- **FINISH**: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
