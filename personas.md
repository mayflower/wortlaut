# Nutzerpersonas

Dieses Dokument beschreibt die fünf zentralen Personas für `wortlaut` sowie ihre jeweiligen Hauptnutzungsanforderungen an das System.

---

## 1. Mara – Projekt- & Account-Lead (Kalender- & E-Mail-Workflow)

### Profil & Kontext
- Koordiniert laufende Kunden- und Projekttermine über wechselnde Videokonferenzsysteme hinweg (Google Meet, Microsoft Teams, Webex), je nachdem, welchen Stack der jeweilige Kunde vorgibt.
- Unterliegt strengen Vertraulichkeits- und DSGVO-Vorgaben: Cloud-basierte Transkriptions-Bots von Drittanbietern dürfen nicht in Kundentermine eingeladen werden.
- Möchte sich im Gespräch auf den Inhalt konzentrieren, statt parallel Protokoll zu schreiben.

### Typischer Ablauf
1. Lädt die Bot-Adresse per Kalendereinladung (ICS, Einzel- oder Serientermin) ein oder leitet kurz vor Gesprächsbeginn eine Einladungs-E-Mail weiter.
2. Lässt den Bot bei Bedarf aus dem Warteraum in das Meeting ein.
3. Erhält nach Gesprächsende automatisch die fertigen Transkripte per E-Mail.

### Hauptnutzungsanforderungen
- **Provider-Unabhängigkeit ohne Umschalten**: Einladungen für Google Meet ([`capture.ts`](file:///data/wortlaut/worker/src/meet/capture.ts)), Microsoft Teams ([`teams-browser.ts`](file:///data/wortlaut/worker/src/teams-browser.ts)) und Webex ([`webex-browser.ts`](file:///data/wortlaut/worker/src/webex-browser.ts)) müssen über denselben Posteingang erkannt und parallel verarbeitet werden ([`calendar_sync.py`](file:///data/wortlaut/services/meeting/src/wortlaut/calendar_sync.py)).
- **Zuverlässige Kalender-Synchronisation**: Änderungen an Terminzeiten, verschobene Einzeltermine einer Serie sowie Absagen (`CANCEL`) müssen automatisch übernommen werden, ohne doppelte Bots zu starten ([`calendar_sync.py`](file:///data/wortlaut/services/meeting/src/wortlaut/calendar_sync.py)).
- **Automatischer Ergebnisversand & Lese-Link**: Nach Abschluss der lokalen Spracherkennung werden `TXT`-, `WebVTT`-, `Markdown` (`.md`)- und `JSON`-Transkripte ([`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py)) sowie ein direkter schreibgeschützter Web-UI-Lese-Link (`#token=wortlaut-read-…`) direkt an die verifizierte Organisator-Adresse zugestellt ([`mail.py`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py)).
- **Klare Rückmeldung bei Nicht-Teilnahme**: Wenn der Bot nicht eingelassen wird (`lobby_timeout`, `admission_denied`), einen Passcode/Login benötigt oder keine Audiospur empfängt, wird sofort eine verständliche Benachrichtigungs-E-Mail mit dem konkreten Abbruchgrund versendet ([`send_failure_notification_email()`](file:///data/wortlaut/services/meeting/src/wortlaut/mail.py#L311-L376)).
- **Sprecherzuordnung aus dem Meeting**: Im Transkript sollen die im Meeting angezeigten Teilnehmernamen erscheinen, ohne dass Sprecher im Nachhinein manuell zugewiesen werden müssen.
- **Persönliche Mandantentrennung (Dex OIDC)**: Meldet sich Mara per SSO (Dex OIDC, [`oidc.py`](file:///data/wortlaut/services/meeting/src/wortlaut/oidc.py)) in der Web-UI an, sieht sie ausschließlich ihre eigenen Aufnahmen und Kalendereinladungen (`owner_sub` / `owner_email`).

---

## 2. Lukas – Consultant / Tech-Lead (Ad-hoc Web-UI-Nutzer)

### Profil & Kontext
- Nimmt regelmäßig an ungeplanten Architektur-, Incident- oder Abstimmungs-Calls teil, für die keine vorab importierte Kalendereinladung existiert.
- Entscheidet oft erst wenige Minuten vor oder während eines laufenden Gesprächs, dass eine Aufzeichnung zur Dokumentation benötigt wird.

### Typischer Ablauf
1. Öffnet die integrierte Web-UI (`/ui`, [`App.tsx`](file:///data/wortlaut/worker/src/ui/App.tsx)), meldet sich per Dex OIDC SSO an ([`WelcomeLandingView.tsx`](file:///data/wortlaut/worker/src/ui/components/WelcomeLandingView.tsx)), gibt den Meeting-Link, einen optionalen Titel sowie bei Bedarf einen sprechenden Bot-Namen ein ([`NewRecordingDialog.tsx`](file:///data/wortlaut/worker/src/ui/components/NewRecordingDialog.tsx)) und startet den Bot im Modus *Sofort beitreten (Live)*.
2. Prüft im Live-Banner ([`ParticipationStepper.tsx`](file:///data/wortlaut/worker/src/ui/components/ParticipationStepper.tsx)), ob der Bot im Warteraum wartet oder bereits Audio und Teilnehmer erfasst.
3. Durchsucht das Transkript noch während oder unmittelbar nach dem Call im Browser ([`MeetingDetailView.tsx`](file:///data/wortlaut/worker/src/ui/components/MeetingDetailView.tsx), [`TranscriptTab.tsx`](file:///data/wortlaut/worker/src/ui/components/TranscriptTab.tsx)) und lädt den Export (`.md`, `.txt`, `.vtt`, `.json`) herunter oder teilt einen Lese-Link (`wortlaut-read-…`).

### Hauptnutzungsanforderungen
- **Schneller Ad-hoc-Dispatch**: Start eines Bots mit wenigen Klicks direkt über die Web-UI inkl. frei wählbarem Meeting-Titel (`title`) und Bot-Anzeigenamen (`guest_name`).
- **Transparenter Live-Status**: Sofortige Sichtbarkeit in der UI, ob der Bot beitritt (`joining`), im Warteraum auf Einlass wartet (`waiting_admission`) oder aktiv aufzeichnet (`capturing`), inklusive Anzahl aktiver Streams, gebundener Receiver mit Teilnehmernamen und empfangener Audiosekunden.
- **Fortschreitendes Live-Transkript**: Bereits während des laufenden Meetings müssen fertig transkribierte Segmente in der UI erscheinen, nach Sprecher/Quelle filterbar und per Volltextsuche durchsuchbar sein.
- **Manuelle Steuerung im Ausnahmefall**: Möglichkeit, eine laufende Aufnahme vorzeitig über die UI zu beenden (`cancel`) oder einen fehlgeschlagenen E-Mail-Versand erneut anzustoßen (`delivery/retry`).

---

## 3. Svenja – Platform- & DevOps-Engineer (Self-Hosted Operator)

### Profil & Kontext
- Betreibt `wortlaut` im eigenen Kubernetes-Cluster (`data`) mit lokaler NVIDIA-Parakeet-GPU, PostgreSQL und S3-kompatiblem Objektspeicher (RustFS).
- Verantwortet Betriebsstabilität, Secret-Management, Ingress/TLS, E-Mail-Authentifizierung (DKIM/Gateway) und Observability im bestehenden Grafana/Alloy/Tempo/Loki-Stack.

### Typischer Ablauf
1. Konfiguriert Provider-Zugänge (`.dev/*.env`, optionale gespeicherte Browser-Session für Google Meet) und Mail-Anbindung.
2. Überwacht Aufnahmen, Worker-Jobs, GPU-Auslastung und WebRTC-Signaling über das Grafana-Dashboard und die API.
3. Analysiert bei Provider-Änderungen (z. B. geändertes DOM oder neue Signaling-Kanäle in Meet/Teams/Webex) die erfassten Diagnose- und Telemetriedaten.

### Hauptnutzungsanforderungen
- **Strikte Isolation & sichere Zugangsdaten**: Ein kurzlebiger Kubernetes-Job mit isoliertem Chromium-Profil pro Aufnahme ([`controller.py`](file:///data/wortlaut/services/meeting/src/wortlaut/controller.py)); Bootstrap-Secrets werden erst nach beobachteter Pod-Terminierung gelöscht; keine Token oder Zugangsdaten in Logs, URLs oder ConfigMaps; Admin-Berechtigung über `WORTLAUT_OIDC_ADMIN_EMAILS` oder `WORTLAUT_API_TOKEN` ([`oidc.py`](file:///data/wortlaut/services/meeting/src/wortlaut/oidc.py), [`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py)).
- **Begrenzte Kapazitäten & Backpressure**: Feste Obergrenzen für gleichzeitige Meetings (`max_active_meetings`), aktive Audio-Quellen, unsegmentiertes Audio und offene ASR-Jobs ([`settings.py`](file:///data/wortlaut/services/meeting/src/wortlaut/settings.py), [`SystemView.tsx`](file:///data/wortlaut/worker/src/ui/components/SystemView.tsx)), damit Lastspitzen weder Datenbank noch GPU-Speicher überlasten.
- **Nahtlose OTLP- & Loki-Telemetrie**: Strukturierte Logs und OpenTelemetry-Traces (`wortlaut.worker.status`) für Receiver-Bindungen, erkannte DOM-/Signaling-Teilnehmer, SDP-Beschreibungen und DataChannel-/HTTP-/WebSocket-Signaling direkt im bestehenden Grafana-Stack ([`DiagnosticsTab.tsx`](file:///data/wortlaut/worker/src/ui/components/DiagnosticsTab.tsx), [`SourcesTab.tsx`](file:///data/wortlaut/worker/src/ui/components/SourcesTab.tsx)).
- **Eindeutige Fehlerklassifikation**: Präzise maschinenlesbare Endgründe (`end_reason` / `participation_reason` wie `human_verification_required`, `auth_session_missing`, `teams_sending_device_active`, `audio_clock_interrupted`, `room_empty` in [`reasons.py`](file:///data/wortlaut/services/meeting/src/wortlaut/reasons.py)) statt generischer Abstürze.

---

## 4. Dr. Thomas – Externer Host & Datenschutzverantwortlicher (Compliance-Stakeholder)

### Profil & Kontext
- Leitet als Gastgeber ein Meeting auf Kundenseite oder prüft als Datenschutzbeauftragter (DSB), unter welchen Bedingungen der `wortlaut`-Bot an vertraulichen Besprechungen teilnehmen darf.
- Bedient `wortlaut` nicht selbst, nimmt den Bot aber im Warteraum und in der Teilnehmerliste wahr.

### Berührungspunkte
1. Sieht den Bot mit seinem Anzeigenamen im Warteraum und entscheidet über den Einlass.
2. Beobachtet während des Meetings, dass der Bot ausschließlich zuhört und den Raum verlässt, sobald alle anderen Teilnehmer gegangen sind.

### Hauptnutzungsanforderungen
- **Klar erkennbarer, rein passiver Teilnehmer**: Der Bot tritt unter einem eindeutigen Namen auf (`wortlaut` bzw. konfigurierter `guest_name`) und stellt vor dem Beitritt sicher, dass Mikrofon und Kamera deaktiviert sind (technisch erzwungen bis auf WebRTC-Sender-Ebene).
- **Respektieren von Zutritts- und Zustimmungsgrenzen**: Keine Umgehung von CAPTCHAs (`human_verification_required`), Warteräumen oder expliziten Einwilligungsdialogen (`consent_required`).
- **Automatisches Verlassen leerer Räume**: Wenn über 5 Minuten keine anderen Teilnehmer oder keine aktive Sprache mehr im Raum vorhanden sind, beendet der Bot die Sitzung selbstständig (`room_empty`).
- **Keine Biometrie & strikte Löschfristen**: Keine Stimmprofile (Voiceprints), keine KI-Diarisierungs-Heuristiken; Sprecherzuordnung erfolgt ausschließlich über die nachgewiesene Provider-Teilnehmersitzung. Roh-Audio wird automatisch nach 24 Stunden aus S3 gelöscht, Transkripte nach 30 Tagen.

---

## 5. Tim – Interner Workflow- & Integrations-Entwickler (API-Konsument)

### Profil & Kontext
- Entwickelt interne Werkzeuge, die Besprechungsergebnisse weiterverarbeiten – etwa zur automatischen Ablage in Projektwikis, Ticket-Systemen oder zur nachgelagerten Zusammenfassung über ein lokales Sprachmodell.

### Typischer Ablauf
1. Plant oder startet Aufnahmen automatisiert über `POST /v1/recordings` mit einem deterministischen `Idempotency-Key`.
2. Fragt den Bearbeitungsstand über `GET /v1/recordings/{id}` ab und ruft nach Abschluss `GET /v1/recordings/{id}/exports/json` ab.

### Hauptnutzungsanforderungen
- **Idempotente REST-API**: Sicheres Wiederholen von Requests über `Idempotency-Key` ohne Risiko doppelter Aufnahmen (`HTTP 409` bei abweichendem Payload in [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L483-L612)).
- **Maschinenlesbare Qualitäts- & Quellenmetriken**: Der JSON-Export ([`exports.py`](file:///data/wortlaut/services/meeting/src/wortlaut/exports.py)) muss neben den zeitgestempelten Segmenten und Wörtern auch eine vollständige Quellenübersicht (`sources_summary`) sowie belastbare Qualitätsindikatoren (`has_audio_gaps`, `attribution_unknown`, `unprocessed_audio`, `failed_asr_ranges`) liefern, damit nachgelagerte Systeme unvollständige Aufnahmen erkennen können.
- **Gültigkeitsbegrenzte Lese-Tokens**: Möglichkeit, Exporte über dedizierte, zeitlich und auf eine Aufnahme begrenzte Reader-Tokens (`wortlaut-read-...`, `POST /v1/recordings/{id}/reader-token` in [`app.py`](file:///data/wortlaut/services/meeting/src/wortlaut/app.py#L775-L786)) abzurufen, ohne den globalen Operator-API-Token weiterzugeben.
