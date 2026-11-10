# wortlaut

[![Checks](https://github.com/mayflower/wortlaut/actions/workflows/checks.yml/badge.svg)](https://github.com/mayflower/wortlaut/actions/workflows/checks.yml)
[![Website](https://img.shields.io/badge/Website-wortlaut.cloud-10b981)](https://wortlaut.cloud)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-Docker%20Compose%20%7C%20Helm%20%7C%20Kubernetes-6366f1)](#quickstart--self-hosting)

**Website:** [https://wortlaut.cloud](https://wortlaut.cloud) · **Docker-Quickstart:** [`docker-compose.yml`](docker-compose.yml) · **Helm Chart:** [`charts/wortlaut`](charts/wortlaut) · **Datenschutz-Info:** [`/privacy`](services/meeting/src/wortlaut/ui.py)

**Sprechergenaue Wortprotokolle für Google Meet, Microsoft Teams, Cisco Webex und Zoom — zu 100 % auf Ihrer eigenen Infrastruktur.**

`wortlaut` nimmt als transparenter Browser-Teilnehmer an Online-Besprechungen teil, zeichnet jeden Sprecher auf seiner eigenen Tonspur vor dem Abmischen auf und erstellt lokal (ohne externe Cloud-Sprachdienste) ein durchsuchbares Wortprotokoll inklusive Direktlink im Kalendereintrag, Markdown-Export und E-Mail-Versand.

---

## Warum `wortlaut`?

Kommerzielle Meeting-Bots (*Fireflies, Otter, Fathom, Read.ai*) leiten Gesprächsinhalte in fremde Clouds weiter, legen biometrische Stimmprofile an und lassen Teilnehmern nur die Wahl, entweder komplett aufgenommen zu werden oder das Meeting zu verlassen.

`wortlaut` löst dieses Dilemma für datenschutzbewusste Teams, Beratungen, Behörden und Engineering-Organisationen:

| Was Nutzer im Alltag brauchen | Wie `wortlaut` es löst |
| :--- | :--- |
| **Kein Datenabfluss in Dritt-Clouds** | Spracherkennung (**NVIDIA Parakeet**, `2,95 %` deutsche Wortfehlerrate) und optionale Zusammenfassungen (**Ollama**) laufen komplett im eigenen Cluster oder auf dem eigenen Server. |
| **Wer hat was gesagt – ohne Raten** | Statt eines gemischten Audiostroms mit fehleranfälliger Stimm-Diarisierung greift `wortlaut` die getrennten WebRTC-Empfangsspuren (`RTCRtpReceiver`) jedes Teilnehmers vor dem Mix ab. |
| **Individueller Opt-out mitten im Call** | Wer nicht protokolliert werden möchte, schreibt im Meeting-Chat einfach **`nein`** oder **`opt out`**. Das Gespräch läuft für alle anderen weiter – die Aussagen dieser Person werden sofort verworfen und rückstandslos gelöscht. |
| **Protokoll direkt dort, wo man sucht** | Nach dem Gespräch hängt `wortlaut` den schreibgeschützten Protokoll-Link automatisch an den **Google-Calendar-** oder **Outlook/M365-Termin** an, verschickt das Ergebnis per E-Mail und stellt `.md`, `.txt`, `.vtt` und `.json` bereit. |
| **Sekundengenaue Prüfbarkeit** | Jedes Zitat besitzt einen klickbaren Zeitstempel. Innerhalb der 24-stündigen Audio-Aufbewahrungsfrist lässt sich jeder Satz direkt im Browser mit dem Original-Ton gegenhören, bevor das Roh-Audio automatisch gelöscht wird. |

---

## So funktioniert `wortlaut` im Alltag

### 1. Besprechung aufzeichnen (3 Wege)

* **Automatisch über den Kalender (Google Calendar & Microsoft 365):**
  Verbinden Sie Ihren Kalender einmalig per OAuth2 in der Web-UI (`/ui#view=calendar`). Eigene Termine mit bestätigten Gästen werden automatisch protokolliert; externe Termine lassen sich per **1-Klick-Schalter** zu- oder abschalten.
* **Sofort im Browser (Ad-hoc):**
  Fügen Sie einen beliebigen **Google Meet-**, **Microsoft Teams-**, **Cisco Webex-** oder **Zoom-Link** auf der Startseite ein – `wortlaut` tritt innerhalb weniger Sekunden bei.
* **Per E-Mail-Einladung (`.ics`):**
  Laden Sie die Bot-Adresse (z. B. `robot@wortlaut.cloud`) einfach wie einen normalen Teilnehmer zum Kalendereintrag ein oder laden Sie eine `.ics`-Datei hoch.

### 2. Transparente Teilnahme & Live-Widerspruch im Call

* Beim Beitritt erscheint `wortlaut` klar erkennbar mit dem Namen der einladenden Person – z. B. **`wortlaut (Mara Lindner)`** – und postet im Meeting-Chat einen kurzen Hinweis samt Link zur [Datenschutz-Information (`/privacy`)](services/meeting/src/wortlaut/ui.py).
* **Live-Chat-Opt-out:** Schreibt eine teilnehmende Person im Meeting-Chat `nein`, `no`, `opt out`, `optout`, `stop` oder `widerspruch`, wird ihre Tonspur sofort verworfen und bereits transkribierte Sätze dieser Person werden aus der Datenbank gelöscht ([meet-page.ts](worker/src/meet-page.ts), [processing.py](services/meeting/src/wortlaut/processing.py)).

### 3. Nachbereiten, Prüfen & Teilen

* **Direkt im Kalendereintrag verlinkt:** Sobald das Protokoll fertig ist, trägt `wortlaut` den Lese-Link (`wortlaut-read-…`) automatisch in die Terminbeschreibung in Google Calendar bzw. Microsoft 365 ein – bei selbst organisierten Terminen direkt sichtbar für alle eingeladenen Gäste ([calendar_oauth.py](services/meeting/src/wortlaut/calendar_oauth.py)).
* **Volltextsuche & Editor:** Durchsuchen Sie alle Meetings nach Stichworten oder Sprechernamen, benennen Sie Gast-Teilnehmer bei Bedarf um (`speaker_overrides`) und korrigieren Sie Fachbegriffe im gesamten Protokoll mit einem Klick.
* **Exporte für jedes Werkzeug:** Kopieren Sie das Protokoll als **GitHub-Flavored Markdown (`.md`)** direkt nach Confluence, Notion, GitLab oder Jira, laden Sie `.txt`, `.vtt` oder `.json` herunter oder teilen Sie einen schreibgeschützten **Lese-Link (`wortlaut-read-…`)** ohne Account-Zwang ([exports.py](services/meeting/src/wortlaut/exports.py)).

---

## Unterstützte Konferenzplattformen

Alle vier Plattformen laufen parallel in derselben `wortlaut`-Instanz:

| Plattform | Beitritt & Funktionsumfang |
| :--- | :--- |
| **Google Meet** | Beitritt als Gast oder mit hinterlegtem Google-Konto ([meet.ts](worker/runtime/meet.ts), [meet-page.ts](worker/src/meet-page.ts), [capture.ts](worker/src/capture.ts)); getrennte WebRTC-Einzelspuren, Teilnehmer-Zuordnung und Live-Chat-Opt-out. |
| **Microsoft Teams** | Beitritt als Gast mit deutscher/englischer Steuerung ([teams-browser.ts](worker/runtime/teams-browser.ts)); getrennte WebRTC-Empfangsspuren, CSI-Sprecher-Bindung und Live-Chat-Opt-out. |
| **Cisco Webex** | Beitritt als Browser-Gast ([webex-browser.ts](worker/runtime/webex-browser.ts)) oder per Service-App-SDK; Multistream-`AUDIO-MAIN`-Erfassung, `activeSpeakerNotification`-Zuordnung und Live-Chat-Opt-out. |
| **Zoom** | Beitritt über den Zoom Web-Client als Gast oder mit hinterlegter Sitzung ([zoom-browser.ts](worker/runtime/zoom-browser.ts), [zoom-url.ts](worker/src/zoom-url.ts)); Warteraum-Unterstützung, Opus-Audio-Erfassung und Live-Chat-Opt-out. |

*(Kann eine Tonspur vom Konferenzanbieter nicht eindeutig einer Teilnehmersitzung zugeordnet werden, weist `wortlaut` dies im Protokoll transparent als `attribution_unknown: true` aus, statt Namen zu erraten.)*

---

## Quickstart & Self-Hosting

`wortlaut` unterstützt vier Betriebsarten ([runtime_backends.py](services/meeting/src/wortlaut/runtime_backends.py)) und läuft sowohl mit **NVIDIA-GPU** als auch per **CPU-Fallback**:

### Option 1: Docker Compose (Einzelserver / VM – schnellster Start)

Startet `wortlaut-meeting`, `wortlaut-asr` (standardmäßig mit CPU-Fallback), PostgreSQL 17 und MinIO S3 ([docker-compose.yml](docker-compose.yml)):

```sh
docker compose up -d --build
# Web-UI öffnen: http://127.0.0.1:8000/ui
```

### Option 2: Kubernetes mit Helm Chart (Produktion)

Für den produktiven Cluster-Betrieb mit kurzlebigen Worker-Jobs und GPU-gestützter Parakeet-ASR ([charts/wortlaut](charts/wortlaut)):

```sh
helm install wortlaut ./charts/wortlaut \
  --namespace wortlaut --create-namespace \
  --set config.apiUrl=https://wortlaut.example.org/ \
  --set config.sdkPageUrl=https://wortlaut.example.org/sdk/ \
  --set secrets.apiToken="$WORTLAUT_API_TOKEN" \
  --set secrets.databaseUrl="$DATABASE_URL"
```

*(Deklarative Kustomize-Manifeste liegen zusätzlich unter [deploy/k8s/base](deploy/k8s/base).)*

### Option 3: Lokal / Bare-Metal (`WORTLAUT_CONTROLLER_BACKEND=local`)

Startet den Meeting-Dienst direkt unter Linux und isolierte Worker als lokale Node-Subprozesse ([scripts/run-local.sh](scripts/run-local.sh)):

```sh
./scripts/run-local.sh
```

---

## Datenschutz & Aufbewahrungsfristen

`wortlaut` ist nach dem Prinzip **Privacy by Design** aufgebaut:

1. **Kurze Roh-Audio-Aufbewahrung (24 Stunden):** Aufgezeichnete Audiospuren dienen ausschließlich der Transkription und der kurzen Satz-Überprüfung und werden standardmäßig **24 Stunden nach Meeting-Ende** automatisch aus dem S3-Speicher gelöscht.
2. **Automatische Protokoll-Löschfrist (30 Tage):** Transkripte und Metadaten laufen standardmäßig nach **30 Tagen** ab (konfigurierbar in [settings.py](services/meeting/src/wortlaut/settings.py)) oder können jederzeit sofort per Klick gelöscht werden (`DELETE /v1/recordings/{id}`).
3. **Mandantentrennung & Scoped Links:** Über **Dex OIDC** ([oidc.py](services/meeting/src/wortlaut/oidc.py)) angemeldete Nutzer sehen ausschließlich ihre eigenen Aufnahmen sowie Termine, zu denen sie eingeladen waren. Geteilte Lese-Links (`wortlaut-read-<recording_id>.<hmac>`) gewähren ausschließlich Lesezugriff auf genau ein Protokoll.

---

## Optionale Erweiterungen

### Lokale KI-Zusammenfassung & Aufgabenliste (Ollama)

Wenn im eigenen Cluster oder Netzwerk ein lokaler **Ollama**-Endpunkt verfügbar ist, erstellt `wortlaut` auf Wunsch nach dem Call eine strukturierte Kurzfassung, Themenblöcke und Action-Items – ohne externe KI-APIs:

```dotenv
WORTLAUT_ENABLE_LLM_SUMMARY=true
WORTLAUT_OLLAMA_URL=http://ollama.ollama.svc.cluster.local:11434
WORTLAUT_OLLAMA_MODEL=qwen3.8:latest
```

### E-Mail-Einladungen (IMAP) & Ergebnisversand (SMTP)

Für den Empfang von `.ics`-Kalendereinladungen (mit DKIM-Prüfung) und den automatischen Versand der fertigen Wortprotokolle per E-Mail ([mail.py](services/meeting/src/wortlaut/mail.py), [calendar.py](services/meeting/src/wortlaut/calendar.py)):

```dotenv
WORTLAUT_ENABLE_IMAP=true
WORTLAUT_IMAP_HOST=imap.example.org
WORTLAUT_IMAP_USERNAME=bot@example.org
WORTLAUT_IMAP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_MAIL_SENDER_AUTH=dkim
WORTLAUT_MAIL_ALLOWED_SENDER_DOMAINS=["example.org"]
WORTLAUT_MAIL_REPLY_TO_SENDER=true
WORTLAUT_ENABLE_SMTP=true
WORTLAUT_SMTP_HOST=smtp.example.org
WORTLAUT_SMTP_USERNAME=bot@example.org
WORTLAUT_SMTP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_SMTP_FROM=bot@example.org
```

*(Alternativ unterstützt `WORTLAUT_MAIL_SENDER_AUTH=gateway` vertrauenswürdige Mail-Gateways über `WORTLAUT_TRUSTED_SENDER_HEADER` und `WORTLAUT_ORGANIZER_PERMISSIONS`.)*

---

## Technische Architektur & Referenz

`wortlaut` besteht aus drei schlanken Komponenten:

* **Meeting-Dienst** ([services/meeting](services/meeting), [app.py](services/meeting/src/wortlaut/app.py), [models.py](services/meeting/src/wortlaut/models.py), [settings.py](services/meeting/src/wortlaut/settings.py)) — Python/FastAPI, integrierte Web-UI ([ui.py](services/meeting/src/wortlaut/ui.py)), Dex-OIDC-Authentifizierung ([oidc.py](services/meeting/src/wortlaut/oidc.py)), Kalender- & OAuth2-Synchronisation ([calendar.py](services/meeting/src/wortlaut/calendar.py), [calendar_oauth.py](services/meeting/src/wortlaut/calendar_oauth.py)), Scheduler, Worker-Steuerung ([controller.py](services/meeting/src/wortlaut/controller.py)), Audio-Ingest, Exporte ([exports.py](services/meeting/src/wortlaut/exports.py)) und Mail-Verarbeitung ([mail.py](services/meeting/src/wortlaut/mail.py)) in einem Prozess.
* **Browser-Worker** ([worker](worker)) — TypeScript, Playwright und gesandboxtes Chromium; ein kurzlebiger Job pro Besprechung, der eingehende WebRTC-Empfangskanäle getrennt vor dem Mix abgreift.
* **ASR-Dienst** ([services/asr](services/asr), [services/asr/app.py](services/asr/app.py)) — Gemeinsam genutztes lokales **Parakeet**-Spracherkennungsmodell (Standard-Checkpoint `primeline/parakeet-primeline` / `2_95_WER.nemo`, Revision `3f1a9bcb611dfeda53fe74fe5f1a3d5701e8023e`, konfigurierbar über `WORTLAUT_ASR_MODEL_NAME`, `WORTLAUT_ASR_MODEL_NEMO_FILE`, `WORTLAUT_ASR_MODEL_REVISION` sowie `WORTLAUT_ASR_ALLOW_CPU=true`).

### Wichtige REST-API-Endpunkte (vollständige Doku unter `/docs`)

| Endpunkt | Funktion |
| :--- | :--- |
| `POST /v1/recordings` | Neue Aufnahme anlegen (mit `Idempotency-Key`-Header) |
| `GET /v1/recordings` | Aufnahmen auflisten & Volltext-/Sprechersuche (`?q=`) |
| `GET /v1/recordings/{id}` | Aufnahme-Status, Quellen, Diagnose (`live_status`) & `opted_out_speakers` |
| `PATCH /v1/recordings/{id}` | Titel, Notizen, `speaker_overrides`, Fachbegriffe oder `opted_out_speakers` aktualisieren |
| `DELETE /v1/recordings/{id}` | Aufnahme samt Transkript und S3-Audiodateien sofort löschen |
| `GET /v1/recordings/{id}/transcript` | Live- oder abgeschlossenes Transkript abrufen |
| `GET /v1/recordings/{id}/exports/{format}` | Protokoll als `md`, `txt`, `vtt` oder `json` herunterladen |
| `GET /v1/recordings/{id}/audio-snippet` | WAV-Audioausschnitt einer Tonspur zur Satzprüfung abrufen |
| `POST /v1/recordings/{id}/summary` | Lokale KI-Zusammenfassung über Ollama erzeugen |
| `POST /v1/recordings/{id}/calendar-link` | Protokoll-Link in den verknüpften Google-/M365-Kalendereintrag schreiben |
| `POST /v1/recordings/{id}/reader-token` | Schreibgeschützten `wortlaut-read-…`-Link-Token erzeugen |
| `POST /v1/recordings/{id}/claim-access` | Geteilten Lese-Link mit dem eigenen OIDC-Konto verknüpfen |
| `POST /v1/recordings/{id}/cancel` / `rejoin` | Laufende Aufnahme beenden oder Worker erneut beitreten lassen |
| `POST /v1/recordings/{id}/delivery/retry` | Fehlgeschlagenen SMTP-Ergebnisversand erneut anstoßen |
| `GET /v1/calendar` | Synchronisierte Google-/M365-Termine und `.ics`-Einladungen abrufen |
| `POST /v1/calendar/oauth/exchange` | Google Calendar (`calendar.events`) oder M365 (`Calendars.ReadWrite`) per OAuth2 PKCE verbinden |
| `POST /v1/calendar/oauth/connections/{id}/sync` | Kalender-Synchronisation sofort auslösen (`DELETE` zum Trennen) |
| `POST /v1/calendar/oauth/events/{id}/toggle` | Automatische Aufnahme für einen Kalendertermin ein-/ausschalten |
| `GET /privacy` / `GET /metrics` | Öffentliche Datenschutz-Seite bzw. Prometheus-Metriken |

#### Beispiel: Aufnahme per CLI / API planen & exportieren

```sh
IDEMPOTENCY_KEY=$(uuidgen)
jq -n --arg url "$MEETING_URL" --arg start "$STARTS_AT" --arg end "$ENDS_AT" \
  '{provider:"google_meet", meeting_url:$url, starts_at:$start, ends_at:$end}' |
  curl --fail-with-body http://127.0.0.1:34601/v1/recordings \
    -H "Authorization: Bearer $WORTLAUT_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" --data-binary @-

# Fertiges Markdown-Protokoll herunterladen:
curl --fail-with-body "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID/exports/md" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN" -o protokoll.md
```

---

## Entwicklung & Tests

Für die lokale Entwicklung gegen den Kubernetes-Cluster (`data` Context, Details in [AGENTS.md](AGENTS.md) und [Tiltfile](Tiltfile)):

```sh
make setup
make dev
```

Provider-Zugänge werden in privaten, ignorierten Dateien unter `.dev/` (`meet.env`, `webex.env`, `teams.env`, `zoom.env`, `mail.env`) gepflegt und per `python3 scripts/dev-secrets.py` in Kubernetes-Secrets synchronisiert.

```sh
make lint
make test
npm --prefix worker run build
npm --prefix worker run test:audio
npm --prefix worker run test:meet
```

Alle Konfigurationsparameter und Standardwerte sind in [settings.py](services/meeting/src/wortlaut/settings.py) dokumentiert. Beiträge und Weiterentwicklungen folgen den Vorgaben in [AGENTS.md](AGENTS.md).
