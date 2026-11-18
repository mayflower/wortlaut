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

## Overview

**Creative North Star: "The Quiet Acoustic Ledger"**

Wortlaut.cloud pairs the calm editorial restraint of an archival minutes ledger with live acoustic telemetry. Across both the Astryx Stone web workspace (`worker/src/ui/`) and the `1280×720` WebRTC conference video tile (`worker/runtime/video-tile.ts`), neutral Stone grounds carry the structure through `1px` hairlines and clear typographic scale rather than nested card boxes or decorative gradients.

Color acts strictly as state proof: emerald (`--wl-accent`) signals active speech capture and verified brand presence, while warm amber (`--wl-warn-text`) appears exclusively when a bot waits for host admission or a participant pauses capture Off-the-Record (`#pause`). Cold navy-slate cards, rainbow speaker side-stripes, and model-name jargon are explicitly rejected.

**Key Characteristics:**
- Warm-neutral Stone surfaces (`light` / `dark` / `system`) built on `@astryxdesign/core` and `@astryxdesign/theme-stone`.
- Flat editorial sectioning divided by `1px` hairlines (`var(--color-border)`), reserving elevated containers for primary input bars (`.wl-dispatch-bar`).
- Emerald acoustic signal (`#059669` light / `#10b981` & `#34d399` dark) for live voice waveforms, focus rings, and active speaker states.
- Distance-legible conference video tile (`Ruhiger Sprach-Horizont`) engineered for `2×2`–`3×3` gallery grids.

## Colors

Warm Stone neutrals hold 90%+ of every viewport so emerald and amber state signals read unmistakably at a glance.

### Primary
- **Acoustic Emerald** (`#059669` light / `#10b981` & `#34d399` dark, `--wl-accent`): Live audio activity waveforms, activerecording status badges, focus-visible outlines, text selection highlights, and active speaker filters.

### Secondary
- **Off-the-Record Amber** (`#b45309` / `#d97706` light, `#fbbf24` dark, `--wl-warn-text`): Reserved strictly for waiting-room admission banners, Off-the-Record `#pause` states, and inline validation alerts.

### Neutral
- **Stone Ground** (`#fafaf9` light / `#111113` dark): Root workspace and conference video-tile canvas ground.
- **Stone Surface** (`#ffffff` light / `#181920` dark, `var(--color-background-surface)`): Primary reading plane, dispatch bars, and list rows.
- **Stone Hairline** (`#e7e5e4` light / `#2b2d38` dark, `var(--color-border)`): `1px` structural dividers and pill strokes.
- **Stone Ink & Secondary** (`#1c1917` / `#fafaf9` primary; `#a8a29e` secondary; `#78716c` tabular timestamps).

### Named Rules
**The State-Only Chroma Rule.** Saturated emerald and amber appear only when proving live capture state, active speech, focus, or Off-the-Record pause—never as decorative card fills or per-speaker rainbow stripes.

## Typography

**Display & Body Font:** Astryx Stone workhorse sans / `system-ui, -apple-system, 'Liberation Sans', sans-serif`
**Label/Mono Font:** `'Liberation Mono', 'DejaVu Sans Mono', ui-monospace, monospace`

**Character:** Unornamented, high-x-height grotesque tuned for dense multilingual transcripts (`dir="auto"`, 30 ASR languages) and compressed `720p` WebRTC video streams, paired with crisp monospace for timestamps and literal chat commands (`no`, `opt out`, `#pause`, `#resume`).

### Hierarchy
- **Display** (700, `36px–48px`, `1.15`): Active speaker readout on the `1280×720` conference horizon tile and landing hero.
- **Headline** (700, `20px–28px`, `1.25`, `text-wrap: balance`): Workspace view headers (`Aufnahmen`, `Kalender`, `Glossar`, `MCP`, `System`) and protocol titles.
- **Title** (600, `14px–16px`, `1.35`): Speaker turn headers, glossary canonical terms, and table leads.
- **Body** (400, `14px` web / `20.5px` video tile, `1.6`, max `72ch`): Verbatim transcript paragraphs and executive summaries.
- **Label** (500–700, `12px–15px` web / `21.5px` video keycaps, `tabular-nums`): Wall-clock timestamps, speaker share percentages, and chat command keycaps.

### Named Rules
**The Gallery-Distance Rule.** On the `1280×720` conference video tile, primary status pills and chat command keycaps never drop below `21px` (`~7px` inside a `3×3` grid cell), and headings carry no uppercase eyebrows or kickers.

## Layout

Workspace views center inside `.wl-page-container` (`max-width: 1040px`, `margin-inline: auto`) within Astryx `AppShell` (collapsible `SideNav` for operators, compact `ReaderTopBar` for shared read-only links). Reading sections flow vertically with `1px` bottom dividers rather than nested cards. On the `1280×720` conference video tile, `84px` horizontal margins protect against `4:3` side cropping and keep `x < 520, y > 620` clear for conference-client participant nameplates.

## Elevation & Depth

Surfaces are flat by default, relying on `1px` Stone borders and subtle surface value steps rather than drop shadows. Only `.wl-dispatch-bar` carries a soft low-elevation ambient shadow to distinguish the primary action bar from static list content.

### Shadow Vocabulary
- **Dispatch Bar Rest** (`box-shadow: 0 2px 10px -4px rgba(15, 23, 42, 0.08)` light / `0 4px 16px -6px rgba(0, 0, 0, 0.28)` dark): Primary URL dispatch and glossary quick-add bars.

### Named Rules
**The No-Nested-Card Rule.** Never place a bordered card inside another bordered card; group subsections with spacing and `1px` horizontal rules.

## Shapes

Controls use restrained, functional radii: `6px–8px` on inputs and chat command keycaps, `8px–12px` on `.wl-dispatch-bar` and list containers, `50%` circles on speaker initial avatars, and `999px` full pills on status badges and speaker filter chips.

## Components

### Buttons
- **Shape:** Pill / rounded Astryx `Button` (`size="sm"` default in workspace toolbars).
- **Primary:** High-contrast Stone ink fill (`#1c1917` in light, `#fafaf9` in dark) for singular view actions (`Neue Aufnahme`, `Hinzufügen`, `Speichern`).
- **Hover / Focus:** `2px solid var(--wl-accent)` focus-visible ring with `2px` offset.
- **Secondary / Ghost:** Hairline-bordered secondary for peer actions (`Teilen`, `Export`, `Liste kopieren`); ghost for row-level `Edit3` / `Trash2` icon actions spaced at least `8px` (`gap={2}`) apart.

### Chips
- **Style:** `.wl-speaker-chip` (`999px` radius, `1px solid var(--color-border)`, `5px 11px` padding, `13px` medium text with `tabular-nums` speech-share percentage).
- **State:** Active filter shifts border to `var(--wl-accent)` and background to `var(--wl-accent-bg)`.

### Cards / Containers
- **Corner Style:** `12px` on `.wl-dispatch-bar`; `8px` on flush divided row lists; `10px` on `.wl-live-card` / `.wl-lobby-card`.
- **Background:** `var(--color-background-surface)`.
- **Shadow Strategy:** Flat except `.wl-dispatch-bar` (`--wl-dispatch-shadow`).
- **Border:** `1px solid var(--color-border)`, shifting to `var(--wl-accent)` on `:focus-within`.
- **Internal Padding:** `14px 16px` on dispatch bars; `10px 16px` on compact list rows.

### Inputs / Fields
- **Style:** Astryx `TextInput` (`size="sm"`) with `1px` Stone border and visible accessible labels.
- **Focus:** `var(--wl-accent)` caret and border highlight.
- **Error / Disabled:** Inline `role="alert"` message in `var(--wl-warn-text)`; never silently discard typed text when sibling inputs change state.

### Navigation
- **Style:** Left collapsible Astryx `SideNav` (`Aufnahmen`, `Kalender`, `Glossar`, `MCP`, `System`) with live count `Token` badges, `⌘K` `CommandPalette` accelerator, and footer theme/locale switches (`DE`/`EN`, `Hell`/`Dunkel`/`Auto`).

### Acoustic Horizon Video Tile (`worker/runtime/video-tile.ts`)
- **Structure:** `1280×720` Stone canvas with top brand/status header, two-group `21.5px` monospace chat keycap band (`no` / `opt out` and `#pause` / `#resume`), centered active-speaker display over a full-width emerald horizon line blooming into 11 voice-reactive wave bars, and a single subordinate latest-statement quote line clearing the bottom-left nameplate.

## Do's and Don'ts

### Do:
- **Do** use `dir="auto"` and `.wl-break-anywhere` on user-authored titles, speaker names, transcript turns, and glossary terms/aliases.
- **Do** guard async form submissions with a synchronous `useRef` lock alongside loading state, and provide Undo or restore paths for 1-click deletions.
- **Do** keep bottom-left safe-area clearance (`x < 520, y > 620`) on the `1280×720` conference video tile so provider nameplates never obscure content.

### Don'ts:
- **Don't** render colored `border-left` stripes (`> 1px`), nested card-in-card wrappers, or uppercase kicker/eyebrow labels above headings.
- **Don't** expose internal model names (`Qwen3-ASR`) in everyday operator subtitles where plain domain language ("Spracherkennung") suffices.
- **Don't** crowd the `1280×720` conference video tile with multi-paragraph transcript walls that become illegible inside a `3×3` gallery grid.
