(function () {
  "use strict";

  const I18N = {
    en: {
      page_title: "wortlaut.cloud — Speaker-Accurate Meeting Protocols & MCP Memory. 100% Self-Hosted.",
      meta_desc:
        "wortlaut.cloud joins Google Meet, Microsoft Teams, Cisco Webex, and Zoom, captures isolated per-speaker audio and screen-share slides, produces structured protocols with timestamp citations, and connects meetings via Hybrid RAG MCP — 100% self-hosted under GNU AGPL-3.0.",
      nav_how: "How it works",
      nav_features: "Features",
      nav_privacy: "Privacy",
      nav_selfhost: "Self-Hosting",
      cta_github: "GitHub",
      cta_install: "Get Started",

      hero_title_html:
        'Speaker-accurate meeting protocols.<br><span class="hero-subline">100% on your own infrastructure.</span>',
      hero_subtitle:
        "wortlaut joins Google Meet, Microsoft Teams, Cisco Webex, and Zoom with a transparent live video tile, captures isolated per-speaker audio and screen-share slides, produces structured protocols with clickable timestamp citations, and connects every meeting to your AI tools via Hybrid RAG MCP.",
      hero_cta_primary: "Self-Host for Free",
      hero_cta_secondary: "Explore Features",
      hero_meta_html:
        '<span>GNU AGPL-3.0</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>Zero Voiceprints</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>30 Languages</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>Local Hybrid RAG &amp; MCP</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>v0.2.0</span>',
      platforms_label: "Runs side-by-side in one instance across all four platforms:",

      ui_window_url: "wortlaut.cloud / meetings / q2-architecture-review",
      ui_badge_done: "Linked in calendar invite",
      ui_nav_meetings: "Meetings",
      ui_nav_calendar: "Calendar",
      ui_nav_glossary: "Glossary",
      ui_nav_system: "System",
      ui_live_indicator: "1 active recording",
      ui_sidebar_note: "Local ONNX RAG · AGPL-3.0",

      ui_meeting_title: "Q2 Architecture & Release Review",
      ui_meeting_date: "Today, 14:00",
      ui_meeting_dur: "38 min · EN",
      ui_meeting_verified: "3 isolated speaker tracks",
      ui_btn_share: "Share",

      ui_protocol_title: "Structured Protocol & Decisions",
      ui_protocol_engine: "Ollama / OpenAI-compatible · Click timestamp to verify",
      ui_summary_text:
        "The team confirmed the v0.2.0 Helm rollout on Kubernetes 1.32 with 4 GiB memory for local ONNX RAG embeddings, and finalized screen-share slide capture with fail-closed camera exclusion.",
      ui_dec_1: "Ship Helm chart 0.2.0 with local CPU ONNX Hybrid RAG enabled by default.",
      ui_dec_2: "Expose all 8 MCP tools and slide PNG keyframes over OAuth 2.1 PKCE at /mcp.",

      ui_slides_title: "Screen-Share Keyframes (2)",
      ui_slides_meta: "Share track verified · Participant cameras excluded · 30d TTL",
      ui_slide_1_title: "Hybrid RAG & MCP Topology",
      ui_slide_2_title: "v0.2.0 Rollout & OAuth 2.1 Checklist",

      ui_filter_all: "All (3)",
      ui_filter_hint: "Filter by speaker · 24h audio check",
      ui_turn_1:
        "Let’s lock Helm chart 0.2.0 with local CPU ONNX embeddings on by default. Because each speaker track is isolated pre-mix, decisions stay accurately attributed even when two people talk at once.",
      ui_otr_marker:
        "Off the Record (#pause) — Audio buffers zeroed in RAM and slide capture halted",
      ui_turn_2:
        "We resumed with #resume right after the salary discussion. All temporary verification snippets still auto-expire after 24 hours and participant cameras stay strictly excluded from keyframes.",
      ui_turn_3:
        "Agreed — let’s expose all 8 MCP tools and native PNG slide keyframes over OAuth 2.1 PKCE at /mcp so Claude, Cursor, and Antigravity can search every decision with citations.",

      how_title: "Three steps from calendar invite to searchable meeting memory",
      how_desc:
        "No browser extensions for participants, no per-seat cloud SaaS, and no opaque voiceprint profiles.",
      step1_title: "Connect calendars or dispatch on demand",
      step1_desc:
        "Link Google Calendar or Microsoft 365 via OAuth2 PKCE (or IMAP/.ics), toggle auto-recording per event with one click, or paste any Meet, Teams, Webex, or Zoom link directly into the workspace.",
      step2_title: "Transparent live join & isolated capture",
      step2_desc:
        "wortlaut joins with a 1280×720 Horizon video tile showing active speaker and chat controls. It records each participant’s pre-mix WebRTC audio track and verified screen-share slides, while #pause and opt out act instantly.",
      step3_title: "Structured protocol, writeback & MCP search",
      step3_desc:
        "Local 30-language speech recognition and Ollama or OpenAI-compatible protocol synthesis write decisions with [HH:MM:SS] citations back into your calendar invite, send summary mail via Wortlaut.Cloud Robot, and index everything for Hybrid RAG MCP.",

      feat_title: "Built for sovereign teams, verifiable records, and AI workflows",
      feat_desc:
        "Inspect every layer of wortlaut.cloud 0.2.0 — from local Hybrid RAG MCP search to the in-call Horizon video tile.",
      ftab_mcp: "Hybrid RAG & MCP",
      ftab_horizon: "Horizon Tile & #pause",
      ftab_protocol: "Protocols & Slides",
      ftab_calendar: "Calendar & Writeback",
      ftab_audio: "Pre-Mix Audio & 30 Langs",

      fmcp_title: "Search every meeting decision directly from your AI client",
      fmcp_lead:
        "Expose your self-hosted meeting archive over Streamable HTTP MCP at /mcp with OAuth 2.1 PKCE. Hybrid retrieval fuses local CPU INT8 ONNX semantic embeddings with PostgreSQL full-text search via Reciprocal Rank Fusion — zero external vector database required.",
      fmcp_b1:
        "Local multilingual-e5-small-int8 embeddings on CPU + PostgreSQL tsvector across decisions, action items, summaries, slides, and transcripts.",
      fmcp_b2:
        "8 focused MCP tools: list_recordings, search_protocols, get_recording, get_transcript, get_keyframe (native PNG ImageContent), schedule_recording, cancel_recording, and update_protocol.",
      fmcp_b3:
        "Strict per-user access scoping via Dex OIDC + revocable OAuth 2.1 grants directly in the MCP workspace view.",
      rag_q_helm: '"Helm rollout & memory"',
      rag_q_otr: '"Off-the-Record policy"',
      rag_q_slides: '"Architecture slide PNG"',

      fhor_title: "Visible presence, live #pause, and instant speaker opt-out",
      fhor_lead:
        "Participants never wonder whether a meeting is being recorded. wortlaut renders a clean 1280×720 Acoustic Horizon video tile engineered for 3×3 gallery grids, showing active speaker telemetry and literal chat commands at a glance.",
      fhor_b1:
        "Type #pause (#pause / #resume) in the meeting chat for immediate Off-the-Record mode: audio PCM buffers are zeroed in RAM and slide capture stops instantly.",
      fhor_b2:
        "Type no or opt out to permanently exclude your own voice and shared slides — existing utterances, audio, keyframes, and RAG chunks are purged immediately.",
      fhor_b3:
        "State-Only Chroma: Emerald signals active capture; warm Amber signals Off-the-Record pause or waiting-room admission.",
      fhor_preview_label: "Interactive 1280×720 video tile preview",
      ht_mode_live: "Recording Active",
      ht_mode_pause: "Off the Record (#pause)",
      ht_sub: "Q2 Architecture Review · Invited by Anna Weber",
      ht_status_live: "Recording active",
      ht_status_paused: "Off the Record",
      ht_cmd_optout: "Exclude your voice",
      ht_cmd_otr: "Off-the-Record in chat",
      ht_speaking_sub: "Speaking now · Isolated WebRTC audio track",
      ht_pause_title: "OFF THE RECORD · Recording paused",
      ht_pause_desc:
        "Spoken audio and shared screens are discarded immediately and never stored.",
      ht_pause_hint: 'Type "#resume" in the meeting chat to continue',
      ht_quote: "“We ship Helm chart 0.2.0 with local ONNX Hybrid RAG enabled by default.”",

      fpro_title: "Structured protocols with verified screen-share context",
      fpro_lead:
        "Every recording produces an executive summary, explicit decisions, topics, and action items with clickable [HH:MM:SS] transcript citations — enriched by settled screen-share keyframes captured strictly from presentation tracks.",
      fpro_b1:
        "Flexible protocol LLM: run 100% locally via Ollama or connect any OpenAI-compatible endpoint (vLLM, LiteLLM, OpenAI) with automatic disclosure on /privacy.",
      fpro_b2:
        "Fail-closed screen-share slide keyframes (<= 1280×720 PNG) exclude participant webcams, expire after 30 days, and support 1-click single-slide deletion.",
      fpro_b3:
        "Export clean Markdown, TXT, WebVTT subtitles, or structured JSON — plus shareable read-only protocol links and optional editing.",
      fpro_card_head: "Protocol Output & Slide Governance",
      fpro_row1_t: "Decision + Clickable Evidence",
      fpro_row1_d:
        "Every decision and action item carries a verifiable [HH:MM:SS] anchor jumping straight to the verbatim speaker utterance.",
      fpro_row2_t: "Screen-Share Keyframes",
      fpro_cam_badge: "Camera excluded",
      fpro_row2_d:
        "Captures settled presentation slides on Meet, Teams, Webex & Zoom. Presenter opt-out purges all shared frames immediately.",
      fpro_exports_label: "Direct Exports",

      fcal_title: "Zero-friction calendar sync & automatic link writeback",
      fcal_lead:
        "Connect Google Workspace or Microsoft 365 via OAuth2 PKCE — or invite the bot email via IMAP/.ics. Decide per event with a single click whether wortlaut should attend.",
      fcal_b1:
        "Detects Google Meet, Microsoft Teams, Cisco Webex, and Zoom join URLs automatically across recurring and one-off invites.",
      fcal_b2:
        "Writes the read-only protocol link straight back into the calendar event description as soon as transcription finishes.",
      fcal_b3:
        'Sends crisp HTML & plain-text summary notifications as "Wortlaut.Cloud Robot" when mail delivery is enabled.',
      fcal_card_head: "Upcoming Meetings · OAuth2 Calendar Sync",
      fcal_card_sub: "Click to toggle recording",
      fcal_ev1_t: "Weekly Engineering Sync",
      fcal_ev1_m: "Today 10:00 · Google Meet · Auto-writeback",
      fcal_ev2_t: "Customer Steering Committee",
      fcal_ev2_m: "Today 13:30 · Microsoft Teams · 12 attendees",
      fcal_ev3_t: "External Partner Call",
      fcal_ev3_m: "Tomorrow 11:00 · Zoom · Click to toggle",
      toggle_on: "Recording ON",
      toggle_off: "Recording OFF",

      faud_title: "Isolated pre-mix audio, 30 languages, and your domain glossary",
      faud_lead:
        "Instead of guessing speakers from a mixed room recording via biometric voiceprints, wortlaut captures each remote WebRTC audio stream separately before mixing and transcribes it locally with Qwen3-ASR 1.7B.",
      faud_b1:
        "Verified participant-session speaker binding across Meet, Teams, Webex, and Zoom — resilient even during crosstalk.",
      faud_b2:
        "30 languages with automatic detection plus live per-recording language switching on GPU or CPU.",
      faud_b3:
        "Built-in Glossary workspace teaches product names, acronyms, and customer terms directly to speech recognition.",
      faud_card_head: "Pre-Mix Acoustic Pipeline",
      faud_step1_t: "1. Pre-Mix WebRTC SSRC Capture",
      faud_step1_d: "Each participant stream stays physically isolated before mixing.",
      faud_step2_t: "2. Ephemeral 24h Verification Snippets",
      faud_step2_d: "Short per-turn audio clips for human spot checks, auto-purged after 24h.",
      faud_step3_t: "3. Active Domain Glossary",

      priv_title: "Privacy engineered into the architecture, not promised in a policy",
      priv_desc:
        "Designed for works councils, European data protection standards, and regulated engineering organizations.",
      trust1_t: "Zero voiceprints or biometric profiling",
      trust1_d:
        "Speaker attribution relies exclusively on verified conference WebRTC session metadata — never biometric speaker embeddings or voice fingerprinting.",
      trust2_t: "Fail-closed camera exclusion & auto-expiry",
      trust2_d:
        "Slide capture strictly filters for screen-share tracks and discards cameras. Verification audio expires automatically after 24 hours; keyframes expire after 30 days or on 1-click delete.",
      trust3_t: "Real-time consent: #pause & opt out",
      trust3_d:
        "Any attendee can pause capture Off-the-Record (#pause) or opt out permanently (no / opt out) via chat, immediately scrubbing their audio, text, slides, and RAG vectors.",
      trust4_t: "Full infrastructure sovereignty & live /privacy",
      trust4_d:
        "Run 100% air-gapped with local ASR, local CPU ONNX RAG, and Ollama — or connect an OpenAI-compatible LLM endpoint that is automatically disclosed on your instance’s /privacy page.",

      cmp_col_feat: "Capability",
      cmp_col_saas: "Typical Cloud Meeting Bots",
      cmp_r1_k: "Hosting & Data Sovereignty",
      cmp_r1_w: "100% self-hosted (Docker Compose or Helm on your Kubernetes cluster)",
      cmp_r1_s: "Vendor cloud, third-party processors & retention policies",
      cmp_r2_k: "Speaker Attribution",
      cmp_r2_w: "Isolated pre-mix WebRTC tracks · Zero voiceprints",
      cmp_r2_s: "Mixed audio + biometric diarization guesses",
      cmp_r3_k: "Conference Platforms",
      cmp_r3_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom side-by-side",
      cmp_r3_s: "Often tiered or missing Webex / self-hosted control",
      cmp_r4_k: "Screen-Share Slides",
      cmp_r4_w: "Settled PNG keyframes · Fail-closed camera exclusion · 1-click delete",
      cmp_r4_s: "Full MP4 video recording including participant webcams",
      cmp_r5_k: "AI Search & MCP",
      cmp_r5_w: "Local CPU ONNX Hybrid RAG + 8 OAuth 2.1 MCP tools (/mcp)",
      cmp_r5_s: "Proprietary chat box or extra paid AI add-on",
      cmp_r6_k: "Live Participant Controls",
      cmp_r6_w: "1280×720 Horizon tile + chat #pause / #resume & no / opt out",
      cmp_r6_s: "Manual kick-only or post-meeting deletion ticket",
      cmp_r7_k: "Protocol LLM Backend",
      cmp_r7_w: "Local Ollama or any OpenAI-compatible API (vLLM, LiteLLM, OpenAI)",
      cmp_r7_s: "Locked to vendor’s hosted LLM pipeline",
      cmp_r8_k: "License & Pricing",
      cmp_r8_w: "GNU AGPL-3.0 · Free to self-host, unlimited seats",
      cmp_r8_s: "$18–$40+ per user / month",

      sh_title: "Deploy on your own server or Kubernetes cluster in minutes",
      sh_desc:
        "Start with Docker Compose or install Helm chart 0.2.0 directly from GHCR — with bundled PostgreSQL 17.12, RustFS S3, local ONNX RAG, and optional NVIDIA GPU acceleration.",
      copy_btn: "Copy",
      copied_btn: "Copied",
      sh_stack_title: "v0.2.0 Architecture at a Glance",
      st_k_core: "Core Stack",
      st_v_core: "Python 3.14 (FastAPI), TypeScript/Playwright Worker, PostgreSQL 17.12, RustFS S3",
      st_k_asr: "Speech & RAG",
      st_v_asr: "Qwen3-ASR 1.7B (30 languages, GPU/CPU) + local CPU INT8 ONNX (multilingual-e5-small-int8)",
      st_k_llm: "Protocol LLM",
      st_v_llm: "Local Ollama or any OpenAI-compatible API (vLLM, LiteLLM, OpenAI) with live /privacy disclosure",
      st_k_auth: "Identity & Mail",
      st_v_auth: "Dex OIDC SSO, OAuth 2.1 PKCE MCP server, Google/M365 Calendar OAuth2, Wortlaut.Cloud Robot mail",
      st_k_lic: "License",
      st_v_lic: "GNU AGPL-3.0 · Fully auditable, zero telemetry, zero vendor lock-in",
      sh_btn_repo: "View on GitHub",
      sh_btn_docs: "Deployment Docs",

      foot_docs: "Documentation",
      foot_copy: "Open Source under GNU AGPL-3.0 · Built by Mayflower",
    },

    de: {
      page_title: "wortlaut.cloud — Sprechergenaue Meeting-Protokolle & MCP-Wissensspeicher. 100 % Self-Hosted.",
      meta_desc:
        "wortlaut.cloud nimmt an Google Meet, Microsoft Teams, Cisco Webex und Zoom teil, erfasst getrennte Sprecherspuren und Screen-Share-Folien, erstellt strukturierte Protokolle mit Zeitstempel-Belegen und bindet Meetings per Hybrid-RAG-MCP an — 100 % Self-Hosted unter GNU AGPL-3.0.",
      nav_how: "Ablauf",
      nav_features: "Funktionen",
      nav_privacy: "Datenschutz",
      nav_selfhost: "Self-Hosting",
      cta_github: "GitHub",
      cta_install: "Jetzt starten",

      hero_title_html:
        'Sprechergenaue Meeting-Protokolle.<br><span class="hero-subline">100 % auf eigener Infrastruktur.</span>',
      hero_subtitle:
        "wortlaut nimmt mit einer transparenten Live-Videokachel an Google Meet, Microsoft Teams, Cisco Webex und Zoom teil, erfasst getrennte WebRTC-Sprecherspuren sowie Screen-Share-Folien, erzeugt strukturierte Protokolle mit klickbaren Zeitstempel-Belegen und macht jedes Meeting per Hybrid-RAG-MCP für KI-Clients durchsuchbar.",
      hero_cta_primary: "Kostenlos selbst hosten",
      hero_cta_secondary: "Funktionen entdecken",
      hero_meta_html:
        '<span>GNU AGPL-3.0</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>Ohne Voiceprints</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>30 Sprachen</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>Lokales Hybrid-RAG &amp; MCP</span><span class="hero-meta-sep" aria-hidden="true">·</span><span>v0.2.0</span>',
      platforms_label: "Läuft parallel in einer Instanz für alle vier Plattformen:",

      ui_window_url: "wortlaut.cloud / aufnahmen / q2-architektur-review",
      ui_badge_done: "Im Kalendereintrag verlinkt",
      ui_nav_meetings: "Aufnahmen",
      ui_nav_calendar: "Kalender",
      ui_nav_glossary: "Glossar",
      ui_nav_system: "System",
      ui_live_indicator: "1 aktive Aufnahme",
      ui_sidebar_note: "Lokales ONNX-RAG · AGPL-3.0",

      ui_meeting_title: "Q2 Architektur- & Release-Review",
      ui_meeting_date: "Heute, 14:00 Uhr",
      ui_meeting_dur: "38 Min · DE",
      ui_meeting_verified: "3 getrennte Sprecherspuren",
      ui_btn_share: "Teilen",

      ui_protocol_title: "Strukturiertes Protokoll & Entscheidungen",
      ui_protocol_engine: "Ollama / OpenAI-kompatibel · Zeitstempel zum Prüfen anklicken",
      ui_summary_text:
        "Das Team beschloss das v0.2.0-Helm-Rollout auf Kubernetes 1.32 mit 4 GiB Memory-Limit für lokales ONNX-RAG sowie die Screen-Share-Folienerfassung mit striktem Kamera-Ausschluss.",
      ui_dec_1: "Helm-Chart 0.2.0 mit lokalem CPU-ONNX-Hybrid-RAG als Standard ausliefern.",
      ui_dec_2: "Alle 8 MCP-Tools und Folien-PNG-Keyframes per OAuth 2.1 PKCE unter /mcp freigeben.",

      ui_slides_title: "Screen-Share-Keyframes (2)",
      ui_slides_meta: "Freigabespur verifiziert · Teilnehmerkameras ausgeschlossen · 30 Tage TTL",
      ui_slide_1_title: "Hybrid-RAG & MCP-Topologie",
      ui_slide_2_title: "v0.2.0 Rollout- & OAuth-2.1-Checkliste",

      ui_filter_all: "Alle (3)",
      ui_filter_hint: "Nach Sprecher filtern · 24h-Hörprobe",
      ui_turn_1:
        "Wir fixieren Helm-Chart 0.2.0 mit lokalen CPU-ONNX-Embeddings als Standard. Weil jede Sprecherspur vor dem Mix isoliert wird, bleiben Entscheidungen selbst bei Zwischenrufen exakt zugeordnet.",
      ui_otr_marker:
        "Off the Record (#pause) — Audio-Puffer im RAM genullt, Folienerfassung gestoppt",
      ui_turn_2:
        "Nach dem Gehaltsthema haben wir mit #resume fortgesetzt. Alle 24-Stunden-Hörproben laufen automatisch ab und Teilnehmerkameras bleiben strikt aus den Keyframes ausgeschlossen.",
      ui_turn_3:
        "Einverstanden — wir stellen alle 8 MCP-Tools und native PNG-Keyframes über OAuth 2.1 PKCE unter /mcp bereit, damit Claude, Cursor und Antigravity jede Entscheidung mit Belegen finden.",

      how_title: "In drei Schritten von der Einladung zum durchsuchbaren Meeting-Wissen",
      how_desc:
        "Keine Browser-Erweiterungen für Teilnehmende, kein Cloud-SaaS pro Nutzer und keine biometrischen Voiceprints.",
      step1_title: "Kalender verbinden oder direkt starten",
      step1_desc:
        "Google Calendar oder Microsoft 365 per OAuth2 PKCE (oder IMAP/.ics) anbinden, Aufnahmen je Termin per Klick steuern oder beliebige Meet-, Teams-, Webex- oder Zoom-Links direkt einfügen.",
      step2_title: "Transparente Live-Kachel & getrennte Erfassung",
      step2_desc:
        "wortlaut erscheint mit einer 1280×720-Horizon-Videokachel samt Sprecheranzeige und Chat-Befehlen, zeichnet jede WebRTC-Audiospur getrennt sowie verifizierte Folien auf und reagiert sofort auf #pause und opt out.",
      step3_title: "Protokoll, Kalender-Rückschreibung & MCP-Suche",
      step3_desc:
        "Lokale Spracherkennung in 30 Sprachen und Ollama oder eine OpenAI-kompatible API schreiben Entscheidungen mit [HH:MM:SS]-Belegen in den Termin, versenden Mails als Wortlaut.Cloud Robot und indexieren alles für Hybrid-RAG-MCP.",

      feat_title: "Gebaut für souveräne Teams, überprüfbare Protokolle und KI-Workflows",
      feat_desc:
        "Alle Bausteine von wortlaut.cloud 0.2.0 — von der lokalen Hybrid-RAG-MCP-Suche bis zur Live-Horizon-Videokachel.",
      ftab_mcp: "Hybrid-RAG & MCP",
      ftab_horizon: "Horizon-Kachel & #pause",
      ftab_protocol: "Protokolle & Folien",
      ftab_calendar: "Kalender & Writeback",
      ftab_audio: "Pre-Mix-Audio & 30 Sprachen",

      fmcp_title: "Alle Meeting-Entscheidungen direkt im KI-Client durchsuchen",
      fmcp_lead:
        "Stelle dein selbst gehostetes Protokollarchiv über Streamable-HTTP-MCP unter /mcp mit OAuth 2.1 PKCE bereit. Die Hybrid-Suche kombiniert lokale CPU-INT8-ONNX-Embeddings mit PostgreSQL-Volltextsuche per Reciprocal Rank Fusion — ganz ohne externe Vektordatenbank.",
      fmcp_b1:
        "Lokale multilingual-e5-small-int8-Embeddings auf der CPU + PostgreSQL tsvector über Entscheidungen, Aufgaben, Zusammenfassungen, Folien und Transkripte.",
      fmcp_b2:
        "8 fokussierte MCP-Tools: list_recordings, search_protocols, get_recording, get_transcript, get_keyframe (natives PNG-ImageContent), schedule_recording, cancel_recording und update_protocol.",
      fmcp_b3:
        "Strikte Nutzer-Berechtigung über Dex OIDC + widerrufbare OAuth-2.1-Freigaben direkt in der MCP-Ansicht der Web-UI.",
      rag_q_helm: '"Helm-Rollout & Memory"',
      rag_q_otr: '"Off-the-Record-Regel"',
      rag_q_slides: '"Architektur-Folie PNG"',

      fhor_title: "Sichtbare Präsenz, Live-#pause und sofortiges Opt-out",
      fhor_lead:
        "Niemand muss raten, ob gerade aufgezeichnet wird. wortlaut rendert eine ruhige 1280×720-Horizon-Videokachel, die selbst im 3×3-Galerieraster lesbar bleibt und aktive Sprecher sowie alle Chat-Kommandos direkt zeigt.",
      fhor_b1:
        "#pause (#pause / #weiter / #resume) im Meeting-Chat aktiviert sofort Off-the-Record: PCM-Audiopuffer werden im RAM genullt und die Folienerfassung stoppt augenblicklich.",
      fhor_b2:
        "no oder opt out schließt die eigene Stimme und geteilte Folien dauerhaft aus — vorhandene Beiträge, Audio, Keyframes und RAG-Chunks werden sofort gelöscht.",
      fhor_b3:
        "State-Only Chroma: Smaragdgrün zeigt aktive Aufzeichnung, warmes Amber signalisiert ausschließlich Off-the-Record-Pause oder Wartebereich.",
      fhor_preview_label: "Interaktive Vorschau der 1280×720-Videokachel",
      ht_mode_live: "Aufzeichnung aktiv",
      ht_mode_pause: "Off the Record (#pause)",
      ht_sub: "Q2 Architektur-Review · Eingeladen von Anna Weber",
      ht_status_live: "Aufzeichnung aktiv",
      ht_status_paused: "Off the Record",
      ht_cmd_optout: "Eigene Stimme ausnehmen",
      ht_cmd_otr: "Off-the-Record im Chat",
      ht_speaking_sub: "Spricht gerade · Getrennte WebRTC-Audiospur",
      ht_pause_title: "OFF THE RECORD · Aufnahme pausiert",
      ht_pause_desc:
        "Gesprochenes Audio und geteilte Bildschirme werden sofort verworfen und nicht gespeichert.",
      ht_pause_hint: 'Mit „#resume“ oder „#weiter“ im Chat fortsetzen',
      ht_quote: "„Wir liefern Helm-Chart 0.2.0 standardmäßig mit lokalem ONNX-Hybrid-RAG aus.“",

      fpro_title: "Strukturierte Protokolle mit verifiziertem Folien-Kontext",
      fpro_lead:
        "Jede Aufnahme liefert Zusammenfassung, explizite Entscheidungen, Themen und Aufgaben mit klickbaren [HH:MM:SS]-Transkript-Belegen — ergänzt um stabile Screen-Share-Keyframes direkt aus der Präsentationsspur.",
      fpro_b1:
        "Flexibles Protokoll-LLM: 100 % lokal über Ollama oder über beliebige OpenAI-kompatible Endpunkte (vLLM, LiteLLM, OpenAI) mit automatischer Angabe auf /privacy.",
      fpro_b2:
        "Fail-closed Screen-Share-Keyframes (<= 1280×720 PNG) schließen Teilnehmerkameras aus, verfallen nach 30 Tagen und lassen sich einzeln per Klick löschen.",
      fpro_b3:
        "Export als Markdown, TXT, WebVTT-Untertitel oder JSON — plus teilbare Nur-Lese-Protokolllinks und optionale Bearbeitung.",
      fpro_card_head: "Protokoll-Ausgabe & Folien-Datenschutz",
      fpro_row1_t: "Entscheidung + klickbarer Beleg",
      fpro_row1_d:
        "Jede Entscheidung und Aufgabe trägt einen [HH:MM:SS]-Anker, der direkt zur wörtlichen Sprecherpassage springt.",
      fpro_row2_t: "Screen-Share-Keyframes",
      fpro_cam_badge: "Kamera ausgeschlossen",
      fpro_row2_d:
        "Erfasst stabile Präsentationsfolien in Meet, Teams, Webex & Zoom. Bei Presenter-Opt-out werden alle Folien sofort entfernt.",
      fpro_exports_label: "Direktexporte",

      fcal_title: "Nahtloser Kalender-Sync & automatisches Link-Writeback",
      fcal_lead:
        "Google Workspace oder Microsoft 365 per OAuth2 PKCE verbinden — oder einfach die Bot-Adresse per IMAP/.ics einladen. Per Klick entscheidest du je Termin, ob wortlaut teilnimmt.",
      fcal_b1:
        "Erkennt Google-Meet-, Microsoft-Teams-, Cisco-Webex- und Zoom-Links automatisch in Einzel- und Serienterminen.",
      fcal_b2:
        "Schreibt den Nur-Lese-Protokolllink unmittelbar nach Abschluss direkt zurück in die Beschreibung des Kalendereintrags.",
      fcal_b3:
        'Versendet aufgeräumte HTML- & Text-Benachrichtigungen als „Wortlaut.Cloud Robot“, sobald Mailversand aktiv ist.',
      fcal_card_head: "Anstehende Meetings · OAuth2-Kalendersync",
      fcal_card_sub: "Zum Umschalten klicken",
      fcal_ev1_t: "Wöchentlicher Engineering-Sync",
      fcal_ev1_m: "Heute 10:00 · Google Meet · Auto-Writeback",
      fcal_ev2_t: "Kunden-Steuerkreis",
      fcal_ev2_m: "Heute 13:30 · Microsoft Teams · 12 Teilnehmende",
      fcal_ev3_t: "Externes Partnergespräch",
      fcal_ev3_m: "Morgen 11:00 · Zoom · Zum Umschalten klicken",
      toggle_on: "Aufnahme AN",
      toggle_off: "Aufnahme AUS",

      faud_title: "Getrenntes Pre-Mix-Audio, 30 Sprachen und dein Fachglossar",
      faud_lead:
        "Statt Sprecher aus einer gemischten Raumaufnahme per biometrischem Voiceprint zu erraten, greift wortlaut jeden eingehenden WebRTC-Audiostream getrennt vor dem Mix ab und transkribiert lokal mit Qwen3-ASR 1.7B.",
      faud_b1:
        "Nachgewiesene Teilnehmerbindung über Meet, Teams, Webex und Zoom — verlässlich auch bei gleichzeitigem Sprechen.",
      faud_b2:
        "30 Sprachen mit automatischer Erkennung sowie Live-Sprachumschaltung pro Aufnahme auf GPU oder CPU.",
      faud_b3:
        "Integrierte Glossar-Verwaltung trainiert Produktbegriffe, Kürzel und Kundennamen direkt in der Spracherkennung mit.",
      faud_card_head: "Pre-Mix-Audio-Pipeline",
      faud_step1_t: "1. Pre-Mix-WebRTC-SSRC-Erfassung",
      faud_step1_d: "Jeder Teilnehmerstream bleibt vor dem Mix physisch isoliert.",
      faud_step2_t: "2. Ephemere 24h-Verifikations-Hörproben",
      faud_step2_d: "Kurze Clips pro Beitrag zur Gegenprüfung, automatische Löschung nach 24h.",
      faud_step3_t: "3. Aktives Fachglossar",

      priv_title: "Datenschutz in der Architektur statt nur in der Datenschutzerklärung",
      priv_desc:
        "Entwickelt für Betriebsräte, europäische Datenschutzanforderungen und regulierte Organisationen.",
      trust1_t: "Keine Voiceprints und kein biometrisches Profiling",
      trust1_d:
        "Die Sprecherzuordnung basiert ausschließlich auf verifizierten WebRTC-Teilnehmermetadaten — niemals auf Stimmabdrücken oder Diarisierungs-Raten.",
      trust2_t: "Fail-closed Kamera-Ausschluss & automatischer Ablauf",
      trust2_d:
        "Die Folienerfassung filtert strikt nach Screen-Share-Spuren und verwirft Webcams. Hörproben verfallen nach 24 Stunden, Keyframes nach 30 Tagen oder sofort per Einzel-Löschung.",
      trust3_t: "Echtzeit-Einwilligung: #pause & opt out",
      trust3_d:
        "Jede Person kann per Chat Off-the-Record pausieren (#pause) oder dauerhaft widersprechen (no / opt out) — Audio, Text, Folien und RAG-Vektoren werden sofort bereinigt.",
      trust4_t: "Volle Souveränität & dynamisches /privacy",
      trust4_d:
        "Läuft 100 % offline mit lokalem ASR, lokalem CPU-ONNX-RAG und Ollama — oder optional mit einem OpenAI-kompatiblen LLM-Endpunkt, der automatisch unter /privacy ausgewiesen wird.",

      cmp_col_feat: "Merkmal",
      cmp_col_saas: "Typische Cloud-Meeting-Bots",
      cmp_r1_k: "Hosting & Datensouveränität",
      cmp_r1_w: "100 % Self-Hosted (Docker Compose oder Helm im eigenen Kubernetes-Cluster)",
      cmp_r1_s: "Hersteller-Cloud, Auftragsverarbeiter & Drittland-Speicherung",
      cmp_r2_k: "Sprecherzuordnung",
      cmp_r2_w: "Getrennte Pre-Mix-WebRTC-Spuren · Keine Voiceprints",
      cmp_r2_s: "Gemischtes Audio + biometrische Diarisierung",
      cmp_r3_k: "Konferenzplattformen",
      cmp_r3_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom parallel",
      cmp_r3_s: "Oft eingeschränkt oder ohne Webex / eigene Kontrolle",
      cmp_r4_k: "Screen-Share-Folien",
      cmp_r4_w: "Stabile PNG-Keyframes · Fail-closed Kamera-Ausschluss · 1-Klick-Löschung",
      cmp_r4_s: "Komplette MP4-Videoaufnahme inklusive Teilnehmerkameras",
      cmp_r5_k: "KI-Suche & MCP",
      cmp_r5_w: "Lokales CPU-ONNX-Hybrid-RAG + 8 OAuth-2.1-MCP-Tools (/mcp)",
      cmp_r5_s: "Proprietäres Chatfenster oder kostenpflichtiges KI-Add-on",
      cmp_r6_k: "Live-Teilnehmersteuerung",
      cmp_r6_w: "1280×720-Horizon-Kachel + Chat #pause / #resume & no / opt out",
      cmp_r6_s: "Nur manuelles Entfernen oder nachträgliche Lösch-Anfrage",
      cmp_r7_k: "Protokoll-LLM-Backend",
      cmp_r7_w: "Lokales Ollama oder jede OpenAI-kompatible API (vLLM, LiteLLM, OpenAI)",
      cmp_r7_s: "Fest an die gehostete LLM-Pipeline des Anbieters gebunden",
      cmp_r8_k: "Lizenz & Kosten",
      cmp_r8_w: "GNU AGPL-3.0 · Kostenlos selbst hostbar, unbegrenzte Nutzende",
      cmp_r8_s: "18–40 €+ pro Nutzer und Monat",

      sh_title: "In wenigen Minuten auf eigenem Server oder im Kubernetes-Cluster",
      sh_desc:
        "Starte mit Docker Compose oder installiere Helm-Chart 0.2.0 direkt aus GHCR — mit gebündeltem PostgreSQL 17.12, RustFS S3, lokalem ONNX-RAG und optionaler NVIDIA-GPU-Beschleunigung.",
      copy_btn: "Kopieren",
      copied_btn: "Kopiert",
      sh_stack_title: "v0.2.0 Architektur auf einen Blick",
      st_k_core: "Basis-Stack",
      st_v_core: "Python 3.14 (FastAPI), TypeScript/Playwright-Worker, PostgreSQL 17.12, RustFS S3",
      st_k_asr: "ASR & RAG",
      st_v_asr: "Qwen3-ASR 1.7B (30 Sprachen, GPU/CPU) + lokales CPU-INT8-ONNX (multilingual-e5-small-int8)",
      st_k_llm: "Protokoll-LLM",
      st_v_llm: "Lokales Ollama oder OpenAI-kompatible API (vLLM, LiteLLM, OpenAI) mit dynamischem /privacy",
      st_k_auth: "Identität & Mail",
      st_v_auth: "Dex OIDC SSO, OAuth-2.1-PKCE-MCP-Server, Google/M365-Kalender-OAuth2, Wortlaut.Cloud Robot",
      st_k_lic: "Lizenz",
      st_v_lic: "GNU AGPL-3.0 · Vollständig auditierbar, keine Telemetrie, kein Vendor-Lock-in",
      sh_btn_repo: "Auf GitHub ansehen",
      sh_btn_docs: "Deployment-Doku",

      foot_docs: "Dokumentation",
      foot_copy: "Open Source unter GNU AGPL-3.0 · Entwickelt von Mayflower",
    },
  };

  const RAG_DEMO = {
    en: {
      helm: [
        {
          title: "Q2 Architecture & Release Review",
          kind: "decision",
          ts: "14:04",
          score: "RRF 0.94",
          snippet:
            "Ship Helm chart 0.2.0 with 1Gi request / 4Gi memory limit so local CPU INT8 ONNX RAG backfills cleanly without throttling.",
        },
        {
          title: "Kubernetes Upgrade Sync",
          kind: "action_item",
          ts: "09:42",
          score: "RRF 0.87",
          snippet:
            "Upgrade bundled PostgreSQL image to 17.12-bookworm and Python runtime to 3.14-slim-trixie before tagging 0.2.0.",
        },
      ],
      otr: [
        {
          title: "Works Council & Privacy Alignment",
          kind: "decision",
          ts: "11:18",
          score: "RRF 0.96",
          snippet:
            "Typing #pause in chat zeroes live PCM audio in RAM, halts keyframe capture, and switches the 1280×720 Horizon tile to amber Off-the-Record mode.",
        },
        {
          title: "Q2 Architecture & Release Review",
          kind: "transcript",
          ts: "14:15",
          score: "RRF 0.83",
          snippet:
            "Resumed with #resume after the confidential segment; temporary verification snippets auto-expire after 24 hours.",
        },
      ],
      slides: [
        {
          title: "Q2 Architecture & Release Review",
          kind: "slide_keyframe",
          ts: "14:03",
          score: "RRF 0.95",
          snippet:
            "Keyframe #1 (1280×720 PNG · camera excluded): Hybrid RAG & MCP topology diagram — call get_keyframe() to inspect native ImageContent.",
        },
        {
          title: "Platform Security Review",
          kind: "slide_keyframe",
          ts: "16:27",
          score: "RRF 0.85",
          snippet:
            "Keyframe #4 (1280×720 PNG · share track verified): OAuth 2.1 PKCE consent flow and revocable MCP client grants.",
        },
      ],
    },
    de: {
      helm: [
        {
          title: "Q2 Architektur- & Release-Review",
          kind: "decision",
          ts: "14:04",
          score: "RRF 0.94",
          snippet:
            "Helm-Chart 0.2.0 mit 1Gi Request / 4Gi Memory-Limit ausrollen, damit lokales CPU-INT8-ONNX-RAG sauber im Hintergrund indexiert.",
        },
        {
          title: "Kubernetes-Upgrade-Sync",
          kind: "action_item",
          ts: "09:42",
          score: "RRF 0.87",
          snippet:
            "Gebündeltes PostgreSQL auf 17.12-bookworm und Python-Runtime auf 3.14-slim-trixie vor dem 0.2.0-Tag aktualisieren.",
        },
      ],
      otr: [
        {
          title: "Abstimmung Betriebsrat & Datenschutz",
          kind: "decision",
          ts: "11:18",
          score: "RRF 0.96",
          snippet:
            "#pause im Chat nullt laufendes PCM-Audio im RAM, stoppt Keyframes und schaltet die 1280×720-Horizon-Kachel in den bernsteinfarbenen Off-the-Record-Modus.",
        },
        {
          title: "Q2 Architektur- & Release-Review",
          kind: "transcript",
          ts: "14:15",
          score: "RRF 0.83",
          snippet:
            "Nach dem vertraulichen Abschnitt per #resume fortgesetzt; 24-Stunden-Hörproben laufen automatisch ab.",
        },
      ],
      slides: [
        {
          title: "Q2 Architektur- & Release-Review",
          kind: "slide_keyframe",
          ts: "14:03",
          score: "RRF 0.95",
          snippet:
            "Keyframe #1 (1280×720 PNG · Kamera ausgeschlossen): Hybrid-RAG & MCP-Topologie — via get_keyframe() direkt als natives ImageContent abrufbar.",
        },
        {
          title: "Plattform-Sicherheitsreview",
          kind: "slide_keyframe",
          ts: "16:27",
          score: "RRF 0.85",
          snippet:
            "Keyframe #4 (1280×720 PNG · Freigabespur verifiziert): OAuth-2.1-PKCE-Consent-Flow und widerrufbare MCP-Grants.",
        },
      ],
    },
  };

  let currentLang = "en";
  let currentRagQuery = "helm";
  let horizonPaused = false;

  function detectInitialLang() {
    const urlLang = new URLSearchParams(window.location.search).get("lang");
    if (urlLang === "de" || urlLang === "en") return urlLang;
    try {
      const saved = localStorage.getItem("wortlaut_site_lang");
      if (saved === "de" || saved === "en") return saved;
    } catch (_) {}
    const navLang = (navigator.language || "en").toLowerCase();
    return navLang.startsWith("de") ? "de" : "en";
  }

  function detectInitialTheme() {
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (urlTheme === "dark" || urlTheme === "light") return urlTheme;
    try {
      const saved = localStorage.getItem("wortlaut_site_theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch (_) {}
    return "dark";
  }

  function updateThemeButtonLabel(theme) {
    const label = document.getElementById("theme-toggle-label");
    if (!label) return;
    if (currentLang === "de") {
      label.textContent = theme === "dark" ? "Dunkel" : "Hell";
    } else {
      label.textContent = theme === "dark" ? "Dark" : "Light";
    }
  }

  function applyTheme(theme) {
    const resolved = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
    const sunIcon = document.getElementById("theme-icon-sun");
    const moonIcon = document.getElementById("theme-icon-moon");
    if (sunIcon && moonIcon) {
      sunIcon.style.display = resolved === "light" ? "block" : "none";
      moonIcon.style.display = resolved === "dark" ? "block" : "none";
    }
    updateThemeButtonLabel(resolved);
    try {
      localStorage.setItem("wortlaut_site_theme", resolved);
    } catch (_) {}
  }

  function renderRagResults() {
    const container = document.getElementById("rag-results-list");
    if (!container) return;
    const hits = (RAG_DEMO[currentLang] && RAG_DEMO[currentLang][currentRagQuery]) || [];
    container.textContent = "";

    hits.forEach((hit) => {
      const row = document.createElement("div");
      row.className = "ledger-row ledger-row-col";

      const head = document.createElement("div");
      head.className = "rag-hit-head";

      const left = document.createElement("span");
      left.style.display = "inline-flex";
      left.style.alignItems = "center";
      left.style.gap = "8px";
      left.style.flexWrap = "wrap";

      const title = document.createElement("span");
      title.className = "rag-hit-title";
      title.textContent = hit.title;

      const kind = document.createElement("span");
      kind.className = "rag-kind-tag";
      kind.textContent = hit.kind;

      left.appendChild(title);
      left.appendChild(kind);

      const right = document.createElement("span");
      right.style.display = "inline-flex";
      right.style.alignItems = "center";
      right.style.gap = "8px";

      const ts = document.createElement("span");
      ts.className = "wl-citation-chip";
      ts.textContent = hit.ts;

      const score = document.createElement("span");
      score.className = "rag-score";
      score.textContent = hit.score;

      right.appendChild(ts);
      right.appendChild(score);

      head.appendChild(left);
      head.appendChild(right);

      const snippet = document.createElement("p");
      snippet.className = "rag-hit-snippet";
      snippet.textContent = hit.snippet;

      row.appendChild(head);
      row.appendChild(snippet);
      container.appendChild(row);
    });
  }

  function syncHorizonStatus() {
    const tile = document.getElementById("horizon-tile-preview");
    const statusText = document.getElementById("ht-status-text");
    const btnLive = document.getElementById("ht-btn-live");
    const btnPause = document.getElementById("ht-btn-pause");
    if (!tile || !statusText || !btnLive || !btnPause) return;

    tile.classList.toggle("is-paused", horizonPaused);
    btnLive.classList.toggle("active-live", !horizonPaused);
    btnPause.classList.toggle("active-pause", horizonPaused);
    btnLive.setAttribute("aria-pressed", String(!horizonPaused));
    btnPause.setAttribute("aria-pressed", String(horizonPaused));

    const dict = I18N[currentLang];
    statusText.textContent = horizonPaused ? dict.ht_status_paused : dict.ht_status_live;
  }

  function applyLang(lang) {
    currentLang = lang === "de" ? "de" : "en";
    const dict = I18N[currentLang];
    document.documentElement.lang = currentLang;
    document.title = dict.page_title;

    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute("content", dict.meta_desc);

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key && dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (key && dict[key] !== undefined) {
        el.innerHTML = dict[key];
      }
    });

    document.querySelectorAll(".lang-btn").forEach((btn) => {
      const active = btn.getAttribute("data-lang") === currentLang;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    const extToggle = document.getElementById("demo-external-toggle");
    if (extToggle) {
      const isOff = extToggle.classList.contains("off");
      extToggle.textContent = isOff ? dict.toggle_off : dict.toggle_on;
    }

    renderRagResults();
    syncHorizonStatus();
    updateThemeButtonLabel(document.documentElement.getAttribute("data-theme") || "dark");

    try {
      localStorage.setItem("wortlaut_site_lang", currentLang);
    } catch (_) {}
  }

  function initLanguageSwitcher() {
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyLang(btn.getAttribute("data-lang"));
      });
    });
    applyLang(detectInitialLang());
  }

  function initThemeSwitcher() {
    applyTheme(detectInitialTheme());
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(cur === "dark" ? "light" : "dark");
    });
  }

  function initFeatureTabs() {
    const buttons = Array.from(document.querySelectorAll(".feature-tab-btn"));
    const panels = Array.from(document.querySelectorAll(".feature-panel"));
    buttons.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-tab");
        buttons.forEach((b) => {
          const isMatch = b === btn;
          b.classList.toggle("active", isMatch);
          b.setAttribute("aria-selected", String(isMatch));
        });
        panels.forEach((p) => {
          p.classList.toggle("active", p.getAttribute("data-panel") === target);
        });
      });
      btn.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
        ev.preventDefault();
        const nextIdx = (idx + (ev.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[nextIdx].focus();
        buttons[nextIdx].click();
      });
    });
  }

  function initRagDemo() {
    const pills = Array.from(document.querySelectorAll("[data-rag-query]"));
    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        currentRagQuery = pill.getAttribute("data-rag-query") || "helm";
        pills.forEach((p) => p.classList.toggle("active", p === pill));
        renderRagResults();
      });
    });
    renderRagResults();
  }

  function initHorizonDemo() {
    const btnLive = document.getElementById("ht-btn-live");
    const btnPause = document.getElementById("ht-btn-pause");
    if (!btnLive || !btnPause) return;
    btnLive.addEventListener("click", () => {
      horizonPaused = false;
      syncHorizonStatus();
    });
    btnPause.addEventListener("click", () => {
      horizonPaused = true;
      syncHorizonStatus();
    });
    syncHorizonStatus();
  }

  function initCalendarToggle() {
    const extToggle = document.getElementById("demo-external-toggle");
    if (!extToggle) return;
    extToggle.addEventListener("click", () => {
      const isOff = extToggle.classList.toggle("off");
      extToggle.setAttribute("aria-pressed", String(!isOff));
      const dict = I18N[currentLang];
      extToggle.textContent = isOff ? dict.toggle_off : dict.toggle_on;
    });
  }

  function initSpeakerFilterAndCitations() {
    const pills = Array.from(document.querySelectorAll("[data-speaker-filter]"));
    const turns = Array.from(document.querySelectorAll("[data-speaker-turn]"));
    const citeButtons = Array.from(document.querySelectorAll("[data-cite-turn]"));

    function applyFilter(target) {
      pills.forEach((p) => p.classList.toggle("active", p.getAttribute("data-speaker-filter") === target));
      turns.forEach((t) => {
        const speaker = t.getAttribute("data-speaker-turn");
        const match = target === "all" || speaker === target;
        t.style.display = match ? "" : "none";
      });
    }

    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        applyFilter(pill.getAttribute("data-speaker-filter") || "all");
      });
    });

    citeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const turnId = btn.getAttribute("data-cite-turn");
        if (!turnId) return;
        applyFilter("all");
        document.querySelectorAll(".wl-turn-row").forEach((row) => {
          row.classList.toggle("wl-turn-cited", row.id === turnId);
        });
        document.querySelectorAll(".wl-citation-chip[data-cite-turn]").forEach((chip) => {
          chip.classList.toggle("active", chip.getAttribute("data-cite-turn") === turnId);
        });
        const targetRow = document.getElementById(turnId);
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    });
  }

  function initCodeTabs() {
    const tabs = document.querySelectorAll(".code-tab");
    const panes = document.querySelectorAll(".code-pane");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-ctab");
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        panes.forEach((p) => p.classList.toggle("active", p.getAttribute("data-cpane") === target));
      });
    });
  }

  function initCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const activePane = document.querySelector(".code-pane.active");
        const text = activePane ? activePane.textContent.trim() : "";
        if (!text) return;
        navigator.clipboard?.writeText(text).catch(() => {});
        const dict = I18N[currentLang];
        btn.textContent = dict.copied_btn;
        setTimeout(() => {
          btn.textContent = dict.copy_btn;
        }, 1600);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initThemeSwitcher();
    initLanguageSwitcher();
    initFeatureTabs();
    initRagDemo();
    initHorizonDemo();
    initCalendarToggle();
    initSpeakerFilterAndCitations();
    initCodeTabs();
    initCopyButtons();
  });
})();
