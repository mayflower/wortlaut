(function () {
  const I18N = {
    de: {
      meta_title: "wortlaut.cloud — Souveräne Open-Source-Besprechungsprotokolle im eigenen Kubernetes-Cluster",
      meta_desc:
        "wortlaut erfasst Konferenz-Audio in Google Meet, Microsoft Teams, Cisco Webex und Zoom als getrennte WebRTC-Einzelspuren vor dem Mix und transkribiert lokal auf Ihrer NVIDIA-GPU. Open Source unter AGPL-3.0.",
      banner_text:
        "Open Source unter GNU AGPLv3 · 100 % Self-Hosted auf Kubernetes · Keine biometrischen Stimmprofile (Voiceprints)",
      banner_repo: "GitHub Repository →",
      nav_why: "Warum wortlaut?",
      nav_personas: "Personas & Rundgang",
      nav_providers: "Plattformen",
      nav_privacy: "Datenschutz",
      nav_arch: "Architektur",
      nav_quickstart: "Quickstart",
      cta_github: "GitHub",
      cta_selfhost: "Selbst hosten",

      hero_eyebrow: "OPEN SOURCE (AGPL-3.0) · KUBERNETES-NATIV · LOKALE NVIDIA-PARAKEET-GPU",
      hero_title_html:
        'Besprechungsprotokolle im eigenen Cluster.<br><span class="highlight">Nach Sprechern getrennt – noch bevor das Audio gemischt wird.</span>',
      hero_subtitle:
        "wortlaut nimmt als transparenter, rein passiver Browser-Teilnehmer an Google Meet, Microsoft Teams, Cisco Webex und Zoom teil, greift jede empfangene WebRTC-Audiospur einzeln vor dem Mix ab und transkribiert lokal auf Ihrer eigenen GPU. Ohne US-Cloud-Abfluss, ohne Voiceprints und ohne halluzinierte KI-Zusammenfassungen.",
      hero_cta_primary: "In 3 Schritten installieren",
      hero_cta_secondary: "Interaktiven Persona-Rundgang starten",
      copy_btn: "Kopieren",
      copied_btn: "Kopiert!",
      pill_parallel: "Parallel in einer Instanz ohne globalen Umschalter:",

      stage_left_title: "WebRTC Einzelspur-Capture (vor dem Audio-Mix)",
      stage_left_badge: "4 isolierte RTCRtpReceiver → 1 lokale GPU",
      stage_asr_tag: "Parakeet GPU · Spur #1",
      stage_asr_tag2: "Parakeet GPU · Spur #2",
      stage_asr_tag3: "Parakeet GPU · Spur #3",
      stage_asr_tag4: "Parakeet GPU · Spur #4",
      stage_left_footer_left: "Kein Audio-Mix · Keine KI-Diarisierung · Keine Voiceprints",
      stage_left_footer_right: "Roh-Audio TTL: 24h (S3)",

      stage_right_title: "wortlaut Web-UI · Astryx Stone Editorial Interface",
      ui_nav_home: "Startseite",
      ui_nav_rec: "Aufnahmen",
      ui_nav_cal: "Kalender",
      ui_nav_sys: "System & Hilfe",
      ui_welcome: "Willkommen bei wortlaut, Mara",
      ui_stepper_state: "LIVE · Zeichnet auf (00:18:42)",
      ui_stepper_meta: "4 benannte Quellen gebunden · 0 Audio-Lücken",
      ui_turn1_text_html:
        'Wir haben den <mark>Kalender-Sync</mark> für Google Workspace und Microsoft 365 freigegeben. Externe Kundentermine lassen sich jetzt mit einem Klick zuschalten.',
      ui_turn2_text_html:
        'Perfekt. Und weil jede <mark>WebRTC-Empfangsspur</mark> vor dem Mix getrennt in Parakeet läuft, bleiben auch überlappende Wortmeldungen sauber getrennt.',
      ui_turn3_text_html:
        'Aus Datenschutzsicht entscheidend: Der Bot stellt sich im Chat mit Einladender und öffentlichem <code>/privacy</code>-Link vor und speichert keinerlei Stimmprofile.',

      contrast_kicker: "DER ARCHITEKTUR-UNTERSCHIED",
      contrast_title: "Warum wir Audio vor dem Mix abgreifen – statt im Nachhinein Stimmen zu erraten",
      contrast_desc:
        "Herkömmliche SaaS-Meeting-Bots mischen alle Teilnehmenden in einen einzigen Audiostrom und versuchen anschließend per biometrischer Stimmprofil-Diarisierung in der Cloud zu rekonstruieren, wer gesprochen hat. wortlaut löst das Problem an der Wurzel.",

      pillar1_title: "Einzelspur vor dem Mix",
      pillar1_desc:
        "Jeder empfangene WebRTC-Track (RTCRtpReceiver / AudioWorklet) wird im isolierten Chromium-Worker separat abgegriffen und über das Konferenz-Signaling (csi, ssrc, Teilnehmer-Roster) exakt an die echte Provider-Teilnehmersitzung gebunden.",
      pillar2_title: "Lokale Parakeet-GPU statt Cloud-STT",
      pillar2_desc:
        "Ein gemeinsam geladenes lokales NVIDIA-Parakeet-Modell (services/asr) transkribiert alle Einzelspuren im eigenen Cluster. Kein einziges Audio-Paket verlässt Ihr Netzwerk in Richtung Deepgram, OpenAI oder US-SaaS-Clouds.",
      pillar3_title: "4 Plattformen parallel",
      pillar3_desc:
        "Google Meet, Microsoft Teams, Cisco Webex und Zoom werden gleichzeitig in derselben Instanz unterstützt. Der Provider wird pro Aufnahme automatisch erkannt – ohne globalen Umschalter.",
      pillar4_title: "Wortprotokoll statt Halluzination",
      pillar4_desc:
        "wortlaut verzichtet bewusst auf ungeprüfte Cloud-LLM-Prosa und liefert ein präzises Wortprotokoll (.md, .txt, .vtt, .json) inkl. maschinenlesbarer Qualitätsmetriken (sources_summary, has_audio_gaps) für Ihre eigenen lokalen LLMs.",

      comp_th_feature: "Architekturmerkmal",
      comp_th_saas: "US-SaaS-Bots (Fireflies, Otter, Read.ai)",
      comp_th_baas: "Cloud-BaaS & STT-Wrapper (Recall / Attendee)",
      comp_th_wortlaut: "wortlaut (Open Source · AGPL-3.0)",

      comp_r1_f: "Sprecherzuordnung",
      comp_r1_s: "Gemischtes Audio + biometrische Stimmprofile (Voiceprints)",
      comp_r1_b: "Meist gemischter Stream oder plattformabhängige Cloud-Diarisierung",
      comp_r1_w: "Getrennte Empfangsspuren vor dem Mix + echte Provider-Sitzungsbindung (csi/ssrc)",

      comp_r2_f: "Spracherkennung (ASR)",
      comp_r2_s: "Proprietäre US-Cloud-Verarbeitung",
      comp_r2_b: "Externe Cloud-STT-APIs (Deepgram, Gladia, OpenAI) als Standard",
      comp_r2_w: "100 % lokal im eigenen Cluster auf gemeinsamem NVIDIA-Parakeet-GPU-Dienst",

      comp_r3_f: "Unterstützte Konferenzsysteme",
      comp_r3_s: "Plattformabhängig, oft mit Account-Zwang für Gäste",
      comp_r3_b: "Webex häufig ohne Einzelspur; separate Konfigurationen",
      comp_r3_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom parallel in einer Instanz",

      comp_r4_f: "Datenschutz & Host-Transparenz",
      comp_r4_s: "Zeichnet oft Video mit auf; intransparente Cloud-Aufbewahrung",
      comp_r4_b: "Keine integrierte öffentliche /privacy-Transparenzseite oder Chat-Vorstellung",
      comp_r4_w: "Rein passives Audio (kein Video), Chat-Intro mit Einladender + öffentlichem /privacy-Link, 24h Roh-Audio-TTL",

      comp_r5_f: "Endnutzer-UI, SSO & Kalender-Sync",
      comp_r5_s: "Geschlossenes SaaS-Portal mit Hersteller-Login",
      comp_r5_b: "Reine Entwickler-API ohne fertige Endnutzer-Oberfläche",
      comp_r5_w: "Integrierte Astryx-Web-UI mit Dex-OIDC-SSO, Google/M365-OAuth2-Kalender, IMAP/.ics & Mail-Versand",

      personas_kicker: "FÜR JEDE ROLLE IM UNTERNEHMEN GEBAUT",
      personas_title: "Ein System, sechs Perspektiven – vom Account-Lead bis zum Datenschutzbeauftragten",
      personas_desc:
        "Klicken Sie durch die sechs Kern-Personas von wortlaut und testen Sie die interaktiven UI-Komponenten direkt im Browser.",

      tab1_role: "Account & Projekt",
      tab1_name: "1. Mara",
      tab2_role: "Tech-Lead & Ad-hoc",
      tab2_name: "2. Lukas",
      tab3_role: "Host & Datenschutz",
      tab3_name: "3. Dr. Thomas",
      tab4_role: "Team & Leserin",
      tab4_name: "4. Nina",
      tab5_role: "Platform & DevOps",
      tab5_name: "5. Svenja",
      tab6_role: "API & Integration",
      tab6_name: "6. Tim",

      p1_title: "Mara – Projekt- & Account-Lead (OAuth2-Kalender & E-Mail-Workflow)",
      p1_quote:
        "„Ich wechsle täglich zwischen Kunden-Calls in Teams, Meet, Webex und Zoom. US-Cloud-Bots sind bei uns verboten – ich brauche eigene Termine automatisch protokolliert und externe Kundentermine per 1-Klick zuschaltbar, ohne den Bot in fremde Einladungen einzutragen.“",
      p1_li1_html:
        "<strong>Google Calendar & Microsoft 365 parallel per OAuth2:</strong> Read-Only-Anbindung (<code>calendar.readonly</code> & <code>Calendars.Read</code>) ergänzend zu IMAP-Einladungen und <code>.ics</code>-Upload.",
      p1_li2_html:
        "<strong>Klare Regel ohne Überraschungen:</strong> Selbst organisierte Termine werden automatisch eingeplant (mit 1-Klick-Opt-out); externe Kundentermine schaltet Mara bei Bedarf mit einem einzigen Klick zu.",
      p1_li3_html:
        "<strong>Automatischer Ergebnisversand & 1-Klick-Löschung:</strong> Nach dem Gespräch kommen <code>.txt</code>, <code>.md</code>, <code>.vtt</code> und <code>.json</code> samt Lese-Link per E-Mail; vertrauliche Aufnahmen löscht Mara sofort per Klick (Right to Erasure).",
      p1_demo_header: "Interaktive Vorschau · Kalender-Arbeitsbereich (OAuth2 Sync aktiv)",
      p1_demo_hint: "Klicken Sie auf den Schalter beim externen Kundentermin:",
      p1_ev1_title: "Architektur-Sync (Eigener Termin · Google Meet)",
      p1_ev1_meta: "10:00 – 10:45 · Organisatorin: mara@mayflower.de",
      p1_ev2_title: "Kunden-Workshop FinTech AG (Externer Termin · MS Teams)",
      p1_ev2_meta: "14:00 – 15:00 · Externer Host · Kein Bot in fremder Einladungsliste",
      p1_ev3_title: "Quartals-Review (Eigene Serie · Zoom)",
      p1_ev3_meta: "16:30 – 17:15 · Serien-Ausnahmen & Verschiebungen automatisch synchronisiert",
      toggle_on: "● Aufzeichnen: An",
      toggle_off: "○ Aufzeichnen: Aus",

      p2_title: "Lukas – Consultant & Tech-Lead (Ad-hoc-Start & Live-Volltextsuche)",
      p2_quote:
        "„In spontanen Incident- oder Architektur-Calls entscheide ich oft erst im laufenden Gespräch, dass wir ein präzises Wortprotokoll für Jira, GitLab oder unser lokales LLM brauchen – ohne erfundene KI-Zusammenfassungen.“",
      p2_li1_html:
        "<strong>Ad-hoc-Dispatch in 10 Sekunden:</strong> Meeting-Link einfügen, Dauer wählen (30–180 Min.) und Bot direkt in das laufende Gespräch schicken.",
      p2_li2_html:
        "<strong>Transparenter Live-Status-Stepper:</strong> Sofort sehen, ob der Bot beitritt (<code>joining</code>), im Warteraum wartet (<code>waiting_admission</code>) oder aktiv Einzelspuren aufzeichnet (<code>capturing</code>).",
      p2_li3_html:
        "<strong>Konsekutiv gruppiertes Live-Transkript & Export:</strong> Aufeinanderfolgende Sätze desselben Sprechers werden automatisch zu lesbaren Absätzen zusammengefasst – inklusive Live-Suche mit <code>&lt;mark&gt;</code>-Hervorhebung und sauberem Markdown-Export.",
      p2_demo_header: "Interaktive Vorschau · Live-Transkript & Schnellfilter",
      p2_search_label: "Stichwort im Protokoll hervorheben:",

      p3_title: "Dr. Thomas – Externer Host & Datenschutzbeauftragter (Compliance & Transparenz)",
      p3_quote:
        "„Als Gastgeber und DSB lehne ich Blackbox-Bots ab, die ungefragt Video aufzeichnen, Stimmprofile anlegen oder sich nach dem Entfernen wieder einklinken. Bei wortlaut sehe ich sofort, wer den Bot geschickt hat und wie die Daten geschützt sind.“",
      p3_li1_html:
        "<strong>Aktive Vorstellung im Konferenz-Chat & öffentliches <code>/privacy</code>:</strong> Direkt nach dem Einlass nennt der Bot die einladende Person (<code>invited_by</code>) und verlinkt die ohne Login erreichbare Datenschutz- & Widerspruchsseite.",
      p3_li2_html:
        "<strong>Rein passives Audio – kein Video, keine Biometrie:</strong> Kamera und Mikrofon sind bis auf WebRTC-Sender-Ebene deaktiviert. Keine Stimmprofile (Voiceprints), keine KI-Diarisierung.",
      p3_li3_html:
        "<strong>Respektierte Grenzen & automatische Löschfristen:</strong> Kein Umgehen von CAPTCHAs oder Warteräumen, kein Rejoin nach Rauswurf (<code>removed</code>), automatisches Verlassen nach 5 Min. Stille (<code>room_empty</code>), Roh-Audio-Löschung nach 24 Stunden.",
      p3_demo_header: "Original-Vorschau · Automatische Vorstellung im Meeting-Chat & /privacy",
      p3_chat_msg_html:
        '<strong>wortlaut (Gast):</strong> Hallo! Ich zeichne dieses Gespräch zur Erstellung eines schriftlichen Wortprotokolls im Auftrag von <code>mara@mayflower.de</code> auf.<br>• Es wird ausschließlich Audio erfasst (kein Video, keine Stimmprofile), verarbeitet auf eigener Infrastruktur.<br>• Protokoll (für Berechtigte): <code>https://wortlaut.example.org/ui#view=meetings&amp;id=9f8a…</code><br>• Datenschutz, Speicherfristen (24h Roh-Audio / 30 Tage Text) &amp; Widerspruch (ohne Login): <code>https://wortlaut.example.org/privacy</code>',

      p4_title: "Nina – Eingeladene Teilnehmerin & Protokoll-Leserin (Sichere Kollaboration)",
      p4_quote:
        "„Ich möchte nach dem Termin schnell nachlesen, was besprochen wurde – aber externe Gäste im Meeting-Chat dürfen nicht unbefugt mitlesen, und ein geteilter Lese-Link darf meine eigene SSO-Sitzung nicht überschreiben.“",
      p4_li1_html:
        "<strong>Geschützter Chat-Link ohne offenen Token:</strong> Der automatisch im Meeting-Chat gepostete Link enthält keinen Lese-Token, sodass externe Gäste ohne explizite Freigabe keinen Zugriff erhalten.",
      p4_li2_html:
        "<strong>Gezielte Read-Only-Freigabe (<code>#token=wortlaut-read-…</code>):</strong> Erst wenn Mara oder Lukas aktiv einen Lese-Link teilen, kann Nina das Protokoll ohne eigenen Account im aufgeräumten Lesemodus öffnen.",
      p4_li3_html:
        "<strong>Isolierter <code>sessionStorage</code> statt Konto-Überschreibung:</strong> Hat Nina selbst ein SSO-Konto, bleibt ihre Sitzung erhalten; über <em>„Zurück zu meinem Konto“</em> wechselt sie jederzeit zu ihren eigenen Aufnahmen.",
      p4_demo_header: "Vorschau · Aufgeräumter Lese-Modus (Reader View mit Redeanteilen)",

      p5_title: "Svenja – Platform- & DevOps-Engineer (Self-Hosted Kubernetes Operator)",
      p5_quote:
        "„Ich brauche keine fragile Microservice-Landschaft aus 12 Containern und externen Cloud-Keys, sondern gehärtete Images, isolierte kurzlebige Browser-Jobs pro Meeting, klare Kapazitätsgrenzen und native OTLP-Telemetrie.“",
      p5_li1_html:
        "<strong>Kurzlebige, isolierte Kubernetes-Worker-Jobs:</strong> Pro Aufnahme startet genau ein Kubernetes-Job mit frischem Chromium-Profil (<code>runAsNonRoot: true</code>, <code>allowPrivilegeEscalation: false</code>); Bootstrap-Secrets werden erst nach beobachteter Pod-Terminierung gelöscht.",
      p5_li2_html:
        "<strong>Deterministisches Backpressure:</strong> Harte Obergrenzen für gleichzeitige Meetings, unsegmentierte Audio-Samples, S3-Speicher und offene ASR-Jobs verhindern GPU-OOMs und DB-Spitzen.",
      p5_li3_html:
        "<strong>Native OpenTelemetry- & Grafana-Observability:</strong> Strukturierte Spans (<code>wortlaut.worker.status</code>) zeigen gebundene Receiver, Signaling-Kanäle und präzise Endgründe (z. B. <code>lobby_timeout</code>, <code>human_verification_required</code>).",
      p5_demo_header: "Vorschau · System & Kapazitäts-Überwachung (Backpressure & OTLP)",

      p6_title: "Tim – Workflow- & Integrations-Entwickler (Idempotente REST-API)",
      p6_quote:
        "„Für unsere internen Ticket- und Wiki-Pipelines brauche ich eine idempotente REST-API, die mir neben zeitgestempelten Segmenten auch ehrlich meldet, ob es Audio-Lücken oder ungebundene Quellen gab.“",
      p6_li1_html:
        "<strong>Idempotente Steuerung & OpenAPI (<code>/docs</code>):</strong> Sicheres Anlegen über <code>POST /v1/recordings</code> mit <code>Idempotency-Key</code> (<code>HTTP 409</code> bei abweichendem Payload) und scoped Reader-Tokens.",
      p6_li2_html:
        "<strong>Maschinenlesbare Qualitätsindikatoren:</strong> Der JSON-Export liefert <code>sources_summary</code>, <code>has_audio_gaps</code>, <code>attribution_unknown</code>, <code>unprocessed_audio</code> und <code>failed_asr_ranges</code> für verlässliche nachgelagerte LLM-Pipelines.",
      p6_li3_html:
        "<strong>Vier Exportformate auf Abruf:</strong> <code>/exports/json</code>, <code>/exports/md</code>, <code>/exports/vtt</code> (WebVTT) und <code>/exports/txt</code>.",
      p6_demo_header: "Echter API-Ausschnitt · JSON-Export mit Qualitätsmetriken",

      providers_kicker: "VIER KONFERENZSYSTEME PARALLEL",
      providers_title: "Google Meet, Microsoft Teams, Cisco Webex und Zoom in einer einzigen Instanz",
      providers_desc:
        "Keine globale Provider-Umschaltung: wortlaut erkennt die Plattform automatisch anhand der Meeting-URL oder Kalendereinladung und nutzt für jedes System den optimalen Einzelspur-Erfassungspfad.",

      prov_meet_mode: "Playwright/Chromium · Direkte WebRTC-Einzelspur",
      prov_meet_li1_html: "<strong>Audio-Erfassung:</strong> Abgriff jedes <code>RTCRtpReceiver</code>-Tracks vor dem Mix über einen WebRTC-Hook im Browser-Kontext.",
      prov_meet_li2_html: "<strong>Sprecherbindung:</strong> Zuordnung über <code>csi</code>/<code>ssrc</code> aus SDP, RTCDataChannel, Fetch/WebSocket-Roster und DOM-Kacheln.",
      prov_meet_li3_html: "<strong>Zugang:</strong> Anonymer Gast-Beitritt oder optionale gespeicherte Host-/Browser-Session (<code>storage-state.json</code>).",

      prov_teams_mode: "Playwright/Chromium · WebRTC Receiver + Signaling",
      prov_teams_li1_html: "<strong>Audio-Erfassung:</strong> Getrennte eingehende WebRTC-Audiospuren mit strikter Prüfung, dass kein eigenes Sendegerät aktiv ist.",
      prov_teams_li2_html: "<strong>Sprecherbindung:</strong> Verknüpfung von Media-Streams mit den im Teams-Roster und Signaling gemeldeten Teilnehmeridentitäten.",
      prov_teams_li3_html: "<strong>Zugang:</strong> Direkter Gast-Beitritt über Meeting-Join-Links im isolierten Worker-Job.",

      prov_webex_mode: "Browser-SDK / WebRTC · Multistream vor dem Mix",
      prov_webex_li1_html: "<strong>Audio-Erfassung:</strong> Parallele Einzelspur-Erfassung aller entfernten Audio-Panele vor dem Mischen.",
      prov_webex_li2_html: "<strong>Sprecherbindung:</strong> Direkte Bindung an die verifizierte Webex-Mitgliedssitzung inkl. Statuswechseln.",
      prov_webex_li3_html: "<strong>Zugang:</strong> Gast-Token/Service-App oder anonymer Web-Client-Beitritt je nach Raumrichtlinie.",

      prov_zoom_mode: "100 % Anonymer Browser-Beitritt · WebAudio/Worklet",
      prov_zoom_li1_html: "<strong>Audio-Erfassung:</strong> Erfassung über den Zoom-Webclient (<code>/wc/&lt;id&gt;/join</code>) mit Pre-Mix-Audio-Hooks.",
      prov_zoom_li2_html: "<strong>Sprecherbindung:</strong> Auswertung des WebSocket-/Roster-Signalings und der aktiven Teilnehmer-Metadaten.",
      prov_zoom_li3_html: "<strong>Zugang:</strong> Komplett ohne Zoom-Marketplace-App oder SDK-Keys direkt per Meeting-Link nutzbar.",

      privacy_kicker: "COMPLIANCE & DATENSCHUTZ BY DESIGN",
      privacy_title: "Gebaut für strenge Betriebsrats-, DSB- und Geheimhaltungs-Anforderungen",
      privacy_desc:
        "wortlaut versteckt sich nicht. Jede Funktion ist darauf ausgelegt, die berechtigten Anforderungen von Gastgebern, Teilnehmenden und Datenschutzbeauftragten technisch durchzusetzen.",
      priv_card1_title: "Öffentliche /privacy-Seite & Chat-Transparenz",
      priv_card1_desc:
        "Beim Betreten eines Raums postet wortlaut automatisch die E-Mail-Adresse der einladenden Person sowie den Link auf /privacy. Diese Seite ist ohne Login erreichbar und dokumentiert Verarbeitungszweck, lokale Architektur, Löschfristen und Widerspruchsmöglichkeiten.",
      priv_card2_title: "Keine Biometrie & automatische Löschfristen",
      priv_card2_desc:
        "Da Sprecher über die technische Konferenzsitzung statt über Stimmprofile zugeordnet werden, entstehen keinerlei biometrische Daten. Roh-Audio wird nach 24 Stunden automatisch aus S3 gelöscht, Transkripte nach 30 Tagen – oder sofort per Klick durch die einladende Person.",
      priv_card3_title: "Strikte Achtung von Zutrittsgrenzen",
      priv_card3_desc:
        "wortlaut umgeht niemals CAPTCHAs (human_verification_required), wartet geduldig im Warteraum, tritt nach einem Entfernen durch den Host (removed) nicht erneut bei und verlässt leere Räume nach 5 Minuten automatisch (room_empty).",

      arch_kicker: "KUBERNETES-ARCHITEKTUR",
      arch_title: "Drei klar getrennte Komponenten – ohne Microservice-Wildwuchs",
      arch_desc:
        "Der gesamte Stack besteht aus dem zentralen Meeting-Dienst, einem gemeinsam genutzten GPU-ASR-Dienst und kurzlebigen Kubernetes-Jobs für die Browser-Aufnahme.",

      qs_kicker: "OPEN-SOURCE-INSTALLATION (AGPL-3.0)",
      qs_title: "In drei Schritten im eigenen Kubernetes-Cluster starten",
      qs_desc:
        "Klone das Repository von GitHub, starte die Entwicklungsumgebung lokal per Tilt oder rolle wortlaut per Kustomize / ArgoCD in deinem Produktions-Cluster aus.",
      qs_tab_dev: "1. Schnellstart (Tilt / Dev)",
      qs_tab_k8s: "2. Kubernetes (Kustomize / Prod)",
      qs_tab_api: "3. REST-API (cURL)",
      qs_prereq_title: "Systemvoraussetzungen",
      qs_prereq_li1: "Kubernetes-Cluster (linux/amd64) mit Berechtigung für Jobs/Pods/Secrets im Namespace",
      qs_prereq_li2: "1× NVIDIA-GPU-Node für den gemeinsamen Parakeet-ASR-Dienst (services/asr)",
      qs_prereq_li3: "PostgreSQL 16+ & S3-kompatibler Objektspeicher (z. B. RustFS oder MinIO)",
      qs_prereq_li4: "Optional: Dex OIDC für SSO, Google/M365 OAuth2-Credentials, SMTP/IMAP-Postfach",
      qs_license_box_title: "Freie Software unter GNU AGPLv3",
      qs_license_box_desc:
        "Der vollständige Quellcode inklusive Meeting-Service, GPU-ASR-Service, Playwright-Workern, Astryx-Web-UI und Kubernetes-Manifesten steht unter der GNU Affero General Public License v3.0 auf GitHub bereit.",

      footer_tagline:
        "Souveräne Open-Source-Besprechungstranskription mit echter Einzelspur-Sprecherbindung vor dem Mix und lokaler NVIDIA-Parakeet-GPU.",
      footer_col_product: "Produkt & Architektur",
      footer_col_personas: "Personas",
      footer_col_oss: "Open Source",
      footer_copy: "© 2026 Mayflower GmbH · Veröffentlicht unter GNU AGPLv3 · wortlaut.cloud"
    },

    en: {
      meta_title: "wortlaut.cloud — Sovereign Open-Source Meeting Transcription on Your Own Kubernetes Cluster",
      meta_desc:
        "wortlaut captures conference audio in Google Meet, Microsoft Teams, Cisco Webex, and Zoom as isolated pre-mix WebRTC single tracks and transcribes locally on your NVIDIA GPU. Open source under AGPL-3.0.",
      banner_text:
        "Open Source under GNU AGPLv3 · 100% Self-Hosted on Kubernetes · Zero Biometric Voiceprints",
      banner_repo: "GitHub Repository →",
      nav_why: "Why wortlaut?",
      nav_personas: "Personas & Tour",
      nav_providers: "Providers",
      nav_privacy: "Privacy",
      nav_arch: "Architecture",
      nav_quickstart: "Quickstart",
      cta_github: "GitHub",
      cta_selfhost: "Self-Host Now",

      hero_eyebrow: "OPEN SOURCE (AGPL-3.0) · KUBERNETES-NATIVE · LOCAL NVIDIA PARAKEET GPU",
      hero_title_html:
        'Meeting transcripts inside your own cluster.<br><span class="highlight">Speaker-separated before the audio is ever mixed.</span>',
      hero_subtitle:
        "wortlaut joins Google Meet, Microsoft Teams, Cisco Webex, and Zoom as a transparent, strictly passive browser participant, captures every incoming WebRTC audio track individually before the mix, and transcribes locally on your own GPU. Zero US cloud leakage, zero voiceprints, and zero hallucinated AI summaries.",
      hero_cta_primary: "Install in 3 Steps",
      hero_cta_secondary: "Explore Interactive Persona Tour",
      copy_btn: "Copy",
      copied_btn: "Copied!",
      pill_parallel: "Running in parallel in a single instance without global mode switching:",

      stage_left_title: "WebRTC Single-Track Capture (Pre-Mix Isolation)",
      stage_left_badge: "4 isolated RTCRtpReceivers → 1 local GPU",
      stage_asr_tag: "Parakeet GPU · Track #1",
      stage_asr_tag2: "Parakeet GPU · Track #2",
      stage_asr_tag3: "Parakeet GPU · Track #3",
      stage_asr_tag4: "Parakeet GPU · Track #4",
      stage_left_footer_left: "No Audio Mixing · No AI Diarization · No Voiceprints",
      stage_left_footer_right: "Raw Audio TTL: 24h (S3)",

      stage_right_title: "wortlaut Web UI · Astryx Stone Editorial Interface",
      ui_nav_home: "Home",
      ui_nav_rec: "Recordings",
      ui_nav_cal: "Calendar",
      ui_nav_sys: "System & Help",
      ui_welcome: "Welcome to wortlaut, Mara",
      ui_stepper_state: "LIVE · Capturing (00:18:42)",
      ui_stepper_meta: "4 named sources bound · 0 audio gaps",
      ui_turn1_text_html:
        'We rolled out <mark>calendar sync</mark> for Google Workspace and Microsoft 365. External client calls can now be toggled on with a single click.',
      ui_turn2_text_html:
        'Great. And because every <mark>WebRTC receiver track</mark> streams into Parakeet before mixing, even overlapping speech stays cleanly separated.',
      ui_turn3_text_html:
        'Crucial for compliance: the bot introduces itself in chat with the inviter address and public <code>/privacy</code> link, and never stores biometric voiceprints.',

      contrast_kicker: "THE ARCHITECTURAL DIFFERENCE",
      contrast_title: "Why we capture audio tracks before the mix — instead of guessing voices afterwards",
      contrast_desc:
        "Conventional SaaS meeting bots mix all participants into a single audio stream and then use cloud biometric voiceprint diarization to guess who spoke. wortlaut solves speaker attribution at the transport layer.",

      pillar1_title: "Single-Track Pre-Mix Capture",
      pillar1_desc:
        "Every incoming WebRTC track (RTCRtpReceiver / AudioWorklet) is tapped separately inside an isolated Chromium worker and bound via conference signaling (csi, ssrc, roster) to the verified participant session.",
      pillar2_title: "Local Parakeet GPU vs. Cloud STT",
      pillar2_desc:
        "A shared local NVIDIA Parakeet model (services/asr) transcribes every track inside your own cluster. Not a single audio packet leaves your network to Deepgram, OpenAI, or US SaaS clouds.",
      pillar3_title: "4 Providers in Parallel",
      pillar3_desc:
        "Google Meet, Microsoft Teams, Cisco Webex, and Zoom are supported side-by-side in the same instance. The provider is selected per recording automatically — no global mode switch.",
      pillar4_title: "Verbatim Transcript vs. Hallucinations",
      pillar4_desc:
        "wortlaut deliberately avoids unverified cloud LLM prose and delivers an accurate verbatim transcript (.md, .txt, .vtt, .json) with machine-readable quality metrics (sources_summary, has_audio_gaps) for your own local LLMs.",

      comp_th_feature: "Capability",
      comp_th_saas: "US SaaS Bots (Fireflies, Otter, Read.ai)",
      comp_th_baas: "Cloud BaaS & STT Wrappers (Recall / Attendee)",
      comp_th_wortlaut: "wortlaut (Open Source · AGPL-3.0)",

      comp_r1_f: "Speaker Attribution",
      comp_r1_s: "Mixed audio + biometric voiceprints / active-speaker heuristics",
      comp_r1_b: "Mostly mixed stream or cloud-dependent diarization",
      comp_r1_w: "Isolated pre-mix receiver tracks + verified provider session binding (csi/ssrc)",

      comp_r2_f: "Speech Recognition (ASR)",
      comp_r2_s: "Proprietary US cloud processing",
      comp_r2_b: "External cloud STT APIs (Deepgram, Gladia, OpenAI) by default",
      comp_r2_w: "100% local in your cluster on a shared NVIDIA Parakeet GPU service",

      comp_r3_f: "Supported Conference Platforms",
      comp_r3_s: "Platform-specific, often forces guest sign-up",
      comp_r3_b: "Webex rarely single-track; separate setups",
      comp_r3_w: "Google Meet, Microsoft Teams, Cisco Webex & Zoom in parallel in one instance",

      comp_r4_f: "Privacy & Host Transparency",
      comp_r4_s: "Often records video; opaque cloud retention",
      comp_r4_b: "No built-in public /privacy transparency page or chat disclosure",
      comp_r4_w: "Strictly passive audio (no video), chat intro with inviter + public /privacy link, 24h raw audio TTL",

      comp_r5_f: "End-User UI, SSO & Calendar Sync",
      comp_r5_s: "Closed SaaS portal with vendor lock-in",
      comp_r5_b: "Developer API only, no ready-to-use end-user workspace",
      comp_r5_w: "Integrated Astryx Web UI with Dex OIDC SSO, Google/M365 OAuth2 calendar, IMAP/.ics & email delivery",

      personas_kicker: "DESIGNED FOR EVERY STAKEHOLDER",
      personas_title: "One platform, six perspectives — from Account Lead to Data Protection Officer",
      personas_desc:
        "Click through wortlaut’s six core personas and test the interactive UI workflows right in your browser.",

      tab1_role: "Account & Project",
      tab1_name: "1. Mara",
      tab2_role: "Tech Lead & Ad-hoc",
      tab2_name: "2. Lukas",
      tab3_role: "Host & Privacy DPO",
      tab3_name: "3. Dr. Thomas",
      tab4_role: "Team Collaborator",
      tab4_name: "4. Nina",
      tab5_role: "Platform & DevOps",
      tab5_name: "5. Svenja",
      tab6_role: "API & Integrations",
      tab6_name: "6. Tim",

      p1_title: "Mara – Project & Account Lead (OAuth2 Calendar & Email Workflow)",
      p1_quote:
        "“I switch between client calls on Teams, Meet, Webex, and Zoom every day. US cloud bots are strictly off-limits — I need my own meetings recorded automatically and external client meetings toggled on with one click, without adding a bot to the client’s invite list.”",
      p1_li1_html:
        "<strong>Google Calendar & Microsoft 365 OAuth2 in parallel:</strong> Read-only connection (<code>calendar.readonly</code> & <code>Calendars.Read</code>) alongside IMAP invitations and <code>.ics</code> upload.",
      p1_li2_html:
        "<strong>Predictable rule without surprises:</strong> Self-organized meetings auto-schedule (with 1-click opt-out); external client meetings are enabled on demand with a single click.",
      p1_li3_html:
        "<strong>Automated email delivery & 1-click erasure:</strong> Finished <code>.txt</code>, <code>.md</code>, <code>.vtt</code>, and <code>.json</code> transcripts plus a read-only link arrive via email; sensitive recordings can be permanently deleted with one click.",
      p1_demo_header: "Interactive Preview · Calendar Workspace (OAuth2 Sync Active)",
      p1_demo_hint: "Click the recording toggle on the external client meeting:",
      p1_ev1_title: "Architecture Sync (Own Meeting · Google Meet)",
      p1_ev1_meta: "10:00 – 10:45 · Organizer: mara@mayflower.de",
      p1_ev2_title: "FinTech Corp Workshop (External Client Meeting · MS Teams)",
      p1_ev2_meta: "14:00 – 15:00 · External Host · Bot never injected into client invite",
      p1_ev3_title: "Quarterly Review (Recurring Series · Zoom)",
      p1_ev3_meta: "16:30 – 17:15 · Recurrence exceptions & reschedules synced automatically",
      toggle_on: "● Record: On",
      toggle_off: "○ Record: Off",

      p2_title: "Lukas – Consultant & Tech Lead (10-Second Ad-hoc Dispatch & Live Search)",
      p2_quote:
        "“In unplanned incident or architecture calls, I often decide mid-meeting that we need a verbatim transcript for Jira, GitLab, or our local LLM — without hallucinated AI summaries.”",
      p2_li1_html:
        "<strong>Ad-hoc dispatch in 10 seconds:</strong> Paste the meeting URL, pick a duration (30–180 min), and send the bot straight into the live call.",
      p2_li2_html:
        "<strong>Transparent live participation stepper:</strong> See immediately whether the bot is connecting (<code>joining</code>), waiting in the lobby (<code>waiting_admission</code>), or actively capturing tracks (<code>capturing</code>).",
      p2_li3_html:
        "<strong>Grouped speaker turns & clean Markdown export:</strong> Consecutive segments from the same speaker are merged into readable paragraphs — with live full-text <code>&lt;mark&gt;</code> search and 1-click Markdown copy.",
      p2_demo_header: "Interactive Preview · Live Transcript & Instant Filter",
      p2_search_label: "Highlight keyword in transcript:",

      p3_title: "Dr. Thomas – External Host & Data Protection Officer (Compliance & Transparency)",
      p3_quote:
        "“As a host and DPO, I reject black-box bots that secretly capture video, build biometric voiceprints, or rejoin after being removed. With wortlaut, I see immediately who invited the bot and how data is governed.”",
      p3_li1_html:
        "<strong>Active in-meeting chat disclosure & public <code>/privacy</code>:</strong> Upon admission, the bot states who invited it (<code>invited_by</code>) and links to the login-free privacy & opt-out page.",
      p3_li2_html:
        "<strong>Strictly passive audio — zero video, zero biometrics:</strong> Camera and microphone are blocked down to the WebRTC sender layer. No voiceprints, no AI diarization heuristics.",
      p3_li3_html:
        "<strong>Respected boundaries & hard retention TTLs:</strong> Never bypasses CAPTCHAs or waiting rooms, never rejoins after host removal (<code>removed</code>), leaves empty rooms after 5 min (<code>room_empty</code>), and purges raw audio after 24 hours.",
      p3_demo_header: "Authentic Preview · Automated In-Meeting Chat Intro & /privacy",
      p3_chat_msg_html:
        '<strong>wortlaut (Guest):</strong> Hello! I am recording this session to create a written transcript on behalf of <code>mara@mayflower.de</code>.<br>• Audio-only capture (no video, no biometric voiceprints), processed on self-hosted infrastructure.<br>• Transcript (authorized access): <code>https://wortlaut.example.org/ui#view=meetings&amp;id=9f8a…</code><br>• Privacy policy, retention limits (24h raw audio / 30d text) &amp; opt-out (no login required): <code>https://wortlaut.example.org/privacy</code>',

      p4_title: "Nina – Invited Participant & Transcript Reader (Safe Collaboration)",
      p4_quote:
        "“I want to review what was agreed after the meeting — without external chat guests snooping on the link, and without a shared link overwriting my own SSO session.”",
      p4_li1_html:
        "<strong>Protected chat link without open tokens:</strong> The link posted in the meeting chat never embeds a read token, preventing unauthorized access by external meeting guests.",
      p4_li2_html:
        "<strong>Explicit read-only sharing (<code>#token=wortlaut-read-…</code>):</strong> Only when Mara or Lukas explicitly shares a reader link can Nina open the distraction-free reader view without needing an account.",
      p4_li3_html:
        "<strong>Isolated <code>sessionStorage</code> preserves SSO login:</strong> If Nina also has an SSO account, her session stays intact; clicking <em>“Back to my account”</em> returns her to her own workspace anytime.",
      p4_demo_header: "Preview · Distraction-Free Reader Mode (With Speaker Talk-Time Share)",

      p5_title: "Svenja – Platform & DevOps Engineer (Self-Hosted Kubernetes Operator)",
      p5_quote:
        "“I don’t want a fragile 12-microservice zoo or external cloud keys. I want hardened images, isolated ephemeral browser jobs per meeting, deterministic capacity backpressure, and native OTLP telemetry.”",
      p5_li1_html:
        "<strong>Ephemeral, isolated Kubernetes worker Jobs:</strong> Every recording spawns a single Kubernetes Job with a fresh Chromium profile (<code>runAsNonRoot: true</code>, <code>allowPrivilegeEscalation: false</code>); bootstrap Secrets are deleted only after observed pod termination.",
      p5_li2_html:
        "<strong>Deterministic backpressure limits:</strong> Hard caps on concurrent meetings, pending audio samples, stored S3 bytes, and open ASR jobs prevent GPU OOMs and database spikes.",
      p5_li3_html:
        "<strong>Native OpenTelemetry & Grafana observability:</strong> Structured spans (<code>wortlaut.worker.status</code>) expose bound receivers, signaling channels, and machine-readable end reasons (<code>lobby_timeout</code>, <code>human_verification_required</code>).",
      p5_demo_header: "Preview · System & Capacity Backpressure Monitor (OTLP Ready)",

      p6_title: "Tim – Workflow & Integrations Developer (Idempotent REST API)",
      p6_quote:
        "“For our internal ticket and wiki pipelines, I need an idempotent REST API that not only returns word-level timestamps, but also honestly reports audio gaps or unbound sources.”",
      p6_li1_html:
        "<strong>Idempotent dispatch & OpenAPI (<code>/docs</code>):</strong> Safely schedule or start recordings via <code>POST /v1/recordings</code> with <code>Idempotency-Key</code> (<code>HTTP 409</code> on payload mismatch) and scoped reader tokens.",
      p6_li2_html:
        "<strong>Machine-readable quality indicators:</strong> The JSON export includes <code>sources_summary</code>, <code>has_audio_gaps</code>, <code>attribution_unknown</code>, <code>unprocessed_audio</code>, and <code>failed_asr_ranges</code> for reliable downstream LLM pipelines.",
      p6_li3_html:
        "<strong>Four export formats on demand:</strong> <code>/exports/json</code>, <code>/exports/md</code>, <code>/exports/vtt</code> (WebVTT), and <code>/exports/txt</code>.",
      p6_demo_header: "Real API Excerpt · JSON Export with Quality & Source Metrics",

      providers_kicker: "FOUR CONFERENCE PLATFORMS IN PARALLEL",
      providers_title: "Google Meet, Microsoft Teams, Cisco Webex, and Zoom in a single instance",
      providers_desc:
        "No global provider switch: wortlaut detects the platform automatically from the meeting URL or calendar invite and uses each provider’s native single-track capture path.",

      prov_meet_mode: "Playwright/Chromium · Direct WebRTC Single-Track",
      prov_meet_li1_html: "<strong>Audio capture:</strong> Taps every incoming <code>RTCRtpReceiver</code> track prior to mixing via in-browser WebRTC hooks.",
      prov_meet_li2_html: "<strong>Speaker binding:</strong> Maps <code>csi</code>/<code>ssrc</code> from SDP, RTCDataChannel, Fetch/WebSocket roster payloads, and DOM tiles.",
      prov_meet_li3_html: "<strong>Access:</strong> Anonymous guest join or optional mounted browser session Secret (<code>storage-state.json</code>).",

      prov_teams_mode: "Playwright/Chromium · WebRTC Receiver + Signaling",
      prov_teams_li1_html: "<strong>Audio capture:</strong> Separate incoming WebRTC audio streams with strict verification that no sending device is active.",
      prov_teams_li2_html: "<strong>Speaker binding:</strong> Correlates media streams with authenticated participant identities from the Teams roster.",
      prov_teams_li3_html: "<strong>Access:</strong> Direct guest join via meeting join links inside an isolated Kubernetes worker Job.",

      prov_webex_mode: "Browser SDK / WebRTC · Pre-Mix Multistream",
      prov_webex_li1_html: "<strong>Audio capture:</strong> Parallel single-track capture of all remote audio panes prior to mixing.",
      prov_webex_li2_html: "<strong>Speaker binding:</strong> Direct binding to the verified Webex member session across status updates.",
      prov_webex_li3_html: "<strong>Access:</strong> Guest issuer token / Service App or anonymous web client join depending on site policy.",

      prov_zoom_mode: "100% Anonymous Browser Join · WebAudio/Worklet",
      prov_zoom_li1_html: "<strong>Audio capture:</strong> Joins via the Zoom web client (<code>/wc/&lt;id&gt;/join</code>) with pre-mix audio capture hooks.",
      prov_zoom_li2_html: "<strong>Speaker binding:</strong> Tracks WebSocket/roster signaling and active participant session metadata.",
      prov_zoom_li3_html: "<strong>Access:</strong> Works out of the box via meeting URL — zero Zoom Marketplace app or SDK keys required.",

      privacy_kicker: "COMPLIANCE & PRIVACY BY DESIGN",
      privacy_title: "Engineered for strict GDPR, Works Council, and confidentiality requirements",
      privacy_desc:
        "wortlaut never hides. Every capability is built to technically enforce the legitimate expectations of hosts, participants, and Data Protection Officers.",
      priv_card1_title: "Public /privacy Page & Chat Disclosure",
      priv_card1_desc:
        "Upon joining, wortlaut posts the inviter’s email address and a link to /privacy in the meeting chat. Accessible without login, it documents purpose, local architecture, retention TTLs, and opt-out controls.",
      priv_card2_title: "Zero Biometrics & Automated Retention TTLs",
      priv_card2_desc:
        "Because speakers are attributed via technical conference sessions rather than voiceprints, zero biometric data is created. Raw audio is purged from S3 after 24 hours, transcripts after 30 days — or immediately via 1-click deletion.",
      priv_card3_title: "Strict Respect for Admission Boundaries",
      priv_card3_desc:
        "wortlaut never bypasses CAPTCHAs (human_verification_required), waits patiently in waiting rooms, never rejoins after host removal (removed), and automatically leaves empty rooms after 5 minutes (room_empty).",

      arch_kicker: "KUBERNETES ARCHITECTURE",
      arch_title: "Three cleanly separated components — zero microservice sprawl",
      arch_desc:
        "The entire stack consists of the central meeting service, a shared GPU ASR service, and ephemeral Kubernetes Jobs for browser capture.",

      qs_kicker: "OPEN-SOURCE INSTALLATION (AGPL-3.0)",
      qs_title: "Deploy in your own Kubernetes cluster in three steps",
      qs_desc:
        "Clone the repository from GitHub, spin up the local development stack via Tilt, or roll out wortlaut to production using Kustomize / ArgoCD.",
      qs_tab_dev: "1. Quickstart (Tilt / Dev)",
      qs_tab_k8s: "2. Kubernetes (Kustomize / Prod)",
      qs_tab_api: "3. REST API (cURL)",
      qs_prereq_title: "Infrastructure Prerequisites",
      qs_prereq_li1: "Kubernetes cluster (linux/amd64) with namespace RBAC for Jobs, Pods, and Secrets",
      qs_prereq_li2: "1× NVIDIA GPU node for the shared Parakeet ASR service (services/asr)",
      qs_prereq_li3: "PostgreSQL 16+ & S3-compatible object storage (e.g., RustFS or MinIO)",
      qs_prereq_li4: "Optional: Dex OIDC for SSO, Google/M365 OAuth2 credentials, SMTP/IMAP mailbox",
      qs_license_box_title: "Free Software under GNU AGPLv3",
      qs_license_box_desc:
        "The complete source code — including the meeting service, GPU ASR service, Playwright workers, Astryx Web UI, and Kubernetes manifests — is licensed under the GNU Affero General Public License v3.0 on GitHub.",

      footer_tagline:
        "Sovereign open-source meeting transcription with true pre-mix single-track speaker binding and local NVIDIA Parakeet GPU.",
      footer_col_product: "Product & Architecture",
      footer_col_personas: "Personas",
      footer_col_oss: "Open Source",
      footer_copy: "© 2026 Mayflower GmbH · Released under GNU AGPLv3 · wortlaut.cloud"
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
      if (dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });

    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (dict[key] !== undefined) {
        el.innerHTML = dict[key];
      }
    });

    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === currentLang);
    });

    // Update interactive calendar toggle button text
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
      btn.addEventListener("click", () => {
        applyLanguage(btn.getAttribute("data-lang"));
      });
    });
    applyLanguage(detectInitialLang());
  }

  function initPersonaTabs() {
    const buttons = Array.from(document.querySelectorAll(".persona-tab-btn"));
    const panels = Array.from(document.querySelectorAll(".persona-panel"));

    function activatePersona(id) {
      buttons.forEach((btn) => {
        const active = btn.getAttribute("data-persona") === id;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.classList.toggle("active", panel.getAttribute("data-persona-panel") === id);
      });
    }

    buttons.forEach((btn, idx) => {
      btn.addEventListener("click", () => activatePersona(btn.getAttribute("data-persona")));
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const nextIdx =
            e.key === "ArrowRight"
              ? (idx + 1) % buttons.length
              : (idx - 1 + buttons.length) % buttons.length;
          buttons[nextIdx].focus();
          activatePersona(buttons[nextIdx].getAttribute("data-persona"));
        }
      });
    });
  }

  function initCalendarToggleDemo() {
    const extToggle = document.getElementById("demo-external-toggle");
    if (!extToggle) return;
    extToggle.addEventListener("click", () => {
      const isOff = extToggle.classList.toggle("off");
      const dict = I18N[currentLang];
      extToggle.textContent = isOff ? dict.toggle_off : dict.toggle_on;
    });
  }

  function initSearchFilterDemo() {
    const chips = document.querySelectorAll(".demo-search-chip");
    const turns = document.querySelectorAll(".lukas-turn-text");
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const term = chip.getAttribute("data-term") || "";
        chips.forEach((c) => c.classList.toggle("active", c === chip));
        turns.forEach((p) => {
          const raw = p.getAttribute("data-raw") || p.textContent;
          p.setAttribute("data-raw", raw);
          if (!term) {
            p.textContent = raw;
            return;
          }
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(`(${escaped})`, "gi");
          p.innerHTML = raw.replace(regex, "<mark>$1</mark>");
        });
      });
    });
  }

  function initQuickstartTabs() {
    const tabBtns = document.querySelectorAll(".code-tab-btn");
    const panes = document.querySelectorAll(".code-pane");
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-code-tab");
        tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
        panes.forEach((p) => p.classList.toggle("active", p.getAttribute("data-code-pane") === target));
      });
    });
  }

  function initCopyButtons() {
    document.querySelectorAll("[data-copy-target]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const selector = btn.getAttribute("data-copy-target");
        let text = "";
        if (selector === "active-code-pane") {
          const activePane = document.querySelector(".code-pane.active");
          text = activePane ? activePane.textContent.trim() : "";
        } else {
          const el = document.querySelector(selector);
          text = el ? el.textContent.trim() : "";
        }
        if (!text) return;
        navigator.clipboard?.writeText(text).catch(() => {});
        const dict = I18N[currentLang];
        const prev = btn.textContent;
        btn.textContent = dict.copied_btn;
        setTimeout(() => {
          btn.textContent = dict.copy_btn || prev;
        }, 1600);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initLanguageSwitcher();
    initPersonaTabs();
    initCalendarToggleDemo();
    initSearchFilterDemo();
    initQuickstartTabs();
    initCopyButtons();
  });
})();
