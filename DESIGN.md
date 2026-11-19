---
name: Wortlaut.cloud
description: Self-hosted, speaker-isolated meeting transcription and protocol workspace
colors:
  emerald-accent: "#059669"
  emerald-signal-dark: "#10b981"
  emerald-ink-dark: "#34d399"
  amber-notice: "#d97706"
  amber-signal-dark: "#fbbf24"
  stone-ground-dark: "#111113"
  stone-surface-dark: "#181920"
  stone-muted-dark: "#23252f"
  stone-border-dark: "#2b2d38"
  stone-ink-dark: "#fafaf9"
  stone-secondary-dark: "#a8a29e"
  stone-tertiary-dark: "#78716c"
  stone-ground-light: "#fafaf9"
  stone-surface-light: "#ffffff"
  stone-border-light: "#e7e5e4"
  stone-ink-light: "#1c1917"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Liberation Sans', sans-serif"
    fontSize: "2.25rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "system-ui, -apple-system, 'Liberation Sans', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "system-ui, -apple-system, 'Liberation Sans', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, 'Liberation Sans', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Liberation Mono', 'DejaVu Sans Mono', ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.stone-ink-light}"
    textColor: "{colors.stone-surface-light}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  chip-speaker:
    backgroundColor: "{colors.stone-surface-dark}"
    textColor: "{colors.stone-ink-dark}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  chip-speaker-active:
    backgroundColor: "{colors.emerald-accent}"
    textColor: "{colors.stone-ink-dark}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  card-dispatch:
    backgroundColor: "{colors.stone-surface-dark}"
    textColor: "{colors.stone-ink-dark}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  keycap-command:
    backgroundColor: "{colors.stone-muted-dark}"
    textColor: "{colors.stone-ink-dark}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
---

# Design System: Wortlaut.cloud

<!-- impeccable:design-map -->
Name: Wortlaut.cloud
Colors: primary: emerald-accent #059669; secondary: amber-notice #d97706; neutral: stone-ground-dark #111113
Fonts: system-ui (display, headline, title, body); Liberation Mono (label)
Spacing: xs 4px, sm 8px, md 16px, lg 24px, xl 32px
Radius: sm 6px, md 8px, lg 12px, pill 999px
North Star: "The Quiet Acoustic Ledger"
Rules:
- The State-Only Chroma Rule. Saturated emerald and amber appear only when proving live capture state, active speech, focus, or Off-the-Record pause—never as decorative card fills or per-speaker rainbow stripes.
- The Gallery-Distance Rule. On the `1280×720` conference video tile, primary status pills and chat command keycaps never drop below `21px` (`~7px` inside a `3×3` grid cell), and headings carry no uppercase eyebrows or kickers.
- The No-Nested-Card Rule. Never place a bordered card inside another bordered card; group subsections with spacing and `1px` horizontal rules.
Elevation:
- Dispatch Bar Rest: 0 2px 10px -4px rgba(15, 23, 42, 0.08)
Don't:
- Don't render colored `border-left` stripes (`> 1px`), nested card-in-card wrappers, or uppercase kicker/eyebrow labels above headings.
- Don't expose internal model names (`Qwen3-ASR`) in everyday operator subtitles where plain domain language ("Spracherkennung") suffices.
- Don't crowd the `1280×720` conference video tile with multi-paragraph transcript walls that become illegible inside a `3×3` gallery grid.
Do:
- Do use `dir="auto"` and `.wl-break-anywhere` on user-authored titles, speaker names, transcript turns, and glossary terms/aliases.
- Do guard async form submissions with a synchronous `useRef` lock alongside loading state, and provide Undo or restore paths for 1-click deletions.
- Do keep bottom-left safe-area clearance (`x < 520, y > 620`) on the `1280×720` conference video tile so provider nameplates never obscure content.
Map: worker/src/ui/
Map: worker/runtime/video-tile.ts
Map: worker/package.json
Full: .impeccable/design-full.md (read a section when you need its detail)
