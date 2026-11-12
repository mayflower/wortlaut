(function () {
  const I18N = {
    en: {
      meta_title: "wortlaut.cloud — Speaker-Accurate Meeting Transcripts. 100% Self-Hosted.",
      meta_desc:
        "wortlaut creates speaker-accurate verbatim transcripts and protocols for Google Meet, Microsoft Teams, Cisco Webex, and Zoom — 100% self-hosted on your own infrastructure under GNU AGPL-3.0.",

      nav_how: "How it works",
      nav_features: "Features",
      nav_privacy: "Privacy & Opt-Out",
      nav_selfhost: "Self-Hosting",
      cta_github: "GitHub",
      cta_install: "Get Started",

      hero_badge: "Open Source (AGPL-3.0) · 100% Self-Hosted · 25 Languages · GDPR-Ready",
      hero_title_html:
        'Speaker-accurate transcripts for your meetings.<br><span class="highlight">100% on your own infrastructure.</span>',
      hero_subtitle:
        "wortlaut joins calls in Google Meet, Microsoft Teams, Cisco Webex, and Zoom as a transparent passive listener, captures each speaker’s isolated audio stream before mixing, and writes finished protocols straight back into your calendar invite — with live chat opt-out and zero third-party cloud leakage.",
      hero_cta_primary: "Self-Host for Free",
      hero_cta_secondary: "See How It Works",
      platforms_label: "Runs side-by-side in a single instance across:",

      ui_window_url: "wortlaut · Meeting Protocol",
      ui_badge_done: "✓ Linked in calendar invite",
      ui_nav_home: "Home",
      ui_nav_rec: "Recordings",
      ui_nav_cal: "Calendar",
      ui_nav_sys: "System & Help",
      ui_sso_label: "OIDC Single Sign-On",
      ui_meeting_title: "Q4 Product & Security Architecture Review",
      ui_meeting_meta: "Today, 14:00 – 14:45 · 3 participants",
      ui_btn_share: "Share Read Link",
      ui_btn_export: "Export Markdown",
      ui_summary_label: "Executive Summary & Action Items",
      ui_summary_tag: "Optional Local AI · Ollama",
      ui_summary_body:
        "Calendar OAuth2 writeback for Google Workspace and Microsoft 365 is live; external client calls stay opt-in via 1-click toggle, and in-call chat opt-out passed security review.",
      ui_filter_all: "All (3)",
      ui_tracks_bound: "3 isolated tracks",
      ui_turn1_text_html:
        'Finished protocols are now written straight back into the <mark>Google Calendar and Outlook invite</mark> so every attendee finds the read-only link right where they look.',
      ui_turn2_text_html:
        'And because each participant’s WebRTC track is captured before mixing, <mark>speaker attribution</mark> stays accurate even when two people overlap — across 30 languages.',
      ui_turn3_text_html:
        'Our DPO especially liked the <mark>in-call chat opt-out</mark>: anyone can type <code>opt out</code> or <code>nein</code> in chat to exclude their voice immediately without stopping the call for everyone else.',

      how_kicker: "HOW IT WORKS",
      how_title: "From live conversation to verified protocol in three simple steps",
      how_desc:
        "No browser extensions for attendees, no cloud bots in third-party guest lists, and no manual note-taking.",
      step1_title: "1. Connect calendar, paste link, or invite",
      step1_desc:
        "Link your Google Workspace or Microsoft 365 calendar once via OAuth2, paste a live meeting URL on the home screen, or invite your bot email address like a regular attendee.",
      step2_title: "2. Transparent join & live chat opt-out",
      step2_desc:
        "wortlaut joins as a passive audio listener displaying the inviter’s name, posts a privacy link in chat, and lets any individual attendee type “opt out” or “no” in chat to exclude their stream on the spot.",
      step3_title: "3. Calendar writeback, verify & export",
      step3_desc:
        "Right after the call, wortlaut writes the read-only protocol link directly into your calendar event, emails the transcript, and lets you verify 24h audio snippets, edit terms, or export Markdown.",

      feat_kicker: "PRODUCT WORKFLOWS",
      feat_title: "Everything teams need for accurate, trustworthy meeting protocols",
      feat_desc:
        "Designed for daily engineering syncs, confidential client engagements, architecture decisions, and compliance-sensitive teams.",

      ftab1_title: "Calendar & Writeback",
      ftab1_sub: "Google & Microsoft 365",
      ftab2_title: "Ad-hoc & 25 Languages",
      ftab2_sub: "Join in ~15s · Local Qwen3-ASR",
      ftab3_title: "Verify, Edit & Summarize",
      ftab3_sub: "Snippets, Ollama AI & Exports",
      ftab4_title: "True Speaker Separation",
      ftab4_sub: "Pre-mix WebRTC · Zero voiceprints",

      f1_title:
        "Auto-record your own meetings, toggle client calls in 1 click, and link protocols in the invite",
      f1_lead:
        "Connect Google Calendar or Microsoft 365 via OAuth2 PKCE in seconds. You stay in complete control of every call:",
      f1_li1:
        "Self-organized meetings with confirmed guests are scheduled automatically (and can be opted out with 1 click anytime).",
      f1_li2:
        "External client invitations can be toggled on with a single click — without adding a bot email to the client’s guest list.",
      f1_li3:
        "Automatic Calendar Writeback: once completed, wortlaut appends the protected read-only protocol link straight into your Google Calendar or Outlook event.",
      f1_demo_label: "Calendar Workspace (click the toggle switch to test):",
      f1_ev1_title: "Weekly Platform Sync",
      f1_ev1_meta: "10:00 – 10:45 · Completed · Linked in calendar event",
      f1_linked_badge: "✓ Protocol linked",
      f1_ev2_title: "Client Architecture Workshop",
      f1_ev2_meta: "14:00 – 15:00 · External invite · Enable with 1 click",
      f1_ev3_title: "Sprint Review",
      f1_ev3_meta: "16:30 – 17:15 · Auto-enabled (recurring series)",
      toggle_on: "● Record: On",
      toggle_off: "○ Record: Off",

      f2_title:
        "Join unplanned calls in ~15 seconds — and transcribe locally across 30 languages",
      f2_lead:
        "Paste any meeting URL when a spontaneous call turns important, and run state-of-the-art speech recognition entirely on your own GPU or CPU:",
      f2_li1:
        "Paste a Google Meet, Teams, Webex, or Zoom link — wortlaut spawns an isolated browser worker and joins within ~15 seconds.",
      f2_li2:
        "Qwen3-ASR 1.7B detects the language of every segment automatically across 30 languages (3.88% German WER on the Open ASR Leaderboard).",
      f2_li3:
        "Bilingual EN / DE Web-UI with live lobby/capture stepper and real-time full-text search while the call is still running.",
      f2_demo_title: "Start Ad-hoc Recording",
      f2_dur_30: "30 min",
      f2_dur_60: "60 min",
      f2_dur_90: "90 min",
      f2_demo_btn: "Record Now",
      f2_demo_status: "LIVE · Capturing 3 isolated tracks · Qwen3-ASR (30 langs)",

      f3_title:
        "Verify quotes by ear, polish domain terms, summarize with local Ollama, and export anywhere",
      f3_lead:
        "wortlaut keeps the verbatim speaker-attributed transcript as your source of truth while giving your team powerful review and export tools:",
      f3_li1:
        "Click-to-listen verification & inline editor: play back isolated 24h audio snippets to verify exact wording, rename guest speakers, and apply 1-click vocabulary replacements across the entire protocol.",
      f3_li2:
        "Optional local AI summaries (Ollama): generate structured executive summaries, topic breakdowns, and action items on your own server with zero external API calls.",
      f3_li3:
        "Scoped read-only links (wortlaut-read-…), automatic email delivery, and open exports (.md, .txt, .vtt, .json) plus an idempotent REST API (/docs).",
      f3_exp_md_desc: "Ready for Notion, Confluence, GitHub, GitLab & Jira",
      f3_exp_ai_desc: "Opt-in executive summary, topics & action items on your GPU",
      f3_exp_vtt_desc: "Time-aligned .vtt captions & clean .txt email protocols",
      f3_exp_json_desc: "Structured segments, track diagnostics & OpenAPI (/docs)",

      f4_title: "Clean speaker attribution before audio mixing — with zero biometric voiceprints",
      f4_lead:
        "Conventional meeting bots record mixed room audio and guess speakers afterward using voice diarization. wortlaut solves speaker attribution at the transport layer:",
      f4_li1:
        "Each incoming WebRTC receiver stream is captured separately before mixing and bound directly to the verified conference participant session.",
      f4_li2:
        "Even when participants overlap or interrupt each other, statements remain cleanly separated per track.",
      f4_li3:
        "Zero biometric voiceprints are ever computed or stored — and if a provider hides a binding, wortlaut marks it transparently instead of guessing.",
      f4_badge: "Isolated stream → Verified speaker",
      f4_optout_cmd: 'Chat: "opt out" / "nein"',
      f4_optout_res: "→ Stream dropped & segments purged",

      priv_kicker: "PRIVACY, CONSENT & SECURITY",
      priv_title: "Built for confidential conversations, European DPOs, and strict compliance",
      priv_desc:
        "Why engineering organizations, consultancies, legal teams, and public-sector agencies run wortlaut instead of commercial cloud bots.",
      trust1_title: "100% Self-Hosted (Zero Cloud Leakage)",
      trust1_desc:
        "Sandboxed browser workers, Qwen3-ASR speech recognition, and optional Ollama summaries all run inside your own cluster or server. Not a single second of audio leaves your infrastructure.",
      trust2_title: "Live In-Call Chat Opt-Out",
      trust2_desc:
        "wortlaut joins as “wortlaut (Inviter Name)”, never records video or screen shares, and lets any participant type “opt out”, “no”, or “nein” in chat to immediately discard their stream and purge prior quotes.",
      trust3_title: "24h Audio Window & Auto-Expiry",
      trust3_desc:
        "Isolated audio chunks are deleted automatically from S3 after 24 hours; transcripts expire after 30 days by default and can be purged permanently at any moment with a single click.",
      trust4_title: "OIDC Single Sign-On & Tenant Isolation",
      trust4_desc:
        "Connect Keycloak, Authentik, Dex, Zitadel, Microsoft Entra ID, or Google via OIDC PKCE. Users only see their own recordings and invited meetings, plus HMAC-scoped read-only share links.",

      comp_th_crit: "Criterion",
      comp_th_cloud: "Commercial Cloud Note-Takers",
      comp_th_wortlaut: "wortlaut (Open Source & Self-Hosted)",
      comp_r1_c: "Where are calls & summaries processed?",
      comp_r1_cloud: "External vendor clouds & third-party LLM APIs",
      comp_r1_w: "100% on your own infrastructure (Qwen3-ASR + optional Ollama)",
      comp_r2_c: "How are speakers identified?",
      comp_r2_cloud: "Mixed audio + biometric voice profiles (voiceprints)",
      comp_r2_w: "Isolated pre-mix WebRTC tracks bound to session — zero voiceprints",
      comp_r6_c: "Individual attendee opt-out",
      comp_r6_cloud: "All-or-nothing (remove bot for everyone or leave call)",
      comp_r6_w: "Type “opt out” / “nein” in chat — only that speaker is excluded & purged",
      comp_r3_c: "Camera & screen recording",
      comp_r3_cloud: "Frequently records full video & screen shares",
      comp_r3_w: "Strictly passive audio — camera & screen capture blocked",
      comp_r4_c: "Supported platforms",
      comp_r4_cloud: "Often restricted or billed per seat & platform",
      comp_r5_c: "License & cost",
      comp_r5_cloud: "Recurring monthly per-seat subscription",
      comp_r5_w: "Free open-source software under GNU AGPL-3.0",

      qs_kicker: "SELF-HOSTING & QUICKSTART",
      qs_title: "Up and running on your own server or Kubernetes cluster in minutes",
      qs_desc:
        "Free software under GNU AGPL-3.0 with multi-arch images on GHCR. Launch via hardened Docker Compose on a single VM, 1-command Helm Chart on Kubernetes, or locally.",
      qs_tab1: "Docker Compose",
      qs_tab2: "Helm (Kubernetes)",
      qs_tab3: "Local / Contributors",
      copy_btn: "Copy",
      copied_btn: "Copied!",
      qs_code_compose: `# 1. Clone & configure secrets
git clone https://github.com/mayflower/wortlaut.git && cd wortlaut
cp .env.example .env

# 2. Launch stack (non-root meeting, docker-socket-proxy, Postgres 17 & RustFS S3)
docker compose up -d

# Recommended with NVIDIA GPU (real-time Qwen3-ASR):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# Web-UI: http://127.0.0.1:34601/ui · API Docs: http://127.0.0.1:34601/docs`,
      qs_code_helm: `# Zero-dependency evaluation (embedded PostgreSQL 17 + RustFS S3):
helm upgrade --install wortlaut oci://ghcr.io/mayflower/charts/wortlaut \\
  --namespace wortlaut --create-namespace \\
  --set host=wortlaut.local \\
  --set bundled.enabled=true \\
  --set asr.gpuCount=0 --set asr.allowCpu=true

# Production cluster (external DB/S3, GPU node & OIDC SSO):
helm upgrade --install wortlaut oci://ghcr.io/mayflower/charts/wortlaut \\
  --namespace wortlaut --create-namespace \\
  --set host=wortlaut.example.org \\
  --set oidc.issuer=https://auth.example.org`,
      qs_code_local: `# Option A: Bare-metal / local Linux process mode (no Kubernetes needed)
./scripts/run-local.sh

# Option B: Contributor setup & full integration test suite (Docker only)
make setup-local
make test-local`,
      qs_req_title: "What’s included out of the box",
      qs_req_1:
        "Hardened Docker Compose (isolated socket proxy, non-root) & OCI Helm Chart with zero-dependency bundled mode (amd64 & arm64)",
      qs_req_2:
        "Qwen3-ASR 1.7B: 30 languages (Qwen/Qwen3-ASR-1.7B-hf) — GPU recommended, CPU fallback built in",
      qs_req_3:
        "PostgreSQL 17 & RustFS S3 object storage pre-wired in both Docker Compose and Helm bundled mode",
      qs_req_4:
        "Optional: OIDC SSO, Google/M365 Calendar OAuth2 writeback, local Ollama summaries, and DKIM-verified IMAP/SMTP mail",
      qs_oss_title: "100% Open Source on GitHub",
      qs_oss_desc:
        "Explore the source code, configuration reference, OCI Helm chart, architecture docs, and security policy under the GNU Affero General Public License v3.0.",
      qs_oss_btn: "View GitHub Repository →",

      footer_tagline:
        "Speaker-accurate, self-hosted meeting transcripts and protocols for Google Meet, Microsoft Teams, Cisco Webex, and Zoom.",
      footer_docs: "Configuration",
      footer_security: "Security",
      footer_copy: "© 2026 Mayflower GmbH · Free Software under GNU AGPL-3.0 · wortlaut.cloud"
    },

    de: {
      meta_title: "wortlaut.cloud — Sprechergenaue Wortprotokolle für deine Meetings. 100 % selbst gehostet.",
      meta_desc:
        "wortlaut erstellt sprechergenaue Wortprotokolle für Google Meet, Microsoft Teams, Cisco Webex und Zoom – 100 % selbst gehostet auf eurer eigenen Infrastruktur unter GNU AGPL-3.0.",

      nav_how: "So funktioniert’s",
      nav_features: "Funktionen",
      nav_privacy: "Datenschutz & Opt-Out",
      nav_selfhost: "Selbst hosten",
      cta_github: "GitHub",
      cta_install: "Jetzt starten",

      hero_badge: "Open Source (AGPL-3.0) · 100 % Self-Hosted · 30 Sprachen · DSGVO-konform",
      hero_title_html:
        'Sprechergenaue Wortprotokolle für deine Meetings.<br><span class="highlight">100 % auf deiner eigenen Infrastruktur.</span>',
      hero_subtitle:
        "wortlaut nimmt als transparenter, passiver Zuhörer an Google Meet, Microsoft Teams, Cisco Webex und Zoom teil, erfasst jede Tonspur vor dem Mischen getrennt nach Sprecher und verlinkt fertige Protokolle direkt im Kalendereintrag – inklusive Live-Opt-Out im Chat und ohne Datenabfluss an fremde Clouds.",
      hero_cta_primary: "Kostenlos selbst hosten",
      hero_cta_secondary: "So funktioniert’s ansehen",
      platforms_label: "Läuft parallel in einer einzigen Instanz mit:",

      ui_window_url: "wortlaut · Besprechungsprotokoll",
      ui_badge_done: "✓ Im Kalendereintrag verlinkt",
      ui_nav_home: "Startseite",
      ui_nav_rec: "Aufnahmen",
      ui_nav_cal: "Kalender",
      ui_nav_sys: "System & Hilfe",
      ui_sso_label: "OIDC Single Sign-On",
      ui_meeting_title: "Q4 Produkt- & Sicherheits-Architektur-Review",
      ui_meeting_meta: "Heute, 14:00 – 14:45 Uhr · 3 Teilnehmende",
      ui_btn_share: "Lese-Link teilen",
      ui_btn_export: "Markdown exportieren",
      ui_summary_label: "Zusammenfassung & Aufgaben",
      ui_summary_tag: "Optionale lokale KI · Ollama",
      ui_summary_body:
        "Kalender-Rückschreiben für Google Workspace und Microsoft 365 ist aktiv; externe Kundentermine bleiben per 1-Klick-Schalter zuschaltbar und der Live-Chat-Opt-Out hat das Security-Review bestanden.",
      ui_filter_all: "Alle (3)",
      ui_tracks_bound: "3 isolierte Spuren",
      ui_turn1_text_html:
        'Fertige Protokolle werden jetzt automatisch direkt in die <mark>Google-Calendar- und Outlook-Einladung</mark> zurückgeschrieben, sodass alle Eingeladenen den Lese-Link sofort im Termin finden.',
      ui_turn2_text_html:
        'Und weil jede WebRTC-Empfangsspur vor dem Mischen separat erfasst wird, bleibt die <mark>Sprecherzuordnung</mark> auch bei gleichzeitigem Sprechen sauber – in 30 Sprachen.',
      ui_turn3_text_html:
        'Unser Datenschutzbeauftragter hat besonders den <mark>Live-Opt-Out im Chat</mark> gelobt: Wer <code>nein</code> oder <code>opt out</code> in den Chat schreibt, wird sofort ausgeschlossen, während das Meeting für alle anderen weiterläuft.',

      how_kicker: "SO FUNKTIONIERT’S",
      how_title: "In drei einfachen Schritten vom Gespräch zum geprüften Protokoll",
      how_desc:
        "Keine Browser-Erweiterungen für Teilnehmende, keine Cloud-Bots in fremden Gästelisten und kein manuelles Mitschreiben.",
      step1_title: "1. Kalender verbinden, Link einfügen oder einladen",
      step1_desc:
        "Verknüpfe einmalig deinen Google- oder Microsoft-365-Kalender per OAuth2, füge spontan einen Meeting-Link auf der Startseite ein oder lade die Bot-E-Mail-Adresse wie einen normalen Gast ein.",
      step2_title: "2. Transparenter Beitritt & Live-Opt-Out im Chat",
      step2_desc:
        "wortlaut tritt als passiver Audio-Zuhörer mit dem Namen der einladenden Person bei, postet den Datenschutz-Link im Chat und erlaubt jeder Person, sich per „nein“ oder „opt out“ im Chat sofort auszunehmen.",
      step3_title: "3. Kalender-Link, Audio-Check & Export",
      step3_desc:
        "Direkt nach Gesprächsende trägt wortlaut den Lese-Link automatisch in deinen Kalendereintrag ein, versendet das Protokoll per E-Mail und erlaubt Audio-Snippet-Prüfung (24 h), Korrekturen und Markdown-Export.",

      feat_kicker: "FUNKTIONEN IM ALLTAG",
      feat_title: "Alles, was Teams für verlässliche Besprechungsprotokolle brauchen",
      feat_desc:
        "Entwickelt für tägliche Engineering-Syncs, vertrauliche Kundenprojekte, Architekturentscheidungen und datenschutzsensible Organisationen.",

      ftab1_title: "Kalender & Rückschreiben",
      ftab1_sub: "Google & Microsoft 365",
      ftab2_title: "Ad-hoc & 30 Sprachen",
      ftab2_sub: "In ~15 s im Call · Lokales Qwen3-ASR",
      ftab3_title: "Prüfen, Editieren & KI",
      ftab3_sub: "Audio-Snippets, Ollama & Exporte",
      ftab4_title: "Echte Sprechertrennung",
      ftab4_sub: "Vor dem Mix · Ohne Stimmprofile",

      f1_title:
        "Eigene Termine automatisch protokollieren, Kundentermine per Klick zuschalten – inklusive Link im Termin",
      f1_lead:
        "Verbinde Google Calendar oder Microsoft 365 in wenigen Sekunden per OAuth2 PKCE. Du behältst bei jedem Gespräch die volle Kontrolle:",
      f1_li1:
        "Selbst organisierte Termine mit bestätigten Gästen werden automatisch eingeplant (und lassen sich jederzeit per Klick abwählen).",
      f1_li2:
        "Externe Kundentermine können mit einem einzigen Klick zugeschaltet werden – ohne einen Bot in die fremde Einladungsliste einzutragen.",
      f1_li3:
        "Automatisches Kalender-Rückschreiben: Nach Abschluss fügt wortlaut den geschützten Lese-Link direkt in deinen Google-Calendar- oder Outlook-Termin ein.",
      f1_demo_label: "Kalender-Arbeitsbereich (Klicke auf den Schalter zum Testen):",
      f1_ev1_title: "Wöchentliches Plattform-Sync",
      f1_ev1_meta: "10:00 – 10:45 Uhr · Abgeschlossen · Im Termin verlinkt",
      f1_linked_badge: "✓ Protokoll verlinkt",
      f1_ev2_title: "Kunden-Architektur-Workshop",
      f1_ev2_meta: "14:00 – 15:00 Uhr · Externer Termin · Per 1 Klick zuschaltbar",
      f1_ev3_title: "Sprint-Review",
      f1_ev3_meta: "16:30 – 17:15 Uhr · Automatisch aktiv (Terminserie)",
      toggle_on: "● Aufzeichnen: An",
      toggle_off: "○ Aufzeichnen: Aus",

      f2_title:
        "Spontan in ~15 Sekunden im laufenden Call – lokal transkribiert in 30 Sprachen",
      f2_lead:
        "Füge jederzeit einen Meeting-Link ein, wenn ein Gespräch wichtig wird, und transkribiere komplett lokal auf deiner eigenen GPU oder CPU:",
      f2_li1:
        "Link für Google Meet, Teams, Webex oder Zoom einfügen – wortlaut startet einen isolierten Browser-Worker und tritt in rund 15 Sekunden bei.",
      f2_li2:
        "Qwen3-ASR 1.7B erkennt die Sprache jedes Segments automatisch in 30 Sprachen (3,88 % deutsche WER im Open ASR Leaderboard).",
      f2_li3:
        "Zweisprachige Oberfläche (DE / EN) mit Live-Status-Anzeige (Warteraum → Aufnahme) und Echtzeit-Volltextsuche noch während des Gesprächs.",
      f2_demo_title: "Spontane Aufzeichnung starten",
      f2_dur_30: "30 Min.",
      f2_dur_60: "60 Min.",
      f2_dur_90: "90 Min.",
      f2_demo_btn: "Jetzt aufzeichnen",
      f2_demo_status: "LIVE · 3 isolierte Tonspuren · Qwen3-ASR (30 Sprachen)",

      f3_title:
        "Aussagen per Klick anhören, Fachbegriffe korrigieren, lokal per Ollama zusammenfassen & überallhin exportieren",
      f3_lead:
        "Das unverfälschte Wortprotokoll bleibt immer deine verlässliche Quelle – ergänzt um praktische Werkzeuge für Nachbereitung und Team-Freigabe:",
      f3_li1:
        "24-h-Audio-Prüfung & Inline-Editor: Höre dir einzelne Aussagen per Klick auf den Zeitstempel an, benenne Gäste um und ersetze Fachbegriffe im gesamten Protokoll mit einem Klick.",
      f3_li2:
        "Optionale lokale KI-Zusammenfassung (Ollama): Erzeuge Kurzfassungen, Themenblöcke und Aufgabenlisten auf deinem eigenen Server – ohne externe Cloud-APIs.",
      f3_li3:
        "Geschützte Lese-Links (wortlaut-read-…), automatischer E-Mail-Versand sowie Exporte als .md, .txt, .vtt, .json und idempotente REST-API (/docs).",
      f3_exp_md_desc: "Direkt für Notion, Confluence, GitHub, GitLab & Jira",
      f3_exp_ai_desc: "Optionale Zusammenfassung, Themen & Aufgaben auf eigener GPU",
      f3_exp_vtt_desc: "Zeitgenaue .vtt-Untertitel & saubere .txt-Protokolle",
      f3_exp_json_desc: "Strukturierte Segmente, Spur-Diagnose & OpenAPI (/docs)",

      f4_title: "Saubere Sprecherzuordnung vor dem Mischen – ganz ohne biometrische Stimmprofile",
      f4_lead:
        "Herkömmliche Bots schneiden gemischtes Raumaudio mit und raten nachträglich per Stimmprofil, wer gesprochen hat. wortlaut löst das Problem an der Wurzel:",
      f4_li1:
        "Jede eingehende WebRTC-Empfangsspur wird vor dem Mischen separat erfasst und direkt der nachgewiesenen Teilnehmersitzung zugeordnet.",
      f4_li2:
        "Auch wenn mehrere Personen gleichzeitig sprechen oder sich ins Wort fallen, bleiben alle Aussagen sauber nach Spur getrennt.",
      f4_li3:
        "Es werden niemals biometrische Stimmprofile (Voiceprints) berechnet oder gespeichert – fehlt eine Zuordnung, kennzeichnet wortlaut das transparent statt zu raten.",
      f4_badge: "Isolierte Tonspur → Geprüfte Sitzung",
      f4_optout_cmd: 'Chat: "nein" / "opt out"',
      f4_optout_res: "→ Tonspur verworfen & Segmente gelöscht",

      priv_kicker: "DATENSCHUTZ, WIDERSPRUCH & SICHERHEIT",
      priv_title: "Gebaut für vertrauliche Gespräche, Datenschutzbeauftragte und strenge Compliance",
      priv_desc:
        "Warum Engineering-Teams, Beratungen, Kanzleien und öffentliche Auftraggeber wortlaut statt kommerzieller US-Cloud-Bots betreiben.",
      trust1_title: "100 % Self-Hosted (Kein Cloud-Abfluss)",
      trust1_desc:
        "Isolierte Browser-Worker, Qwen3-ASR-Spracherkennung und optionale Ollama-Zusammenfassungen laufen komplett auf euren eigenen Servern. Keine Sekunde Audio verlässt eure Infrastruktur.",
      trust2_title: "Individueller Live-Opt-Out im Chat",
      trust2_desc:
        "wortlaut tritt als „wortlaut (Name der einladenden Person)“ bei, zeichnet niemals Video auf und erlaubt jeder Person im Call, per „nein“ oder „opt out“ im Chat ihre Spur und bisherige Zitate sofort zu löschen.",
      trust3_title: "24-h-Audiofenster & automatische Löschfristen",
      trust3_desc:
        "Isolierte Roh-Audioschnipsel werden nach 24 Stunden automatisch aus S3 gelöscht, Protokolle standardmäßig nach 30 Tagen – oder jederzeit sofort per 1-Klick-Löschung.",
      trust4_title: "OIDC Single Sign-On & Mandantentrennung",
      trust4_desc:
        "Anbindung an Keycloak, Authentik, Dex, Zitadel, Microsoft Entra ID oder Google per OIDC PKCE. Jede Person sieht nur eigene und eingeladene Termine sowie explizite Read-Only-Freigabelinks.",

      comp_th_crit: "Kriterium",
      comp_th_cloud: "Kommerzielle Cloud-Notetaker",
      comp_th_wortlaut: "wortlaut (Open Source & Self-Hosted)",
      comp_r1_c: "Wo werden Audio & Zusammenfassungen verarbeitet?",
      comp_r1_cloud: "Fremde Hersteller-Clouds & externe LLM-APIs",
      comp_r1_w: "100 % auf eigener Infrastruktur (Qwen3-ASR + optional Ollama)",
      comp_r2_c: "Wie werden Sprecher erkannt?",
      comp_r2_cloud: "Misch-Audio + biometrische Stimmprofile (Voiceprints)",
      comp_r2_w: "Isolierte WebRTC-Spuren vor dem Mix – keinerlei Stimmprofile",
      comp_r6_c: "Widerspruch einzelner Teilnehmender",
      comp_r6_cloud: "Alles-oder-nichts (Bot für alle entfernen oder Call verlassen)",
      comp_r6_w: "„nein“ / „opt out“ im Chat tippen – nur diese Person wird sofort ausgenommen",
      comp_r3_c: "Kamera- & Bildschirmaufnahme",
      comp_r3_cloud: "Häufig kompletter Video- & Bildschirm-Mitschnitt",
      comp_r3_w: "Rein passives Audio – Kamera- & Screen-Aufnahme gesperrt",
      comp_r4_c: "Unterstützte Plattformen",
      comp_r4_cloud: "Oft eingeschränkt oder pro Sitzplatz & Plattform lizenziert",
      comp_r5_c: "Lizenz & Kosten",
      comp_r5_cloud: "Monatliche Abo-Kosten pro Sitzplatz",
      comp_r5_w: "Freie Open-Source-Software unter GNU AGPL-3.0",

      qs_kicker: "SELBST HOSTEN & SCHNELLSTART",
      qs_title: "In wenigen Minuten auf dem eigenen Server oder Kubernetes-Cluster startklar",
      qs_desc:
        "Freie Software unter GNU AGPL-3.0 mit Multi-Arch-Images auf GHCR. Starte per gehärtetem Docker Compose auf einer VM, per 1-Befehl-Helm-Chart in Kubernetes oder direkt lokal.",
      qs_tab1: "Docker Compose",
      qs_tab2: "Helm (Kubernetes)",
      qs_tab3: "Lokal / Entwicklung",
      copy_btn: "Kopieren",
      copied_btn: "Kopiert!",
      qs_code_compose: `# 1. Repository klonen & Zugangsdaten anlegen
git clone https://github.com/mayflower/wortlaut.git && cd wortlaut
cp .env.example .env

# 2. Stack starten (non-root meeting, docker-socket-proxy, Postgres 17 & RustFS S3)
docker compose up -d

# Empfohlen mit NVIDIA-GPU (Echtzeit-ASR mit Qwen3-ASR):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# Web-UI: http://127.0.0.1:34601/ui · API-Docs: http://127.0.0.1:34601/docs`,
      qs_code_helm: `# Schnelltest ohne Vorarbeiten (integriertes PostgreSQL 17 + RustFS S3):
helm upgrade --install wortlaut oci://ghcr.io/mayflower/charts/wortlaut \\
  --namespace wortlaut --create-namespace \\
  --set host=wortlaut.local \\
  --set bundled.enabled=true \\
  --set asr.gpuCount=0 --set asr.allowCpu=true

# Produktiv-Cluster (externe DB/S3, GPU-Node & OIDC SSO):
helm upgrade --install wortlaut oci://ghcr.io/mayflower/charts/wortlaut \\
  --namespace wortlaut --create-namespace \\
  --set host=wortlaut.example.org \\
  --set oidc.issuer=https://auth.example.org`,
      qs_code_local: `# Option A: Direkt lokal auf Linux starten (ohne Kubernetes)
./scripts/run-local.sh

# Option B: Contributor-Setup & komplette Integrationstests (nur Docker nötig)
make setup-local
make test-local`,
      qs_req_title: "Direkt einsatzbereit im Lieferumfang",
      qs_req_1:
        "Gehärtetes Docker Compose (isolierter Socket-Proxy, non-root) & OCI-Helm-Chart inkl. Zero-Dependency-Bundled-Modus (amd64 & arm64)",
      qs_req_2:
        "Qwen3-ASR 1.7B: 30 Sprachen (Qwen/Qwen3-ASR-1.7B-hf) – GPU empfohlen, CPU-Fallback integriert",
      qs_req_3:
        "PostgreSQL 17 & RustFS S3-Objektspeicher sowohl in Docker Compose als auch im Helm-Bundled-Modus fertig vorkonfiguriert",
      qs_req_4:
        "Optional: OIDC SSO, Google/M365-Kalender-Rückschreiben, lokale Ollama-Zusammenfassungen und DKIM-geprüfter IMAP/SMTP-Mailversand",
      qs_oss_title: "100 % Open Source auf GitHub",
      qs_oss_desc:
        "Quellcode, Konfigurationsreferenz, OCI-Helm-Chart, Architekturdokumentation und Sicherheitsrichtlinie stehen frei unter der GNU Affero General Public License v3.0 bereit.",
      qs_oss_btn: "Zum GitHub-Repository →",

      footer_tagline:
        "Sprechergenaue, selbst gehostete Wortprotokolle für Google Meet, Microsoft Teams, Cisco Webex und Zoom.",
      footer_docs: "Konfiguration",
      footer_security: "Sicherheit",
      footer_copy: "© 2026 Mayflower GmbH · Freie Software unter GNU AGPL-3.0 · wortlaut.cloud"
    }
  };

  let currentLang = "en";

  function detectInitialLang() {
    const params = new URLSearchParams(window.location.search);
    const qLang = params.get("lang");
    if (qLang === "en" || qLang === "de") return qLang;
    try {
      const saved = localStorage.getItem("wortlaut_cloud_lang");
      if (saved === "en" || saved === "de") return saved;
    } catch (_) {}
    const browserLang = (navigator.language || (navigator.languages && navigator.languages[0]) || "").toLowerCase();
    if (browserLang.startsWith("de")) return "de";
    return "en";
  }

  function applyLanguage(lang) {
    currentLang = lang === "de" ? "de" : "en";
    const dict = I18N[currentLang];
    document.documentElement.lang = currentLang;
    document.title = dict.meta_title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute("content", dict.meta_desc);

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.textContent = dict[key];
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (dict[key] !== undefined) el.innerHTML = dict[key];
    });

    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === currentLang);
    });

    const extToggle = document.getElementById("demo-external-toggle");
    if (extToggle) {
      const isOff = extToggle.classList.contains("off");
      extToggle.textContent = isOff ? dict.toggle_off : dict.toggle_on;
    }

    try {
      localStorage.setItem("wortlaut_cloud_lang", currentLang);
    } catch (_) {}
  }

  function initLanguageSwitcher() {
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyLanguage(btn.getAttribute("data-lang")));
    });
    applyLanguage(detectInitialLang());
  }

  function initFeatureTabs() {
    const buttons = Array.from(document.querySelectorAll(".feature-tab-btn"));
    const panels = Array.from(document.querySelectorAll(".feature-panel"));
    buttons.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-ftab");
        buttons.forEach((b) => b.classList.toggle("active", b === btn));
        panels.forEach((p) => p.classList.toggle("active", p.getAttribute("data-fpanel") === target));
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

  function initCalendarToggle() {
    const extToggle = document.getElementById("demo-external-toggle");
    if (!extToggle) return;
    extToggle.addEventListener("click", () => {
      const isOff = extToggle.classList.toggle("off");
      const dict = I18N[currentLang];
      extToggle.textContent = isOff ? dict.toggle_off : dict.toggle_on;
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

  function initSpeakerFilterDemo() {
    const pills = Array.from(document.querySelectorAll("[data-speaker-filter]"));
    const turns = Array.from(document.querySelectorAll("[data-speaker-turn]"));
    if (!pills.length || !turns.length) return;
    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        const target = pill.getAttribute("data-speaker-filter");
        pills.forEach((p) => p.classList.toggle("active", p === pill));
        turns.forEach((t) => {
          const match = target === "all" || t.getAttribute("data-speaker-turn") === target;
          t.style.display = match ? "" : "none";
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initLanguageSwitcher();
    initFeatureTabs();
    initCalendarToggle();
    initCodeTabs();
    initCopyButtons();
    initSpeakerFilterDemo();
  });
})();
