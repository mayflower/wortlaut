# Persona-Bewertung & Priorisierter Produkt-Backlog (`backlog.md`)

Grundlage dieses Backlogs ist das Wettbewerbs-Screening aus [`feature_matrix.md`](file:///data/wortlaut/feature_matrix.md), bewertet anhand der fünf Personas aus [`personas.md`](file:///data/wortlaut/personas.md) sowie der Architekturvorgaben aus [`AGENTS.md`](file:///data/wortlaut/AGENTS.md):

- **Mara** – Projekt- & Account-Lead (Kalender- & E-Mail-Workflow)
- **Lukas** – Consultant / Tech-Lead (Ad-hoc Web-UI-Nutzer)
- **Svenja** – Platform- & DevOps-Engineer (Self-Hosted Operator)
- **Dr. Thomas** – Externer Host & Datenschutzverantwortlicher (Compliance-Stakeholder)
- **Tim** – Interner Workflow- & Integrations-Entwickler (API-Konsument)

---

## 1. Bewertung der Wettbewerbs-Features nach Personas

| Feature aus dem Marktvergleich | Mara (Projekt-Lead) | Lukas (Tech-Lead) | Svenja (Operator) | Dr. Thomas (DSB / Host) | Tim (API-Dev) | Entscheidung für `wortlaut` |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Direkter Lese-Link (`wortlaut-read-…`) in Ergebnis-E-Mails** | **++** | **+** | **o** | **+** | **+** | **Umgesetzt (P1-1):** Mara kann aus der Ergebnis-E-Mail ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)) mit einem Klick die Web-Ansicht öffnen und den Link im Projektteam teilen, ohne Anhänge weiterzuleiten. |
| **Markdown-Export (`.md`) & Copy-to-Clipboard neben TXT/VTT/JSON** | **++** | **++** | **o** | **o** | **+** | **Umgesetzt (P1-2):** Lukas und Mara kopieren Protokolle direkt als GFM-Markdown ([`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py), [`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx)) in Confluence, GitLab/GitHub-Issues oder Kundenberichte. |
| **Meeting-übergreifende Volltextsuche (Inhalts- & Sprechersuche)** | **++** | **++** | **o** | **o** | **+** | **Umgesetzt (P1-3):** `GET /v1/recordings?q=` ([`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L615-L665)) durchsucht neben Titel und Gast-Namen auch `TranscriptSegment.result` (Texte & Sprechernamen) in PostgreSQL. |
| **Webhook-Benachrichtigung bei Aufnahme-/Transkript-Abschluss** | **o** | **o** | **+** | **o** | **++** | **Aufnehmen (P1-5):** Erspart Tim permanentes Polling auf `GET /v1/recordings/{id}`, wenn nachgelagerte Workflows (Wiki-Import, lokales LLM) getriggert werden. |
| **E-Mail-Warnung bei Warteraum-Timeout / verweigertem Einlass** | **++** | **+** | **+** | **o** | **o** | **Umgesetzt (P1-4):** Sofort-Benachrichtigung ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py#L311-L376)) direkt nach Abbruch ohne aufgenommene Audiospur (`lobby_timeout`, `admission_denied` etc.) inkl. Direktlink zum erneuten Starten. |
| **Wort-Zeitstempel-Anker & Direktlink auf einzelne Aussagen** | **+** | **++** | **o** | **o** | **+** | **Aufnehmen (P2):** Lukas kann einen Link auf exakt eine Stelle im Protokoll (`#t=142`) in ein Ticket kleben (analog zu Fathom/tl;dv, aber textbasiert). |
| **Vierte Plattform: Zoom Web-Client (WebRTC)** | **++** | **++** | **-** | **o** | **+** | **Aufnehmen (P2):** Häufigster noch fehlender Konferenz-Provider bei externen Kunden; nur zulässig, wenn getrennte Audioquellen im Web-Client nachgewiesen werden. |
| **Gespeicherte Host-/Bot-Sessions für Teams & Webex (wie bei Meet)** | **++** | **++** | **+** | **+** | **o** | **Aufnehmen (P2):** Erlaubt dem Bot in internen Firmen-Termine den Beitritt als authentifizierter Domänen-Nutzer ohne Warteraum-Hürde. |
| **Automatische Live-E2E-Canary-Prüfung für Provider-Änderungen** | **o** | **o** | **++** | **o** | **o** | **Aufnehmen (P2):** Meet, Teams und Webex ändern regelmäßig ihr Web-Frontend. Svenja erkennt Brüche über `make test-live` frühzeitig. |
| **Lokale KI-Zusammenfassung / Action-Items im Cluster** | **++** | **+** | **-** | **-** | **++** | **Nur entkoppelt über Tim (P3):** Keine Halluzinationsgefahr im Primärprotokoll; besser als nachgelagerter Webhook-Consumer gegen ein lokales Cluster-LLM. |
| **OAuth2-Kalender-Integration (Google Workspace & Microsoft 365)** | **++** | **++** | **+** | **+** | **o** | **Aufnehmen (P1-0 – Top-Priorität):** Dedizierter OAuth2-Connect (`Google calendar.readonly` & `Microsoft Graph Calendars.Read`, parallel nutzbar): Auto-Join für selbst organisierte Termine, 1-Klick-Toggle in der UI für externe Termine. |
| **Video-Aufzeichnung (MP4) & Screen-Recording** | **o** | **o** | **--** | **--** | **o** | **Ablehnen (Non-Goal):** Vervielfacht Speicher-/CPU-Last und verschärft die datenschutzrechtliche Eingriffstiefe massiv (Recht am eigenen Bild). |
| **Stimmprofile (Voiceprints) / Akustische Diarisierung** | **o** | **o** | **-** | **--** | **-** | **Strikt verboten (`AGENTS.md`):** Biometrische Stimmprofile verstoßen gegen Dr. Thomas’ Vorgaben und die Architekturregel der nachgewiesenen Teilnehmersitzung. |
| **Nachträgliches manuelles Überschreiben von Sprechernamen** | **+** | **+** | **-** | **--** | **-** | **Ablehnen (`AGENTS.md`):** Das Protokoll bildet die verifizierte Provider-Teilnehmerbindung ab; manuelles Umdeuten von Tonspuren verfälscht den Nachweis. |

---

## 2. Priorisierter Backlog

### Priorität 1 (P1) – Hoher Nutzen für Mara, Lukas & Tim bei minimalem Architektur-Eingriff

#### P1-0: OAuth2-Kalender-Integration für Google Calendar & Microsoft 365 (Offen – Top-Priorität)
- **Ziel-Personas:** Mara, Lukas, Dr. Thomas
- **Problem:** Im Arbeitsalltag möchten Kollegen vor einem Meeting weder `.ics`-Dateien exportieren noch Meeting-Links kopieren; zudem lassen sich bei externen Kundenterminen (bei denen der Kunde `ORGANIZER` ist) keine Bot-E-Mail-Gäste in die fremde Einladung eintragen.
- **Lösung & Umfang:**
  - Dedizierter OAuth2-Kalender-Connect in `wortlaut` (`/v1/calendar/oauth/{google|microsoft}` + Callback) mit minimalen Lese-Scopes (`https://www.googleapis.com/auth/calendar.readonly` und Microsoft Graph `Calendars.Read` + `offline_access`), auch parallel pro Nutzer verknüpfbar.
  - Hintergrund-Synchronisation der anstehenden Termine (Erkennung von Google-Meet-, Microsoft-Teams- und Cisco-Webex-Links in `hangoutLink`, `onlineMeeting`, `location` und `description`).
  - **Regelbasiertes Standardverhalten:**
    1. **Selbst organisierte Termine** (`organizer == verbundener Nutzer`): Automatisch zur Aufzeichnung eingeplant (*Auto-Join*, in der UI jederzeit per 1-Klick-Toggle abwählbar).
    2. **Externe Termine** (fremder Organisator): Erscheinen in der persönlichen Kalenderübersicht in `wortlaut` und lassen sich mit einem **1-Klick-Toggle (`Aufzeichnen: An/Aus`)** aktivieren, ohne dass die externe Gästeliste verändert wird.

#### P1-1: Schreibgeschützter Web-UI-Freigabelink direkt in der Ergebnis-E-Mail (Umgesetzt)
- **Status:** **Umgesetzt** in [`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py#L221-L308), [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L775-L786) (`POST /v1/recordings/{recording_id}/reader-token`) und [`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx#L136-L157).
- **Ziel-Personas:** Mara, Dr. Thomas
- **Lösung:** Ergebnis-E-Mails enthalten neben den Anhängen bzw. Download-Links direkt den klickbaren Web-UI-Reader-Link (`{api_url}/ui#token=wortlaut-read-{recording.id}.{sig}`). Zusätzlich lässt sich der Lese-Link jederzeit in der Detailansicht über *„Lese-Link teilen“* erzeugen.

#### P1-2: Markdown-Export (`.md`) für direkte Weiterverarbeitung in Wikis & Tickets (Umgesetzt)
- **Status:** **Umgesetzt** in [`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py#L411-L484), [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L938-L961), [`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx#L365-L377) und [`TranscriptTab.tsx`](file:///data/wortlaut/worker/src/ui/components/TranscriptTab.tsx#L180-L195).
- **Ziel-Personas:** Lukas, Mara, Tim
- **Lösung:** `GET /v1/recordings/{id}/exports/md` liefert GitHub-Flavored Markdown mit Metadaten, Quellenübersicht und nach Sprecher gruppierten Dialogblöcken. In der Web-UI stehen sowohl der `.md`-Download als auch *„Als Markdown kopieren“* zur Verfügung.

#### P1-3: Meeting-übergreifende Volltext- und Sprechersuche in PostgreSQL (Umgesetzt)
- **Status:** **Umgesetzt** in [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L615-L665), [`models.py`](file:///data/wortlaut/services/meeting/src/wortlaut/models.py#L140-L143) und [`RecordingSidebar.tsx`](file:///data/wortlaut/worker/src/ui/components/RecordingSidebar.tsx#L92).
- **Ziel-Personas:** Mara, Lukas, Tim
- **Lösung:** `GET /v1/recordings?q=…` durchsucht `Recording.title`, `Recording.guest_name` sowie per `EXISTS`-Subquery `TranscriptSegment.result` (Transkript-Texte und Sprechernamen) und `AudioSource.participant_name`.

#### P1-4: Sofortige Benachrichtigungs-E-Mail bei Nicht-Teilnahme (`lobby_timeout`, `admission_denied`) (Umgesetzt)
- **Status:** **Umgesetzt** in [`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py#L311-L376) und [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1081-L1092).
- **Ziel-Personas:** Mara, Svenja
- **Lösung:** Endet eine Aufnahme mit einem Beitritts-/Warteraum-Fehler (`lobby_timeout`, `admission_denied`, `passcode_required`, `human_verification_required` etc.) ohne empfangene Audiosamples, wird unmittelbar eine deutschsprachige Benachrichtigungs-E-Mail mit dem Grund aus `FAILURE_REASONS` und einem Link zur Web-UI an den Organisator gesendet.

#### P1-5: Optionale ausgehende Webhooks bei Aufnahme-Abschluss (Offen)
- **Ziel-Personas:** Tim, Svenja
- **Problem:** Tim möchte interne Pipelines (z. B. automatische Zusammenfassung über ein lokales LLM im Cluster oder Ablage im Projekt-Wiki) exakt dann auslösen, wenn `processing == "completed"` erreicht ist, ohne alle paar Sekunden die REST-API abzufragen.
- **Umfang:**
  - Optionale Einstellung `WORTLAUT_WEBHOOK_URL` (und `WORTLAUT_WEBHOOK_SECRET` für HMAC-Signatur) in [`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py), die nach `finalize_processing` einen signierten JSON-POST mit `recording_id`, `status`, `provider` und einem generierten `reader_token` sendet.
- **Aufwand:** Mittel ([`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py), [`asr.py`](file:///data/wortlaut/services/meeting/src/wortlaut/asr.py) / [`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py), Tests).

---

### Priorität 2 (P2) – Vertiefung der Nutzererfahrung & Plattform-Abdeckung

#### P2-1: Sprungmarken (Deep-Links) auf einzelne Transkript-Segmente (`#t=…`)
- **Ziel-Personas:** Lukas, Mara
- **Problem:** In langen Architektur- oder Kundenterminen möchte Lukas in einem Ticket genau auf eine Aussage bei Minute `14:20` verweisen können.
- **Umfang:**
  - Klick auf den Zeitstempel eines Dialogblocks in `TranscriptTab.tsx` kopiert den Direktlink (inkl. `#token=…&seg=<id>`) und scrollt beim Öffnen automatisch zum hervorgehobenen Abschnitt.
- **Aufwand:** Klein (reine UI-Erweiterung in `TranscriptTab.tsx`).

#### P2-2: Authentifizierte Bot-Browser-Sessions für Microsoft Teams & Cisco Webex
- **Ziel-Personas:** Mara, Lukas, Svenja, Dr. Thomas
- **Problem:** Für Google Meet unterstützt `wortlaut` bereits `WORTLAUT_MEET_STORAGE_STATE_SECRET`, damit der Bot in internen Terminen ohne Lobby-Blockade beitreten kann. Bei internen Teams- oder Webex-Räumen mit strikter Gast-Sperre wartet der Bot sonst im Warteraum.
- **Umfang:**
  - Optionale `storageState`-Unterstützung analog zu Google Meet auch für `teams-browser.ts` (`WORTLAUT_TEAMS_STORAGE_STATE_SECRET`) und `webex-browser.ts` (`WORTLAUT_WEBEX_STORAGE_STATE_SECRET`).
- **Aufwand:** Mittel (`settings.py`, `controller.py`, `teams-browser.ts`, `webex-browser.ts`).

#### P2-3: Automatisierter Live-Provider-Gesundheitscheck (`make test-live`) für Svenja
- **Ziel-Personas:** Svenja
- **Problem:** Konferenzanbieter ändern regelmäßig DOM-Selektoren und WebRTC-Signaling. Svenja benötigt einen schnellen Weg, alle drei Provider (`google_meet`, `teams`, `webex`) gegen die dauerhaften Testräume zu verifizieren.
- **Umfang:**
  - Bereits angelegt als `make test-live` (`worker/test/live-provider-e2e.ts`); kann optional als manueller oder zeitgesteuerter Prüf-Job dokumentiert und im System-Tab (`SystemView.tsx`) mit dem letzten Prüfergebnis angezeigt werden.
- **Aufwand:** Klein.

#### P2-4: Evaluierung Zoom Web-Client (nur bei nachgewiesener Einzelspur-Signalisierung)
- **Ziel-Personas:** Mara, Lukas
- **Problem:** Zoom ist im Markt der vierte große Anbieter neben Meet, Teams und Webex.
- **Architektur-Bedingung (`AGENTS.md`):** Darf nur freigegeben werden, wenn im Zoom-Web-Client getrennte Audioquellen bzw. belastbare Teilnehmer-Signalisierung vor dem Mix ohne Diarisierungs-Heuristik nachgewiesen werden können.
- **Aufwand:** Groß (eigener Spike + Worker-Implementierung).

---

### Priorität 3 (P3) – Optionale Erweiterungen über externe Integrationen

#### P3-1: Referenz-Integration für lokale LLM-Zusammenfassungen (über Tims API)
- **Ziel-Personas:** Tim, Mara
- **Architektur-Prinzip:** `wortlaut` selbst bleibt die verlässliche, halluzinationsfreie Quelle für das wörtliche Protokoll (`AGENTS.md`: *„Keine zusätzlichen Frameworks, Dienste pro Modul … kleinste passende Änderung“*).
- **Umfang:** Ein schlankes Beispiel-Skript / Webhook-Rezept für Tim, das über `GET /v1/recordings/{id}/exports/json` (mit `wortlaut-read-…`) das fertige Transkript abruft, gegen einen lokalen OpenAI-kompatiblen Endpoint im Cluster (vLLM / Ollama) zusammenfasst und prüfbare Quellen-Zitate auf die Segment-Zeitstempel setzt.

---

## 3. Bewusste Abgrenzung (Anti-Backlog / Non-Goals)

Folgende Features kommerzieller Konkurrenten werden **bewusst nicht** implementiert:
1. **Keine akustische Diarisierung oder Voiceprints** (verstößt gegen [`AGENTS.md`](file:///data/wortlaut/AGENTS.md) und **Dr. Thomas**’ Datenschutzanforderungen).
2. **Keine Active-Speaker-DOM-Namensheuristiken als Ersatz für WebRTC-Quellenbindung** (`AGENTS.md`).
3. **Keine Video- oder Bildschirm-Aufzeichnung** (unverhältnismäßiger Eingriff in Persönlichkeitsrechte und Speicherbedarf).
