# Server- & SaaS-Wettbewerbsanalyse: Meeting-Aufzeichnung & Transkription (`feature_matrix.md`)

Diese Übersicht vergleicht ausschließlich **Server-, Bot- und SaaS-basierte Lösungen** (keine lokalen Desktop-Systemaudio-Recorder wie Granola, Meetily, Hyprnote oder Jamie).

---

## 1. Marktsegmente im Überblick

1. **US-SaaS Endnutzer-Plattformen:** Fireflies.ai, Otter.ai, Fathom, tl;dv, Read.ai, Fellow.app, Avoma
2. **Europäische / DSGVO-fokussierte SaaS- & On-Prem-Plattformen:** Tucan.ai (DE), Sally.io (DE), Leexi (BE), Claap (FR)
3. **Kommerzielle Bot-as-a-Service (BaaS) APIs:** Recall.ai, Meeting BaaS, Skribby
4. **Open-Source Self-Hosted Server/Bot-Systeme:** Attendee (`attendee-labs/attendee`), Vexa (`Vexa-ai/vexa`), ScreenApp (`screenappai/meeting-bot`)
5. **`wortlaut` (Eigene Lösung):** Selbstgehosteter Kubernetes-Dienst mit isolierten Playwright/WebRTC-Workern und lokaler Parakeet-GPU-ASR.

---

## 2. Detail-Feature-Matrix: Architektur, Plattformen & Betrieb

| Kriterium / Feature | `wortlaut` | Attendee (OSS) | Vexa (OSS) | Recall.ai (BaaS API) | Meeting BaaS (API) | Tucan.ai (EU SaaS / On-Prem) | Sally.io (EU SaaS) | Fireflies.ai (US SaaS) | Otter.ai (US SaaS) | Fathom / tl;dv (US SaaS) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Kategorie** | Self-Hosted App + API | Open-Source Bot API | Open-Source Bot API | Kommerzielle Bot API | Kommerzielle Bot API | Endnutzer-SaaS & Enterprise On-Prem | Endnutzer-SaaS (DACH) | Endnutzer-SaaS | Endnutzer-SaaS | Endnutzer-SaaS |
| **Lizenz / Modell** | Proprietär / Intern (Self-Hosted) | Apache-2.0 (Self-Hosted) | Apache-2.0 (Self-Hosted & Cloud) | Proprietär (Pay-per-Minute API) | Proprietär + Teil-OSS (Pay-per-Min) | Proprietär (SaaS Abo / Enterprise) | Proprietär (SaaS Abo) | Proprietär (SaaS Abo) | Proprietär (SaaS Abo) | Proprietär (Freemium / SaaS Abo) |
| **Hosting & Datensouveränität** | **100 % eigener K8s-Cluster** (inkl. GPU) | Eigener Server (Docker/K8s), nutzt oft externe STT-APIs | Eigener Server (Docker/K8s) mit lokalem WhisperLive | US/EU AWS Cloud (kein Self-Hosting) | EU/US Cloud | EU-Cloud (Hetzner) oder **On-Premise** auf Anfrage | EU-Cloud (Hetzner DE), kein Self-Hosting | US-Cloud (AWS) + externe LLMs | US-Cloud (AWS) | US-Cloud |
| **Google Meet** | **Ja** (WebRTC Einzelspuren) | **Ja** (Headless Chrome) | **Ja** (Headless Browser) | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** |
| **Microsoft Teams** | **Ja** (WebRTC + CSI-Rebind) | **Ja** (Web-Bot) | **Ja** (Web-Bot) | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** |
| **Cisco Webex** | **Ja** (WebRTC Multistream + DataChannel) | **Ja** (Basis-Bot, neueres Feature) | **Nein** (nur Meet/Teams/Zoom) | **Ja** (aber **ohne** Einzelspuren) | **Eingeschränkt** (Fokus auf Meet/Teams/Zoom) | **Ja** | **Ja** | **Ja** | **Nein** (nur Zoom/Meet/Teams) | **Nein** (Fokus auf Zoom/Meet/Teams) |
| **Zoom** | Nein | **Ja** (Zoom SDK) | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** |
| **Audio-Erfassung im Bot** | **Getrennte `RTCRtpReceiver`-Tracks vor dem Mix** | Virtuelle Audio-Pipelines / DOM-Caption-Abgriff | Virtueller Audio-Sink (PulseAudio) | Getrennte Streams (Meet/Teams/Zoom), Mix bei Webex | Überwiegend gemischter Stream + Cloud-STT | Gemischter Stream + Active-Speaker / Diarisierung | Gemischter Stream + Diarisierung | Gemischter Stream + Active-Speaker / Diarisierung | Gemischter Stream + Voiceprint-Diarisierung | Gemischter Stream + Active-Speaker |
| **Sprecher-Identität (Attribution)** | **Signalisierte Provider-Session (RTP CSRC/SSRC + DataChannel)** | Active-Speaker DOM-Observer / Caption-Scraping | Active-Speaker UI-Scraping + Whisper | Stream-Mapping (Meet/Teams/Zoom); UI-Fallback (Webex) | Cloud-STT Diarisierung (Deepgram, Gladia) | Diarisierung + Teilnehmerliste | Diarisierung + Teilnehmerliste | Diarisierung + Active-Speaker | Proprietäre Diarisierung + Stimmprofile | Active-Speaker-Kachel + Diarisierung |
| **Echte Einzelspuren bei Webex** | **Ja** (`AUDIO-MAIN` Slots + `activeSpeakerNotification`) | Nein | Kein Webex-Support | **Nein** (laut Recall-Doku für Webex nicht verfügbar) | Nein | Nein | Nein | Nein | Kein Webex-Support | Kein Webex-Support |
| **Spracherkennung (ASR-Engine)** | **Lokal im Cluster (NVIDIA Parakeet)** | Externe APIs (Gladia, Deepgram, OpenAI) oder Whisper | Lokales Whisper / WhisperLive | Bring-Your-Own-STT (Deepgram, AssemblyAI etc.) | Deepgram, Gladia, AssemblyAI, Soniox | Eigene / EU-gehostete Whisper-Derivate | Cloud-STT (100+ Sprachen) | Cloud-STT (100+ Sprachen) | Otter proprietäres Cloud-ASR | Cloud-STT |

---

## 3. Detail-Feature-Matrix: Produktfunktionen, Workflows & Exporte

| Kriterium / Feature | `wortlaut` | Attendee (OSS) | Vexa (OSS) | Recall.ai / Meeting BaaS | Tucan.ai | Sally.io | Fireflies.ai | Otter.ai | Fathom / tl;dv |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Integrierte Web-UI** | **Ja** (Operator-Workspace + Reader-Ansicht) | Nur Admin-/Debug-Ansicht (primär REST-API) | Keine Endnutzer-UI (reine API / MCP) | Nur Entwickler-Dashboard (reine API) | **Ja** (Vollständige SaaS-UI) | **Ja** (Vollständige SaaS-UI) | **Ja** (Vollständige SaaS-UI) | **Ja** (Web + Mobile App) | **Ja** (Vollständige SaaS-UI) |
| **Ad-hoc Start per Meeting-Link** | **Ja** (UI + REST API) | **Ja** (REST API) | **Ja** (REST API) | **Ja** (REST API) | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** |
| **Kalender-Einladung per E-Mail / `.ics`** | **Ja** (IMAP-Postfach mit DKIM/Gateway-Prüfung + `.ics`/`.eml`-Upload + RRULE-Serientermine) | Über OAuth-Kalender-Integration (Google/MS) | Nein (extern zu lösen) | Über OAuth-Calendar-Sync-API | **Ja** (Bot-E-Mail + OAuth-Kalender) | **Ja** (`invite@sally.io` + OAuth-Kalender) | **Ja** (`fred@fireflies.ai` + OAuth-Kalender) | **Ja** (OAuth-Kalender) | **Ja** (OAuth-Kalender) |
| **OAuth-Kalender-Auto-Sync (Google/M365)** | Nein (bewusst entkoppelt über IMAP/`.ics`) | **Ja** | Nein | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** |
| **Echtzeit-Transkript (Live während Call)** | **Ja** (Live-Segmente in der UI & API) | **Ja** (per WebSocket/Webhook) | **Ja** (per WebSocket) | **Ja** (per WebSocket) | Teilweise | Nein (Fokus auf Post-Call) | **Ja** (*Live Assist*) | **Ja** (Otter Live Notes) | **Ja** |
| **Video-Aufzeichnung & Video-Clips** | **Nein** (bewusst nur Audio für Datenschutz & geringe Last) | **Ja** (MP4-Aufzeichnung) | Nein (Audio/Text) | **Ja** (MP4 + Roh-Video) | **Ja** (optional) | **Ja** (optional) | **Ja** (inkl. *Soundbites*) | Nein (Audio + Folien-Screenshots) | **Ja** (Kernfeature: Video-Reels/Clips) |
| **KI-Zusammenfassung & Action Items (LLM)** | **Nein** (reines, unverfälschtes Wortprotokoll ohne Halluzinationen) | Nein (Aufgabe der nutzenden App) | Über MCP-Anbindung an externe LLMs | Über nachgelagerte LLM-APIs | **Ja** (konfigurierbare Templates) | **Ja** (Aufgaben, Zusammenfassung) | **Ja** (*Super Summaries*, Custom Prompts) | **Ja** (Automated Summary, Action Items) | **Ja** (Templates für Sales/CS) |
| **Globale KI-Chat-Suche über Meetings** | **Volltext- & Filter-Suche** (kein halluzinierender LLM-Chat) | Nein | Über MCP | Nein | **Ja** (*Ask Tucan*) | **Ja** | **Ja** (*AskFred*) | **Ja** (*Otter AI Chat*) | **Ja** |
| **CRM- & Tool-Integrationen (HubSpot, Jira, Slack)** | E-Mail-Zustellung (SMTP) + JSON-API | Webhooks | Webhooks + MCP | Webhooks | **Ja** (CRM, Confluence, SharePoint) | **Ja** (HubSpot, Salesforce, Pipedrive, Teams) | **Ja** (50+ native Integrationen) | **Ja** (Salesforce, HubSpot, Slack) | **Ja** (Salesforce, HubSpot, Notion) |
| **Exporte (`.txt`, `.vtt`, `.md`, `.json`)** | **Ja** (`.txt`, `.vtt`, `.md` Markdown, `.json` mit Wort-Zeitstempeln in [`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py)) | JSON via API | JSON via API | JSON / Roh-PCM / MP4 via API | PDF, Word, TXT, SRT, JSON | PDF, Word, TXT | PDF, DOCX, SRT, VTT, CSV, JSON | TXT, DOCX, PDF, SRT | TXT, DOCX, Video-Clips |
| **Authentifizierung & Freigabe-Links** | **Ja** (Dex OIDC SSO mit Nutzer-Isolation in [`oidc.py`](file:///data/wortlaut/services/meeting/src/wortlaut/oidc.py) + `wortlaut-read-…` Lese-Links pro Aufnahme ohne Account-Zwang) | Nein (nur API) | Nein (nur API) | Nein (nur API) | **Ja** | **Ja** | **Ja** | **Ja** | **Ja** (inkl. Clip-Sharing) |
| **Automatische Roh-Audio-Löschfrist** | **Ja** (Standard: Roh-Audio nach 24h, Transkript nach 30d gelöscht) | Manuell / Bucket-Lifecycle | Nach Session-Ende (Streaming) | Konfigurierbar (Retention-Policy per API) | Konfigurierbar (DSGVO-Policies) | Konfigurierbar | Nur manuell / Enterprise-Policy | Nur manuell / Enterprise-Policy | Nur manuell |

---

## 4. Technische Einordnung: Wo steht `wortlaut` im Vergleich?

### A. Gegenüber Open-Source-Serverlösungen (`Attendee`, `Vexa`)
- **Stärken von `wortlaut`:**
  1. **Echte WebRTC-Einzelspur-Erfassung & Signalisierungs-Bindung (auch für Webex):** `Vexa` unterstützt kein Webex und mischt das Browser-Audio über virtuelle Soundkarten. `Attendee` ist eine reine Entwickler-API ohne Endnutzer-UI, braucht externe STT-Dienste (wie Gladia/Deepgram) für gute Ergebnisse und verlässt sich im Browser stark auf DOM-Scraping aktiver Sprecherkacheln.
  2. **Komplettes Endnutzer-Produkt statt reiner API:** `wortlaut` bringt Web-UI, Kalender-Import (`.ics`/IMAP inkl. DKIM-Prüfung und `RRULE`-Serientermine), lokale GPU-Transkription (Parakeet), SMTP-Ergebnisversand und schreibgeschützte Lese-Links (`wortlaut-read-…`) in einem einzigen System mit.
- **Was `Attendee` / `Vexa` zusätzlich haben:**
  - Unterstützung für **Zoom** (über das native Zoom Meeting SDK).
  - `Attendee` unterstützt optional **Video-Aufzeichnung (MP4)** und **bidirektionale Voice-Agents** (der Bot kann selbst Audio in das Meeting einspeisen).

### B. Gegenüber kommerziellen Bot-APIs (`Recall.ai`, `Meeting BaaS`)
- **Stärken von `wortlaut`:**
  1. **Keine Minutenpreise & kein US-Cloud-Zwang:** `Recall.ai` kostet ca. 0,30–0,70 USD pro Meeting-Stunde (zzgl. STT-Kosten) und verarbeitet alle Medienströme in der Cloud von Recall.
  2. **Getrennte Sprecher-Streams bei Webex:** Selbst `Recall.ai` dokumentiert offiziell, dass separate Teilnehmer-Audioströme für Webex nicht unterstützt werden – `wortlaut` löst dies direkt über die Webex-Multistream-DataChannel-Signalisierung (`activeSpeakerNotification` + `mediaSessions`) und Receiver-SSRC-Bindung.

### C. Gegenüber kommerziellen SaaS-Suiten (`Fireflies`, `Otter`, `Tucan.ai`, `Sally.io`)
- **Stärken von `wortlaut`:**
  1. **Verifizierte Sprecheridentität ohne Stimm-Profile:** Kein Erraten von Sprechern über akustische Diarisierung, sondern direkte Bindung an den WebRTC-Empfangskanal der Teilnehmersitzung.
  2. **Strikte Datensparsamkeit:** Kein Abfluss an Drittanbieter-LLMs, keine OAuth-Vollfreigabe auf Firmenkalender nötig (gezielte Einladung per `.ics` oder Bot-Mailadresse genügt), automatische Roh-Audio-Löschung nach 24 Stunden.
- **Was kommerzielle SaaS-Suiten zusätzlich bieten (mögliche Roadmap-Felder für `wortlaut`):**
  1. **Optionale lokale LLM-Nachbereitung:** Automatische Zusammenfassung, Entscheidungen & Action-Items nach dem Call (bei `wortlaut` aktuell bewusst nicht enthalten, könnte aber lokal im Cluster ergänzt werden).
  2. **Zoom-Unterstützung** als vierte Plattform neben Meet, Teams und Webex.
  3. **Sprecher-Umbenennung in der UI:** Falls ein Gast im Meeting nur als anonymer Teilnehmer oder mit Kürzel beigetreten ist, erlauben Tools wie Fireflies/Tucan das nachträgliche Umbenennen eines Sprechers für das gesamte Transkript.
