# Nutzerpersonas

Dieses Dokument beschreibt die sechs zentralen Personas für `wortlaut`, ihre Erwartungshaltung aus bekannten Markt- und SaaS-Lösungen (Fireflies, Otter, Fathom, Tucan, Recall.ai, Attendee/Vexa) sowie ihre konkreten Hauptnutzungsanforderungen an das System.

---

## 1. Mara – Projekt- & Account-Lead (Kalender- & E-Mail-Workflow)

### Profil & Kontext
- Koordiniert laufende Kunden- und Projekttermine über wechselnde Videokonferenzsysteme hinweg (Google Meet, Microsoft Teams, Cisco Webex), je nachdem, welchen Stack der jeweilige Kunde vorgibt.
- Unterliegt strengen Vertraulichkeits- und DSGVO-Vorgaben: US-Cloud-Bots von Drittanbietern (wie Fireflies oder Otter) dürfen nicht in Kundentermine eingeladen werden.
- Möchte ihren Google-Workspace- und/oder Microsoft-365-Kalender direkt per OAuth (`calendar.readonly` / `Calendars.Read`) in `wortlaut` verbinden, damit eigene Termine automatisch protokolliert werden und externe Kundentermine mit einem einzigen Klick zugeschaltet werden können – ohne den Bot als sichtbaren Gast in fremde Kundeneinladungen eintragen zu müssen.

### Typischer Ablauf
1. Verbindet einmalig ihren Google- und/oder Microsoft-365-Kalender per OAuth2 in `wortlaut` (oder nutzt ergänzend die Bot-E-Mail-Einladung / `.ics`-Upload in [`CalendarWorkspace.tsx`](file:///data/wortlaut/worker/src/ui/components/CalendarWorkspace.tsx)):
   - **Selbst organisierte Termine** mit Meet-/Teams-/Webex-Link werden automatisch für den Bot eingeplant (mit 1-Klick-Opt-out).
   - **Externe Kundentermine** erscheinen in ihrer persönlichen Kalenderübersicht und werden bei Bedarf mit einem **1-Klick-Toggle (`Aufzeichnen: An/Aus`)** aktiviert.
2. Lässt den Bot bei Bedarf aus dem Warteraum in das Meeting ein; der Bot stellt sich anschließend automatisch im Meeting-Chat mit Maras E-Mail-Adresse als Einladende sowie Links zu Protokoll und Datenschutz-Info (`/privacy`) vor ([`build_chat_intro`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1214-L1231)).
3. Erhält nach Gesprächsende automatisch die fertigen Transkripte per E-Mail ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)), teilt bei Bedarf einen schreibgeschützten Lese-Link (`#token=wortlaut-read-…`) mit Teilnehmenden oder löscht vertrauliche Aufnahmen nach der Auswertung sofort endgültig ([`delete_recording`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1090-L1128)).

### Hauptnutzungsanforderungen
- **OAuth2-Kalender-Integration für Google & Microsoft 365 (parallel nutzbar)**: Direkter Read-Only-Kalender-Connect (`Google calendar.readonly` & `Microsoft Graph Calendars.Read`) pro Nutzer mit klarer Regel: **Auto-Join für selbst organisierte Termine**, **1-Klick-Toggle in der UI für externe Termine** (ergänzend zu IMAP/`.ics`).
- **Provider-Unabhängigkeit ohne Umschalten**: Einladungen für Google Meet ([`capture.ts`](file:///data/wortlaut/worker/src/meet/capture.ts)), Microsoft Teams ([`teams-browser.ts`](file:///data/wortlaut/worker/src/teams-browser.ts)) und Cisco Webex ([`webex-browser.ts`](file:///data/wortlaut/worker/src/webex-browser.ts)) müssen über denselben Posteingang erkannt und parallel verarbeitet werden ([`calendar.py`](file:///data/wortlaut/services/meeting/src/wortlaut/calendar.py)). *(Bekannte Systemgrenze gegenüber SaaS-Suiten: Zoom wird aktuell nicht unterstützt.)*
- **Zuverlässige Kalender-Synchronisation**: Änderungen an Terminzeiten, verschobene Einzeltermine einer Serie sowie Absagen (`CANCEL`) müssen automatisch übernommen werden, ohne doppelte Bots zu starten ([`recurrence.py`](file:///data/wortlaut/services/meeting/src/wortlaut/recurrence.py)).
- **Automatischer Ergebnisversand & Lese-Link**: Nach Abschluss der lokalen Spracherkennung werden `TXT`-, `WebVTT`-, `Markdown` (`.md`)- und `JSON`-Transkripte ([`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py)) sowie ein direkter schreibgeschützter Web-UI-Lese-Link (`#token=wortlaut-read-…`) an die verifizierte Organisator-Adresse zugestellt ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)).
- **Klare Rückmeldung bei Nicht-Teilnahme**: Wenn der Bot nicht eingelassen wird (`lobby_timeout`, `admission_denied`), einen Passcode/Login benötigt oder keine Audiospur empfängt, wird sofort eine verständliche Benachrichtigungs-E-Mail mit dem konkreten Abbruchgrund versendet ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)).
- **Sprecherzuordnung aus dem Meeting (und Umbenennungs-Bedarf bei anonymen Gästen)**: Im Transkript erscheinen die im Meeting signalisierten Teilnehmernamen; für Gäste, die nur als *„Gast“* oder Konferenzraum-Kachel beigetreten sind, erwartet Mara perspektivisch eine einfache nachträgliche Sprecher-Umbenennung.
- **Sofortige Löschmöglichkeit (Right to Erasure)**: Beendete oder stornierte Aufnahmen samt Roh-Audio und Transkript müssen jederzeit per Klick in der Web-UI (`DELETE /v1/recordings/{id}`, [`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx#L240-L276)) vor Ablauf der automatischen Aufbewahrungsfrist gelöscht werden können.
- **Persönliche Mandantentrennung (Dex OIDC)**: Meldet sich Mara per SSO (Dex OIDC, [`oidc.py`](file:///data/wortlaut/services/meeting/src/wortlaut/oidc.py)) in der Web-UI an, sieht sie ausschließlich ihre eigenen Aufnahmen und Kalendereinladungen (`owner_sub` / `owner_email`).

---

## 2. Lukas – Consultant / Tech-Lead (Ad-hoc Web-UI-Nutzer)

### Profil & Kontext
- Nimmt regelmäßig an ungeplanten Architektur-, Incident- oder Abstimmungs-Calls teil, für die keine vorab importierte Kalendereinladung existiert.
- Entscheidet oft erst wenige Minuten vor oder während eines laufenden Gesprächs, dass eine Aufzeichnung zur Dokumentation in Jira, Confluence, GitLab oder zur Weiterverarbeitung in einem lokalen LLM benötigt wird.

### Typischer Ablauf
1. Öffnet die integrierte Web-UI (`/ui`, [`App.tsx`](file:///data/wortlaut/worker/src/ui/App.tsx)), meldet sich per Dex OIDC SSO an ([`WelcomeLandingView.tsx`](file:///data/wortlaut/worker/src/ui/components/WelcomeLandingView.tsx)), fügt den Meeting-Link ein, wählt bei längeren Workshops die passende Aufnahmedauer ([`HomeView.tsx`](file:///data/wortlaut/worker/src/ui/components/HomeView.tsx)) und startet den Bot im Modus *Sofort aufzeichnen*.
2. Prüft im Live-Banner ([`ParticipationStepper.tsx`](file:///data/wortlaut/worker/src/ui/components/ParticipationStepper.tsx)), ob der Bot im Warteraum wartet oder bereits Audio und Teilnehmer erfasst; im Meeting-Chat stellt sich der Bot automatisch im Namen von Lukas vor.
3. Durchsucht das Transkript noch während oder unmittelbar nach dem Call im Browser ([`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx), [`TranscriptTab.tsx`](file:///data/wortlaut/worker/src/ui/components/TranscriptTab.tsx)), kopiert strukturierte Dialogblöcke oder lädt den Markdown-/Text-Export (`.md`, `.txt`, `.vtt`, `.json`) für die Nachbereitung herunter.

### Hauptnutzungsanforderungen
- **Schneller Ad-hoc-Dispatch mit transparenter Aufnahmedauer**: Start eines Bots mit wenigen Klicks direkt über die Web-UI inkl. frei wählbarem Meeting-Titel (`title`), Bot-Anzeigenamen (`guest_name`) und klar sichtbarer Aufnahmedauer.
- **Transparenter Live-Status**: Sofortige Sichtbarkeit in der UI, ob der Bot beitritt (`joining`), im Warteraum auf Einlass wartet (`waiting_admission`) oder aktiv aufzeichnet (`capturing`), inklusive Anzahl aktiver Streams, gebundener Receiver mit Teilnehmernamen und empfangener Audiosekunden.
- **Fortschreitendes Live-Transkript & präzise Volltextsuche**: Bereits während des laufenden Meetings erscheinen fertig transkribierte Segmente in der UI, sind nach Sprecher/Quelle filterbar und per Volltextsuche mit visueller Treffer-Hervorhebung (`<mark>`) durchsuchbar.
- **Reibungslose Weiterverarbeitung ohne Zwangs-Halluzinationen**: Da `wortlaut` bewusst auf ungeprüfte Cloud-LLM-Zusammenfassungen verzichtet, benötigt Lukas saubere Markdown-Exporte (`.md`) und gruppiertes Kopieren in die Zwischenablage, um das Wortprotokoll direkt in eigene Tickets, ADRs oder lokale KI-Assistenten zu übernehmen.
- **Manuelle Steuerung & Rejoin im Ausnahmefall**: Möglichkeit, eine laufende Aufnahme über die UI zu beenden (`cancel`), nach einem Warteraum-Timeout oder versehentlichem Rauswurf erneut beizutreten (`rejoin`, [`rejoin_recording`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1130-L1160)), beendete Test-Aufnahmen zu löschen (`DELETE`) oder einen fehlgeschlagenen E-Mail-Versand erneut anzustoßen (`delivery/retry`).

---

## 3. Svenja – Platform- & DevOps-Engineer (Self-Hosted Operator)

### Profil & Kontext
- Betreibt `wortlaut` im eigenen Kubernetes-Cluster (`data`) mit lokaler NVIDIA-Parakeet-GPU, PostgreSQL und S3-kompatiblem Objektspeicher (RustFS).
- Hat Open-Source-Alternativen (`Attendee`, `Vexa`) und kommerzielle Bot-APIs (`Recall.ai`) evaluiert, benötigt aber eine **komplett selbstgehostete Komplettlösung** ohne externe Cloud-STT-Abhängigkeiten (wie Deepgram/Gladia/OpenAI), mit echter Webex-Einzelspur-Unterstützung und fertiger Endnutzer-UI inklusive Dex-OIDC-SSO.
- Verantwortet Betriebsstabilität, Container-Security (Trivy), Secret-Management, Ingress/TLS, E-Mail-Authentifizierung (DKIM/Gateway) und Observability im bestehenden Grafana/Alloy/Tempo/Loki-Stack.

### Typischer Ablauf
1. Konfiguriert Provider-Zugänge (`.dev/*.env`, optionale gespeicherte Browser-Session für Google Meet), Dex-OIDC-Client und Mail-Anbindung.
2. Überwacht Aufnahmen, Worker-Jobs, GPU-Auslastung und WebRTC-Signaling über die Admin-Ansicht ([`SystemView.tsx`](file:///data/wortlaut/worker/src/ui/components/SystemView.tsx)), das Grafana-Dashboard und die API.
3. Analysiert bei Provider-Änderungen (z. B. geändertes DOM oder neue Signaling-Kanäle in Meet/Teams/Webex) die erfassten Diagnose- und Telemetriedaten.

### Hauptnutzungsanforderungen
- **Strikte Isolation, gehärtete Base-Images & sichere Zugangsdaten**: Ein kurzlebiger Kubernetes-Job mit isoliertem Chromium-Profil pro Aufnahme ([`controller.py`](file:///data/wortlaut/services/meeting/src/wortlaut/controller.py)); gepinnte, Trivy-geprüfte Container-Images (`runAsNonRoot: true`, `allowPrivilegeEscalation: false`); Bootstrap-Secrets werden erst nach beobachteter Pod-Terminierung gelöscht; keine Token oder Zugangsdaten in Logs, URLs oder ConfigMaps; Admin-Berechtigung über `WORTLAUT_OIDC_ADMIN_EMAILS` oder `WORTLAUT_API_TOKEN` ([`oidc.py`](file:///data/wortlaut/services/meeting/src/wortlaut/oidc.py), [`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py)).
- **Begrenzte Kapazitäten & Backpressure**: Feste Obergrenzen für gleichzeitige Meetings (`max_active_meetings`), aktive Audio-Quellen, unsegmentiertes Audio und offene ASR-Jobs ([`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py), [`SystemView.tsx`](file:///data/wortlaut/worker/src/ui/components/SystemView.tsx)), damit Lastspitzen weder Datenbank noch GPU-Speicher überlasten.
- **Nahtlose OTLP- & Loki-Telemetrie**: Strukturierte Logs und OpenTelemetry-Traces (`wortlaut.worker.status`) für Receiver-Bindungen, erkannte DOM-/Signaling-Teilnehmer, SDP-Beschreibungen und DataChannel-/HTTP-/WebSocket-Signaling direkt im bestehenden Grafana-Stack ([`DiagnosticsTab.tsx`](file:///data/wortlaut/worker/src/ui/components/DiagnosticsTab.tsx), [`SourcesTab.tsx`](file:///data/wortlaut/worker/src/ui/components/SourcesTab.tsx)).
- **Eindeutige Fehlerklassifikation**: Präzise maschinenlesbare Endgründe (`end_reason` / `participation_reason` wie `human_verification_required`, `auth_session_missing`, `teams_sending_device_active`, `audio_clock_interrupted`, `room_empty` in [`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)) statt generischer Abstürze.

---

## 4. Dr. Thomas – Externer Host & Datenschutzverantwortlicher (Compliance-Stakeholder)

### Profil & Kontext
- Leitet als Gastgeber ein Meeting auf Kundenseite oder prüft als Datenschutzbeauftragter (DSB), unter welchen Bedingungen der `wortlaut`-Bot an vertraulichen Besprechungen teilnehmen darf.
- Ist durch US-SaaS-Bots (wie Fireflies, Read.ai oder Otter), die sich ungefragt in Meetings einklinken, Videos aufzeichnen, Stimmprofile bilden und Daten in US-Clouds übertragen, stark sensibilisiert („Shadow-AI-Skepsis“).

### Berührungspunkte
1. Sieht den Bot mit seinem Anzeigenamen im Warteraum und entscheidet über den Einlass.
2. Liest unmittelbar nach dem Beitritt des Bots dessen **Vorstellungsnachricht im Meeting-Chat** ([`build_chat_intro`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1214-L1231)), aus der klar hervorgeht, **wer** den Bot eingeladen hat (`invited_by`), und öffnet ohne Login die verlinkte öffentliche **Datenschutz- & Transparenzseite (`/privacy`)** ([`ui.py`](file:///data/wortlaut/services/meeting/src/wortlaut/ui.py#L9-L115)).
3. Beobachtet während des Meetings, dass der Bot ausschließlich zuhört, jederzeit über die Teilnehmerliste entfernt werden kann (`removed`) und den Raum automatisch verlässt, sobald alle anderen Teilnehmer gegangen sind (`room_empty`).

### Hauptnutzungsanforderungen
- **Aktive Transparenz im Meeting-Chat & unter `/privacy`**: Sofortige Nennung der einladenden Person im Konferenz-Chat sowie ein öffentlich abrufbarer Datenschutzhinweis (`/privacy`), der Architektur, lokale Verarbeitung, Löschfristen und Widerspruchsmöglichkeit ohne Login erläutert.
- **Klar erkennbarer, rein passiver Audio-Teilnehmer (kein Video)**: Der Bot tritt unter einem eindeutigen Namen auf (`wortlaut` bzw. konfigurierter `guest_name`), zeichnet keinerlei Kamerabilder oder Bildschirminhalte auf und stellt vor dem Beitritt sicher, dass Mikrofon und Kamera deaktiviert sind (technisch erzwungen bis auf WebRTC-Sender-Ebene).
- **Respektieren von Zutritts- und Zustimmungsgrenzen**: Keine Umgehung von CAPTCHAs (`human_verification_required`), Warteräumen oder expliziten Einwilligungsdialogen (`consent_required`); kein automatisches Wiederbeitreten nach aktivem Entfernen durch den Host (`removed`).
- **Automatisches Verlassen leerer Räume**: Wenn über 5 Minuten keine anderen Teilnehmer oder keine aktive Sprache mehr im Raum vorhanden sind, beendet der Bot die Sitzung selbstständig (`room_empty`).
- **Keine Biometrie & strikte Löschfristen**: Keine Stimmprofile (Voiceprints), keine KI-Diarisierungs-Heuristiken; Sprecherzuordnung erfolgt ausschließlich über die nachgewiesene Provider-Teilnehmersitzung. Roh-Audio wird automatisch nach 24 Stunden aus S3 gelöscht, Transkripte nach 30 Tagen (oder sofort bei manuellem Löschen durch die einladende Person).

---

## 5. Nina – Eingeladene Meeting-Teilnehmerin & Protokoll-Leserin (Team-Collaborator)

### Profil & Kontext
- Nimmt als Kollegin, Fachexpertin oder Projektmitglied an einem Meeting teil, zu dem Mara oder Lukas den `wortlaut`-Bot eingeladen hat.
- Hat den Bot nicht selbst gestartet, möchte aber nach (oder schon während) der Besprechung im Protokoll nachlesen, was vereinbart wurde, ohne selbst Protokoll führen zu müssen.

### Berührungspunkte
1. Sieht im Meeting-Chat die Vorstellung von `wortlaut` mit dem Link zum Protokoll (`/ui#view=meetings&id=…`) oder erhält nach dem Call von Mara/Lukas einen schreibgeschützten Freigabe-Link (`/ui#token=wortlaut-read-…`).
2. Öffnet das Protokoll im Browser ([`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx)), filtert nach Sprechern, sucht nach Stichworten und lädt sich bei Bedarf das Markdown- (`.md`) oder Text-Protokoll (`.txt`) herunter.

### Hauptnutzungsanforderungen
- **Schutz vor unbefugtem Mitlesen im Chat**: Der vom Bot im Meeting-Chat gepostete Protokoll-Link (`/ui#view=meetings&id=…`) enthält **keinen** offenen Lese-Token, sodass externe Gäste ohne explizite Freigabe keinen Zugriff auf das Transkript erhalten; erst wenn Mara/Lukas aktiv **„Lese-Link teilen“** (`#token=wortlaut-read-…`) klickt, kann Nina das Protokoll ohne eigenen Account öffnen.
- **Kein Überschreiben der eigenen SSO-Sitzung**: Wenn Nina selbst einen Mayflower-SSO-Account besitzt und den geteilten `wortlaut-read-…`-Link einer Kollegin öffnet, wird der Lese-Token isoliert in `sessionStorage` gehalten ([`api.ts`](file:///data/wortlaut/worker/src/ui/api.ts)), sodass sie mit einem Klick (*„Zurück zu meinem Konto“* in [`HeaderBar.tsx`](file:///data/wortlaut/worker/src/ui/components/HeaderBar.tsx)) jederzeit zu ihren eigenen Aufnahmen wechseln kann.
- **Verständliche Lesedarstellung ohne Technik-Ballast**: Im Lese-Modus stehen der lesbare Dialogverlauf, die Redeanteile der Sprecher und die Export-Formate (`.txt`, `.md`, `.vtt`, `.json`) im Mittelpunkt, ohne verwirrende WebRTC-/Kubernetes-Diagnosedaten.

---

## 6. Tim – Interner Workflow- & Integrations-Entwickler (API-Konsument)

### Profil & Kontext
- Entwickelt interne Werkzeuge, die Besprechungsergebnisse weiterverarbeiten – etwa zur automatischen Ablage in Projektwikis, Ticket-Systemen oder zur nachgelagerten Zusammenfassung über ein domänenspezifisches lokales Sprachmodell.
- Schätzt an `wortlaut` (im Vergleich zu geschlossenen SaaS-Tools wie Fireflies/Otter oder kostenpflichtigen Cloud-BaaS-APIs wie Recall.ai), dass er über eine saubere REST-API kostenfrei im eigenen Netz auf unverfälschte, sprechergebundene Roh-Transkripte zugreifen kann.

### Typischer Ablauf
1. Informiert sich in der interaktiven OpenAPI-Dokumentation (`/docs`) und plant oder startet Aufnahmen automatisiert über `POST /v1/recordings` mit einem deterministischen `Idempotency-Key`.
2. Fragt den Bearbeitungsstand über `GET /v1/recordings/{id}` ab und ruft nach Abschluss `GET /v1/recordings/{id}/exports/json` oder `/exports/md` ab.

### Hauptnutzungsanforderungen
- **Idempotente REST-API & direkt verlinkte OpenAPI-Spezifikation (`/docs`)**: Sicheres Wiederholen von Requests über `Idempotency-Key` ohne Risiko doppelter Aufnahmen (`HTTP 409` bei abweichendem Payload in [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L432-L453)) sowie direkter Zugriff auf `/docs` und fertige `cURL`-Beispiele aus der UI ([`DiagnosticsTab.tsx`](file:///data/wortlaut/worker/src/ui/components/DiagnosticsTab.tsx), [`SystemView.tsx`](file:///data/wortlaut/worker/src/ui/components/SystemView.tsx)).
- **Maschinenlesbare Qualitäts- & Quellenmetriken für nachgelagerte LLM-Pipelines**: Der JSON-Export ([`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py)) liefert neben zeitgestempelten Segmenten und Wörtern auch eine vollständige Quellenübersicht (`sources_summary`) sowie belastbare Qualitätsindikatoren (`has_audio_gaps`, `attribution_unknown`, `unprocessed_audio`, `failed_asr_ranges`), damit nachgelagerte Zusammenfassungs-Pipelines unvollständige Aufnahmen erkennen können.
- **Gültigkeitsbegrenzte Lese-Tokens**: Möglichkeit, Exporte über dedizierte, zeitlich und auf eine Aufnahme begrenzte Reader-Tokens (`wortlaut-read-...`, `POST /v1/recordings/{id}/reader-token` in [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L1034-L1056)) abzurufen, ohne den globalen Operator-API-Token weiterzugeben.
- **Perspektivischer Bedarf aus dem BaaS-Wettbewerb (Recall.ai / Attendee)**: Optionale ausgehende Webhooks bei Statuswechseln (`recording.completed`, `recording.failed`), um Status-Polling-Schleifen in angebundenen Systemen abzulösen.
