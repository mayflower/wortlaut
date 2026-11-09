(function () {
  const I18N = {
    de: {
      meta_title: "wortlaut.cloud — Automatische Wortprotokolle für deine Meetings. 100 % selbst gehostet.",
      meta_desc:
        "wortlaut erstellt verlässliche, nach Sprechern getrennte Wortprotokolle für Google Meet, Microsoft Teams, Cisco Webex und Zoom – komplett auf eurer eigenen Infrastruktur unter GNU AGPLv3.",

      nav_how: "So funktioniert’s",
      nav_features: "Funktionen",
      nav_privacy: "Datenschutz",
      nav_selfhost: "Selbst hosten",
      cta_github: "GitHub",
      cta_install: "Jetzt installieren",

      hero_badge: "Open Source (AGPLv3) · 100 % Self-Hosted · DSGVO-konform",
      hero_title_html:
        'Automatische Wortprotokolle für deine Meetings.<br><span class="highlight">Auf deiner eigenen Infrastruktur.</span>',
      hero_subtitle:
        "wortlaut nimmt als stiller Zuhörer an Besprechungen in Google Meet, Microsoft Teams, Cisco Webex und Zoom teil, erkennt zuverlässig, wer spricht, und liefert direkt nach dem Gespräch ein durchsuchbares Wortprotokoll – ohne dass vertrauliche Gespräche in fremde Clouds abfließen.",
      hero_cta_primary: "Kostenlos selbst hosten",
      hero_cta_secondary: "So funktioniert’s ansehen",
      platforms_label: "Funktioniert einheitlich mit:",

      ui_nav_home: "Startseite",
      ui_nav_rec: "Aufnahmen",
      ui_nav_cal: "Kalender",
      ui_nav_sys: "System & Hilfe",
      ui_meeting_title: "Produkt- & Architektur-Abstimmung Q4",
      ui_meeting_meta: "Heute, 14:00 – 14:45 Uhr · Microsoft Teams · 3 Teilnehmende",
      ui_badge_done: "Protokoll fertig",
      ui_btn_share: "Lese-Link teilen",
      ui_btn_export: "Markdown exportieren",
      ui_turn1_text_html:
        'Wir haben die <mark>Kalender-Anbindung</mark> für Google Workspace und Microsoft 365 abgeschlossen. Eigene Termine werden automatisch protokolliert, externe Kundentermine lassen sich mit einem Klick zuschalten.',
      ui_turn2_text_html:
        'Sehr gut. Besonders hilfreich ist, dass die <mark>Sprechererkennung</mark> auch dann sauber bleibt, wenn zwei Personen kurz gleichzeitig sprechen.',
      ui_turn3_text_html:
        'Für unsere Kunden ist entscheidend, dass alle Aufnahmen auf unseren eigenen Servern bleiben und im Meeting-Chat sofort transparent angezeigt wird, wer das Protokoll gestartet hat.',

      how_kicker: "SO FUNKTIONIERT’S",
      how_title: "In drei einfachen Schritten vom Gespräch zum fertigen Protokoll",
      how_desc:
        "Keine komplizierte Einrichtung für Teilnehmende, keine Browser-Plugins und kein manuelles Mitschreiben.",
      step1_title: "1. Termin verbinden oder Link einfügen",
      step1_desc:
        "Verknüpfe einmalig deinen Google- oder Microsoft-365-Kalender, leite eine Termineinladung per E-Mail weiter oder füge spontan den Link eines laufenden Meetings in der Web-Oberfläche ein.",
      step2_title: "2. Entspannt sprechen",
      step2_desc:
        "wortlaut tritt dem Meeting als rein passiver Audio-Zuhörer bei, stellt sich im Konferenz-Chat transparent mit dem Namen der einladenden Person vor und erfasst jeden Redebeitrag getrennt nach Sprecher.",
      step3_title: "3. Nachlesen, suchen & teilen",
      step3_desc:
        "Direkt nach Gesprächsende erhältst du das fertige Wortprotokoll per E-Mail und in der Web-Oberfläche. Durchsuche alle Gespräche im Volltext, teile einen geschützten Lese-Link mit dem Team oder exportiere den Text.",

      feat_kicker: "FUNKTIONEN IM ÜBERBLICK",
      feat_title: "Alles, was Teams für verlässliche Besprechungsprotokolle brauchen",
      feat_desc:
        "Entwickelt für den täglichen Einsatz in Kundenprojekten, internen Abstimmungen und technischen Reviews.",

      ftab1_title: "Kalender-Automatik",
      ftab1_sub: "Google & Microsoft 365",
      ftab2_title: "Spontane Aufnahme",
      ftab2_sub: "In 10 Sekunden im Call",
      ftab3_title: "Teilen & Exportieren",
      ftab3_sub: "Lese-Links, Markdown & API",
      ftab4_title: "Präzise Sprecher",
      ftab4_sub: "Saubere Trennung ohne Stimmprofile",

      f1_title: "Deine Termine automatisch protokolliert – Kundentermine mit einem Klick",
      f1_lead:
        "Verbinde deinen Google- oder Microsoft-365-Kalender einmalig per Klick. Du behältst jederzeit die volle Kontrolle darüber, bei welchen Gesprächen wortlaut dabei ist:",
      f1_li1: "Selbst organisierte Termine mit Videokonferenz-Link werden automatisch eingeplant (jederzeit mit einem Klick abwählbar).",
      f1_li2: "Externe Kundentermine erscheinen übersichtlich in deinem Kalender und können bei Bedarf mit einem einzigen Klick zugeschaltet werden – ohne einen Bot in die fremde Einladungsliste einzutragen.",
      f1_li3: "Terminverschiebungen, Serien-Ausnahmen und Absagen werden automatisch übernommen.",
      f1_demo_label: "Kalender-Übersicht (Klicke auf den Schalter zum Testen):",
      f1_ev1_title: "Wöchentliches Team-Sync (Google Meet)",
      f1_ev1_meta: "10:00 – 10:45 Uhr · Automatisch aktiv (eigener Termin)",
      f1_ev2_title: "Projektabstimmung mit Kunden (Microsoft Teams)",
      f1_ev2_meta: "14:00 – 15:00 Uhr · Externer Termin · Per Klick zuschaltbar",
      f1_ev3_title: "Sprint-Review (Zoom)",
      f1_ev3_meta: "16:30 – 17:15 Uhr · Automatisch aktiv (eigene Serie)",
      toggle_on: "● Aufzeichnen: An",
      toggle_off: "○ Aufzeichnen: Aus",

      f2_title: "Spontan in laufende Besprechungen holen – und sofort durchsuchen",
      f2_lead:
        "Oft ergibt sich erst mitten im Gespräch, dass wichtige Entscheidungen festgehalten werden sollten. Mit wortlaut startest du die Aufzeichnung jederzeit spontan:",
      f2_li1: "Meeting-Link für Google Meet, Teams, Webex oder Zoom einfügen, gewünschte Dauer wählen und sofort starten.",
      f2_li2: "Live-Statusanzeige in Echtzeit: Auf einen Blick sehen, ob der Bot noch im Warteraum wartet oder bereits mitschreibt.",
      f2_li3: "Schon während des laufenden Gesprächs erscheint das Protokoll Absatz für Absatz im Browser und lässt sich sofort nach Stichworten durchsuchen.",
      f2_demo_title: "Spontane Aufzeichnung starten",
      f2_demo_btn: "Jetzt aufzeichnen",
      f2_demo_status: "LIVE · Im Gespräch (3 aktive Teilnehmende erkannt)",

      f3_title: "Sicher im Team teilen und nahtlos weiterverarbeiten",
      f3_lead:
        "wortlaut erfindet keine unkontrollierten KI-Zusammenfassungen, sondern liefert ein verlässliches, unverfälschtes Wortprotokoll als Grundlage für deine Arbeit:",
      f3_li1: "Geschützte Lese-Links: Teile ein einzelnes Protokoll per Klick mit Kolleginnen und Kollegen – ohne dass externe Gäste im Meeting-Chat unbefugt mitlesen können.",
      f3_li2: "Automatischer E-Mail-Versand: Nach dem Termin landen Protokoll und Lese-Link automatisch im Posteingang der einladenden Person.",
      f3_li3: "Offene Exportformate & REST-API: Lade Protokolle als Markdown (.md), Text (.txt), Untertitel (.vtt) oder strukturiertes JSON herunter – ideal für Confluence, Jira, GitLab oder eigene lokale KI-Modelle.",

      f4_title: "Klare Sprecherzuordnung – ganz ohne biometrische Stimmprofile",
      f4_lead:
        "Herkömmliche Cloud-Dienste mischen alle Stimmen zusammen und versuchen nachträglich per Stimmprofil zu erraten, wer gesprochen hat. wortlaut geht einen besseren Weg:",
      f4_li1: "Jede Tonspur wird bereits während der Konferenz getrennt erfasst und direkt dem jeweiligen Teilnehmernamen im Meeting zugeordnet.",
      f4_li2: "Auch wenn mehrere Personen kurz gleichzeitig sprechen oder sich ins Wort fallen, bleiben die Aussagen sauber getrennt.",
      f4_li3: "Es werden keinerlei biometrische Stimmprofile (Voiceprints) angelegt oder gespeichert.",

      priv_kicker: "DATENSCHUTZ & VERTRAUEN",
      priv_title: "Gebaut für vertrauliche Gespräche und strenge Datenschutz-Anforderungen",
      priv_desc:
        "Warum Unternehmen, Kanzleien, Beratungen und öffentliche Auftraggeber wortlaut statt kommerzieller US-Cloud-Bots einsetzen.",
      trust1_title: "100 % auf euren eigenen Servern",
      trust1_desc:
        "Sowohl die Gesprächsannahme als auch die Spracherkennung laufen vollständig in eurem eigenen Cluster. Keine einzige Sekunde Audio wird an externe Cloud-Anbieter übertragen.",
      trust2_title: "Transparent & respektvoll im Meeting",
      trust2_desc:
        "wortlaut zeichnet niemals Kamerabilder oder Bildschirminhalte auf. Beim Beitritt stellt sich der Bot im Chat mit dem Namen der einladenden Person und einem Link zur öffentlichen Datenschutz-Erklärung vor.",
      trust3_title: "Automatische Löschfristen & 1-Klick-Löschung",
      trust3_desc:
        "Roh-Audiodaten werden nach 24 Stunden automatisch gelöscht, schriftliche Protokolle nach 30 Tagen. Vertrauliche Besprechungen lassen sich zudem jederzeit sofort mit einem Klick restlos entfernen.",
      trust4_title: "Mandantentrennung & Single Sign-On",
      trust4_desc:
        "Über Single Sign-On (OIDC) sieht jede Person standardmäßig nur ihre eigenen Aufnahmen und Kalendereinträge – geschützt vor unbefugtem Zugriff.",

      comp_th_crit: "Kriterium",
      comp_th_cloud: "Kommerzielle US-Cloud-Notetaker",
      comp_th_wortlaut: "wortlaut (Open Source & Self-Hosted)",
      comp_r1_c: "Wo werden Gespräche verarbeitet?",
      comp_r1_cloud: "In fremden Hersteller-Clouds (oft USA)",
      comp_r1_w: "100 % auf deiner eigenen Infrastruktur",
      comp_r2_c: "Wie werden Sprecher erkannt?",
      comp_r2_cloud: "Über biometrische Stimmprofile (Voiceprints)",
      comp_r2_w: "Direkt über die Teilnehmersitzung – ohne Stimmprofile",
      comp_r3_c: "Wird Video aufgezeichnet?",
      comp_r3_cloud: "Häufig kompletter Video- & Bildschirm-Mitschnitt",
      comp_r3_w: "Rein passives Audio – niemals Kamera- oder Bildschirmaufnahme",
      comp_r4_c: "Unterstützte Plattformen",
      comp_r4_cloud: "Oft Abo-gebunden je Nutzer & Plattform",
      comp_r4_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom inklusive",
      comp_r5_c: "Lizenz & Kosten",
      comp_r5_cloud: "Monatliche Lizenzkosten pro Sitzplatz",
      comp_r5_w: "Freie Open-Source-Software unter GNU AGPLv3",

      qs_kicker: "SELBST HOSTEN (OPEN SOURCE)",
      qs_title: "In wenigen Minuten auf dem eigenen Server oder Cluster starten",
      qs_desc:
        "wortlaut ist freie Software unter der GNU AGPLv3. Starte das System per Docker Compose auf einem einzelnen Server, per Helm Chart in Kubernetes oder direkt lokal zur Evaluierung.",
      qs_tab1: "Docker Compose",
      qs_tab2: "Helm (Kubernetes)",
      qs_tab3: "Lokal / Kustomize",
      copy_btn: "Kopieren",
      copied_btn: "Kopiert!",
      qs_req_title: "Was du für den Betrieb brauchst",
      qs_req_1: "Flexibles Deployment: Docker Compose (Einzelserver/VM), Kubernetes (Helm Chart oder Kustomize) oder direkt lokal",
      qs_req_2: "Spracherkennung: NVIDIA-GPU empfohlen für Echtzeit-Betrieb – dank CPU-Fallback auch ohne GPU test- und nutzbar",
      qs_req_3: "PostgreSQL-Datenbank & S3-Speicher (bei Docker Compose bereits mit MinIO vorkonfiguriert)",
      qs_req_4: "Optional: Single Sign-On (OIDC), E-Mail-Versand (SMTP/IMAP) & Kalender-Sync für Google Workspace / Microsoft 365",
      qs_oss_title: "Quelloffen auf GitHub",
      qs_oss_desc:
        "Der gesamte Quellcode, das Docker-Compose-Setup, das Helm-Chart und alle Kubernetes-Manifeste stehen frei unter der GNU Affero General Public License v3.0 bereit.",
      qs_oss_btn: "Zum GitHub-Repository →",

      footer_tagline:
        "Automatische, sprechergetrennte Wortprotokolle für Google Meet, Microsoft Teams, Cisco Webex und Zoom – 100 % selbst gehostet.",
      footer_copy: "© 2026 Mayflower GmbH · Freie Software unter GNU AGPLv3 · wortlaut.cloud"
    },

    en: {
      meta_title: "wortlaut.cloud — Automatic Meeting Transcripts. 100% Self-Hosted & GDPR-Compliant.",
      meta_desc:
        "wortlaut creates accurate, speaker-separated transcripts for Google Meet, Microsoft Teams, Cisco Webex, and Zoom — running entirely on your own infrastructure under GNU AGPLv3.",

      nav_how: "How it works",
      nav_features: "Features",
      nav_privacy: "Privacy",
      nav_selfhost: "Self-Hosting",
      cta_github: "GitHub",
      cta_install: "Get Started",

      hero_badge: "Open Source (AGPLv3) · 100% Self-Hosted · GDPR-Compliant",
      hero_title_html:
        'Automatic transcripts for your meetings.<br><span class="highlight">Running on your own infrastructure.</span>',
      hero_subtitle:
        "wortlaut joins meetings in Google Meet, Microsoft Teams, Cisco Webex, and Zoom as a quiet listener, reliably attributes every statement to the right speaker, and delivers a searchable verbatim transcript right after the call — without sending confidential conversations to third-party clouds.",
      hero_cta_primary: "Self-Host for Free",
      hero_cta_secondary: "See How It Works",
      platforms_label: "Works seamlessly across:",

      ui_nav_home: "Home",
      ui_nav_rec: "Recordings",
      ui_nav_cal: "Calendar",
      ui_nav_sys: "System & Help",
      ui_meeting_title: "Q4 Product & Architecture Alignment",
      ui_meeting_meta: "Today, 14:00 – 14:45 · Microsoft Teams · 3 participants",
      ui_badge_done: "Transcript ready",
      ui_btn_share: "Share Read Link",
      ui_btn_export: "Export Markdown",
      ui_turn1_text_html:
        'We completed the <mark>calendar integration</mark> for Google Workspace and Microsoft 365. Own meetings are recorded automatically, and external client calls can be toggled on with a single click.',
      ui_turn2_text_html:
        'Great. What helps most is that <mark>speaker attribution</mark> stays clean even when two people talk at the same time.',
      ui_turn3_text_html:
        'For our clients, the key point is that every recording stays on our own servers and the meeting chat immediately shows who invited the note-taker.',

      how_kicker: "HOW IT WORKS",
      how_title: "From conversation to finished transcript in three simple steps",
      how_desc:
        "No complicated setup for attendees, no browser extensions required, and no manual note-taking.",
      step1_title: "1. Connect your calendar or paste a link",
      step1_desc:
        "Link your Google or Microsoft 365 calendar once, forward a calendar invite via email, or spontaneously paste a live meeting link into the web interface.",
      step2_title: "2. Focus on the conversation",
      step2_desc:
        "wortlaut joins the call as a strictly passive audio listener, introduces itself transparently in the meeting chat with the inviter’s name, and captures each participant separately.",
      step3_title: "3. Read, search & share",
      step3_desc:
        "Right after the call, receive the finished transcript via email and in the web app. Search across all meetings, share a protected read-only link with colleagues, or export the text.",

      feat_kicker: "FEATURES",
      feat_title: "Everything teams need for reliable meeting transcripts",
      feat_desc:
        "Built for daily use in client projects, team syncs, and technical reviews.",

      ftab1_title: "Calendar Sync",
      ftab1_sub: "Google & Microsoft 365",
      ftab2_title: "Ad-hoc Recording",
      ftab2_sub: "Join a live call in 10s",
      ftab3_title: "Share & Export",
      ftab3_sub: "Read links, Markdown & API",
      ftab4_title: "Accurate Speakers",
      ftab4_sub: "Clean separation, no voiceprints",

      f1_title: "Your own meetings recorded automatically — client calls with a single click",
      f1_lead:
        "Connect your Google or Microsoft 365 calendar with one click. You stay in full control of which meetings wortlaut attends:",
      f1_li1: "Meetings you organize yourself are scheduled automatically (and can be opted out with one click anytime).",
      f1_li2: "External client meetings appear in your personal calendar view and can be toggled on with a single click — without adding a bot to the client’s guest list.",
      f1_li3: "Rescheduled meetings, recurring series exceptions, and cancellations sync automatically.",
      f1_demo_label: "Calendar View (click the toggle switch to test):",
      f1_ev1_title: "Weekly Team Sync (Google Meet)",
      f1_ev1_meta: "10:00 – 10:45 · Auto-enabled (organized by you)",
      f1_ev2_title: "Client Project Alignment (Microsoft Teams)",
      f1_ev2_meta: "14:00 – 15:00 · External meeting · Enable with 1 click",
      f1_ev3_title: "Sprint Review (Zoom)",
      f1_ev3_meta: "16:30 – 17:15 · Auto-enabled (recurring series)",
      toggle_on: "● Record: On",
      toggle_off: "○ Record: Off",

      f2_title: "Bring wortlaut into unplanned calls — and search in real time",
      f2_lead:
        "Often you only realize mid-conversation that key decisions should be documented. With wortlaut, you can start recording anytime:",
      f2_li1: "Paste a meeting link for Google Meet, Teams, Webex, or Zoom, choose a duration, and start immediately.",
      f2_li2: "Live status indicator: see at a glance whether the bot is waiting in the lobby or actively transcribing.",
      f2_li3: "Even while the meeting is still running, paragraphs appear live in the browser and can be searched by keyword.",
      f2_demo_title: "Start Ad-hoc Recording",
      f2_demo_btn: "Record Now",
      f2_demo_status: "LIVE · In meeting (3 active participants detected)",

      f3_title: "Share safely with your team and export anywhere",
      f3_lead:
        "wortlaut avoids unverified AI summaries that invent facts, giving you an accurate verbatim transcript you can trust:",
      f3_li1: "Protected read-only links: share a transcript with teammates in one click — while preventing external meeting guests from snooping on the chat link.",
      f3_li2: "Automatic email delivery: finished transcripts and a read link are sent straight to the organizer’s inbox after the call.",
      f3_li3: "Open export formats & REST API: download transcripts as Markdown (.md), plain text (.txt), subtitles (.vtt), or structured JSON — ready for Confluence, Jira, GitLab, or your own internal AI tools.",

      f4_title: "Clean speaker attribution — with zero biometric voiceprints",
      f4_lead:
        "Conventional cloud bots mix all voices together and use biometric voice profiles to guess who spoke. wortlaut takes a fundamentally better approach:",
      f4_li1: "Each audio stream is captured separately during the call and attributed directly to the participant’s meeting session.",
      f4_li2: "Even when several people speak at the same time, their statements remain cleanly separated.",
      f4_li3: "Zero biometric voiceprints are ever created or stored.",

      priv_kicker: "PRIVACY & TRUST",
      priv_title: "Built for confidential conversations and strict data protection rules",
      priv_desc:
        "Why enterprises, consultancies, legal teams, and public-sector organizations choose wortlaut over commercial US cloud bots.",
      trust1_title: "100% on your own servers",
      trust1_desc:
        "Both meeting participation and speech recognition run entirely inside your own cluster. Not a single second of audio is sent to external cloud providers.",
      trust2_title: "Transparent & respectful in every call",
      trust2_desc:
        "wortlaut never records camera video or screen shares. Upon joining, it introduces itself in the meeting chat with the inviter’s name and a public privacy information link.",
      trust3_title: "Automatic retention limits & 1-click deletion",
      trust3_desc:
        "Raw audio is automatically purged after 24 hours and written transcripts after 30 days. Confidential recordings can also be permanently deleted at any time with a single click.",
      trust4_title: "Multi-user isolation & Single Sign-On",
      trust4_desc:
        "With Single Sign-On (OIDC), every user only sees their own recordings and calendar events by default.",

      comp_th_crit: "Criterion",
      comp_th_cloud: "Commercial US Cloud Note-Takers",
      comp_th_wortlaut: "wortlaut (Open Source & Self-Hosted)",
      comp_r1_c: "Where are conversations processed?",
      comp_r1_cloud: "External vendor clouds (often US-based)",
      comp_r1_w: "100% on your own infrastructure",
      comp_r2_c: "How are speakers identified?",
      comp_r2_cloud: "Biometric voice profiles (voiceprints)",
      comp_r2_w: "Directly via the meeting session — zero voiceprints",
      comp_r3_c: "Is video recorded?",
      comp_r3_cloud: "Often records full video & screen shares",
      comp_r3_w: "Strictly passive audio — never camera or screen video",
      comp_r4_c: "Supported platforms",
      comp_r4_cloud: "Often tied to per-seat subscriptions",
      comp_r4_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom included",
      comp_r5_c: "License & cost",
      comp_r5_cloud: "Recurring monthly fee per user",
      comp_r5_w: "Free open-source software under GNU AGPLv3",

      qs_kicker: "SELF-HOSTING (OPEN SOURCE)",
      qs_title: "Get started on your own server or cluster in minutes",
      qs_desc:
        "wortlaut is free software under the GNU AGPLv3. Run it with Docker Compose on a single VM, deploy via Helm Chart on Kubernetes, or launch locally for evaluation.",
      qs_tab1: "Docker Compose",
      qs_tab2: "Helm (Kubernetes)",
      qs_tab3: "Local / Kustomize",
      copy_btn: "Copy",
      copied_btn: "Copied!",
      qs_req_title: "What you need to run wortlaut",
      qs_req_1: "Flexible deployment: Docker Compose (single server/VM), Kubernetes (Helm Chart or Kustomize), or local process mode",
      qs_req_2: "Speech recognition: NVIDIA GPU recommended for real-time scale — built-in CPU fallback lets you evaluate and run without a GPU",
      qs_req_3: "PostgreSQL database & S3 storage (pre-configured with MinIO in Docker Compose)",
      qs_req_4: "Optional: Single Sign-On (OIDC), email delivery (SMTP/IMAP) & Google Workspace / Microsoft 365 calendar sync",
      qs_oss_title: "Open Source on GitHub",
      qs_oss_desc:
        "The complete source code, Docker Compose stack, Helm chart, and Kubernetes manifests are freely available under the GNU Affero General Public License v3.0.",
      qs_oss_btn: "View GitHub Repository →",

      footer_tagline:
        "Automatic, speaker-separated meeting transcripts for Google Meet, Microsoft Teams, Cisco Webex, and Zoom — 100% self-hosted.",
      footer_copy: "© 2026 Mayflower GmbH · Free Software under GNU AGPLv3 · wortlaut.cloud"
    }
  };

  let currentLang = "de";

  function detectInitialLang() {
    const params = new URLSearchParams(window.location.search);
    const qLang = params.get("lang");
    if (qLang === "en" || qLang === "de") return qLang;
    try {
      const saved = localStorage.getItem("wortlaut_cloud_lang");
      if (saved === "en" || saved === "de") return saved;
    } catch (_) {}
    return "de";
  }

  function applyLanguage(lang) {
    currentLang = lang === "en" ? "en" : "de";
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
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-ftab");
        buttons.forEach((b) => b.classList.toggle("active", b === btn));
        panels.forEach((p) => p.classList.toggle("active", p.getAttribute("data-fpanel") === target));
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

  document.addEventListener("DOMContentLoaded", () => {
    initLanguageSwitcher();
    initFeatureTabs();
    initCalendarToggle();
    initCodeTabs();
    initCopyButtons();
  });
})();
