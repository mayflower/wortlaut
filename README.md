# wortlaut

Meeting-Aufnahmen mit getrennten Audioquellen, lokaler Parakeet-ASR und TXT/VTT/JSON-Export. Meet und Webex sind für gleichzeitigen Betrieb in derselben Instanz vorgesehen; Teams folgt als weiterer Provider. Jede Aufnahme hat ihren eigenen Provider und Worker. Zugänge bleiben getrennt, ASR, Datenbank, Storage, Scheduler und Kapazitätsgrenzen gemeinsam. Der vollständige Auftrag steht in [prompts.md](prompts.md).

**Noch keine Providerabnahme:** Meet-Beitritt und Browser-Capture sind implementiert, echte Teilnahme und samplebezogene Teilnehmerbindung sind noch offen. Auch Webex gibt derzeit ungebundene Sprecherquellen aus. `speaker_id: null`, `attribution_unknown: true` und `source_coverage: unknown` kennzeichnen diese Grenze. Fixtureaudio und erfolgreich verarbeiteter Text erfüllen die Sprecheranforderung nicht. Teams ist noch nicht implementiert.

## Entwicklungsstart

Benötigt werden `uv`, Node.js/npm, `kubectl`, Tilt, Docker Buildx und Zugang zum vorhandenen Kubernetes-Context `data` einschließlich Registry und GPU. Keine Cluster-Treiber oder gemeinsame Infrastruktur installieren.

```sh
make setup
make dev
```

`make setup` installiert gesperrte Abhängigkeiten und übernimmt `~/.kube/data-lan-mayflower` in die ignorierte `.dev/kubeconfig`; ein anderer Quellpfad ist über `WORTLAUT_SOURCE_KUBECONFIG` möglich. Der globale Context bleibt unverändert. Der Entwicklungsnamespace heißt `wortlaut-$(id -un)`, Images werden für `linux/amd64` mit Kubernetes-BuildKit gebaut. Private Dateien unter `.dev/` dürfen nicht eingecheckt werden.

Tilt: http://127.0.0.1:34604 · Meeting-API: http://127.0.0.1:34601 · ASR: http://127.0.0.1:34602 · PostgreSQL: 127.0.0.1:34632 · S3: http://127.0.0.1:34609. Worker erreichen API und Webex-SDK-Seite über `https://wortlaut-<benutzer>.data.mayflower.zone`.

Vor Steuerung einer Tilt-Instanz deren Tiltfile-Pfad prüfen. Kubernetes-Aufrufe verwenden immer `.dev/kubeconfig`, `--context data` und den eigenen Namespace. Die Umgebung nach der Arbeit weiterlaufen lassen; kein automatisches `tilt down`, Prune oder Löschen persistierter Daten.

## Provider konfigurieren

Dateien enthalten einfache `NAME=WERT`-Zeilen und erhalten Dateimodus `600`. Interne API-, Storage- und GPU-Credentials erzeugt der Entwicklungsstart privat; der Betreiber-API-Token steht in `.dev/runtime.env`.

Für einen autorisierten Meet-Test in `.dev/meet.env`:

```dotenv
WORTLAUT_ENABLE_GOOGLE_MEET=true
WORTLAUT_MEET_LOCALE=de-DE
# Nur bei Verwendung eines autorisierten Browseraccounts:
WORTLAUT_MEET_STORAGE_STATE_SECRET=wortlaut-meet-browser
```

Der Playwright-Browserzustand liegt dann in `.dev/meet-storage-state.json`. Der Entwicklungsstart übernimmt ihn in ein Kubernetes-Secret; ausschließlich Meet-Worker erhalten ihn schreibgeschützt und verwenden ein frisches Browserprofil. Ohne Zustand braucht das Zielmeeting zulässige Gastteilnahme und gegebenenfalls Zulassung durch den Gastgeber. Meet verwendet ausschließlich den Webclient mit Playwright/Chromium, keine Google-Media-, Meet-REST- oder Calendar-API. Die Aktivierung startet fällige Meet-Aufträge; nur autorisierte Testmeetings planen. Der derzeitige Capturepfad erfüllt die Teilnehmerbindung noch nicht.

Webex benötigt unabhängig davon `WORTLAUT_WEBEX_SERVICE_TOKEN` in `.dev/webex.env`. Für Service-App-Refresh zusätzlich `WORTLAUT_ENABLE_WEBEX_REFRESH=true`, `WORTLAUT_WEBEX_CLIENT_ID`, `WORTLAUT_WEBEX_CLIENT_SECRET` und `WORTLAUT_WEBEX_REFRESH_TOKEN` setzen. Unveränderte lokale Dateien überschreiben das im Namespace-Secret rotierte Tokenpaar nicht. Bei gesperrtem Refresh aktuelle Credentials in der privaten Datei neu bereitstellen. Echte Webex-Teilnahme und Tokenerneuerung sind noch ungeprüft; fehlender Webex-Zugang blockiert Meet nicht. Worker brauchen DNS, HTTPS und den Webex-Medienpfad.

Bei bereits laufender Umgebung geänderte Provider-/Mail-Secrets übernehmen und nur den eigenen Meeting-Dienst neu starten:

```sh
KUBECONFIG="$PWD/.dev/kubeconfig" WORTLAUT_NAMESPACE="wortlaut-$(id -un)" python3 scripts/dev-secrets.py
kubectl --kubeconfig .dev/kubeconfig --context data -n "wortlaut-$(id -un)" rollout restart deployment/wortlaut-meeting
```

Laufende Worker bleiben eigenständige Jobs. Ihre Prozesse müssen nachweislich beendet sein, bevor ein Ersatzbeitritt zulässig ist.

Meet-Worker starten vollständiges Chromium als normalen, sandboxed Browserprozess mit einem frischen anonymen Profil. Unter Linux stellt Xvfb eine virtuelle Anzeige bereit; Playwright verbindet sich anschließend über einen lokalen CDP-Port. Namen und Meeting-Schaltflächen werden unter Linux über `xdotool`/XTEST bedient; fehlt die X11-Anzeige, startet der Meet-Worker nicht. Playwright dient dabei der Seitenerkennung und Audioanbindung. Die bisherigen Stealth-Erweiterungen entfallen. `prejoin_denied` bezeichnet eine Ablehnung vor dem Absenden einer Beitrittsanfrage, `admission_denied` eine Ablehnung danach. `waiting_admission` wird erst nach sichtbarer Warteanzeige gemeldet; ein Klick allein beweist keine beim Gastgeber eingegangene Anfrage. Die Webex-Browserkonfiguration bleibt separat.

## Aufnahme, Status und Export

Den Betreiber-Token privat als `WORTLAUT_API_TOKEN` bereitstellen; keine Tokenwerte in URLs oder Logs. Im Beispiel Meetinglink, Termin und Idempotenzschlüssel ersetzen. Zeitzonen sind erforderlich. Derselbe Schlüssel mit identischem Auftrag liefert dieselbe Aufnahme; eine andere Nutzlast führt zu HTTP 409.

```sh
curl --fail-with-body http://127.0.0.1:34601/v1/recordings \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: meet-test-001' \
  --data '{"provider":"google_meet","meeting_url":"https://meet.google.com/abc-defg-hij","starts_at":"2026-10-08T09:00:00+02:00","ends_at":"2026-10-08T09:30:00+02:00"}'

curl --fail-with-body 'http://127.0.0.1:34601/v1/recordings?limit=25' \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN"

# RECORDING_ID durch die zurückgegebene Aufnahme-ID ersetzen.
curl --fail-with-body "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN"
curl --fail-with-body "http://127.0.0.1:34601/v1/recordings/$RECORDING_ID/exports/json" \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN" -o aufnahme.json
```

Für Webex `provider=webex` und einen gültigen Webex-Link verwenden. Der Scheduler startet konfigurierte Aufträge standardmäßig 60 Sekunden vor Beginn, höchstens zwei gleichzeitig über alle Provider. Keine globale Providerumschaltung.

Die Liste ist nach Startzeit aufsteigend sortiert. `limit` ist höchstens 100; `next_cursor` als `cursor` mit denselben Filtern übernehmen. Optional: `provider`, `starts_from` inklusive und `starts_before` exklusiv. Der Detailstatus zeigt Teilnahme, Verarbeitung, Quellenbindungen, angenommenes Audio, Lücken, Rückstau, Workerzustand und Versand. Abgeschlossene Verarbeitung bestätigt keine vollständige Quellenabdeckung oder richtige Sprecherzuordnung.

Exporte heißen `txt`, `vtt` und `json`. Vor Abschluss der Verarbeitung liefern sie 409, nach Transkriptaufbewahrung 410. Bekannte Lücken, fehlendes EOS, ungebundene Quellen und unvollständiger Drain bleiben sichtbar. Mehrdeutige Meetinglinks werden abgelehnt.

## Einladungen und Ergebnisversand

IMAP und SMTP sind zunächst deaktiviert. Beispielwerte in der privaten `.dev/mail.env` ersetzen:

```dotenv
WORTLAUT_ENABLE_IMAP=true
WORTLAUT_IMAP_HOST=imap.example.org
WORTLAUT_IMAP_USERNAME=bot@example.org
WORTLAUT_IMAP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_TRUSTED_SENDER_HEADER=X-Wortlaut-Authenticated-Sender
WORTLAUT_ORGANIZER_PERMISSIONS={"sender@example.org":["organizer@example.org"]}
WORTLAUT_ENABLE_SMTP=true
WORTLAUT_SMTP_HOST=smtp.example.org
WORTLAUT_SMTP_USERNAME=bot@example.org
WORTLAUT_SMTP_PASSWORD=REPLACE_PRIVATELY
WORTLAUT_SMTP_FROM=bot@example.org
WORTLAUT_RESULT_RECIPIENTS={"organizer@example.org":["recipient@example.org"],"default":["operator@example.org"]}
```

Das vertrauenswürdige Mailgateway entfernt alle eingehenden Kopien von `X-Wortlaut-Authenticated-Sender` und setzt ihn erst nach eigener Absenderprüfung. Die bestätigte Adresse muss mit dem einzelnen MIME-From übereinstimmen; mitgelieferte `Authentication-Results` genügen nicht. Im Gateway-Modus IMAP nur mit diesem Gatewayvertrag aktivieren. Standard: IMAP über geprüftes TLS auf 993, SMTP über geprüftes STARTTLS auf 587. Zugangsdaten und Absenderregeln werden pro Installation konfiguriert.

Für ein normales IMAP-Postfach ohne eigenes Gateway stattdessen diese Einstellungen verwenden:

```dotenv
WORTLAUT_MAIL_SENDER_AUTH=dkim
WORTLAUT_MAIL_ALLOWED_SENDER_DOMAINS=["mayflower.de"]
WORTLAUT_MAIL_REPLY_TO_SENDER=true
```

Dieser Modus prüft die DKIM-Signatur selbst gegen den öffentlichen DNS-Schlüssel.
Er akzeptiert nur exakt freigegebene From-Domains mit passender Signaturdomain,
RSA-SHA256, signierten MIME-Headern und vollständig signiertem Inhalt (kein `l=`).
Gefälschte Prüfheader gewähren keinen Zugriff. Der ICS-Organisator muss mit dem
Absender übereinstimmen; Stellvertreter und weitergeleitete fremde Termine werden
abgewiesen. Bei temporären DNS-Fehlern bleibt die Nachricht zur Wiederholung offen.
Mit `MAIL_REPLY_TO_SENDER` gehen Ergebnisse ausschließlich an diesen Organisator,
nicht an CCs oder Reply-To-Adressen. Ohne passende DKIM-Signatur wird die Einladung
abgewiesen, auch wenn die sichtbare Absenderadresse zur freigegebenen Domain gehört.
Für IONOS: `imap.ionos.de:993` (TLS), `smtp.ionos.de:587` (STARTTLS).
Passwörter gehören ausschließlich in die ignorierte `.dev/mail.env` und das
Kubernetes-Secret. Nach einer Secret-Änderung den Meeting-Dienst neu starten,
damit er die neuen Umgebungsvariablen übernimmt.

Zusätzlich zu iCalendar verarbeitet der DKIM-Modus Soforteinladungen mit einem
eindeutigen Meet-Link im Text oder HTML. Direkt versendete Mails müssen von einer
freigegebenen Domain stammen. Google-Meet-Benachrichtigungen werden ausschließlich
von `meetings-noreply@google.com` mit passender Google-DKIM-Signatur akzeptiert;
der Einladende wird aus dem deutschen oder englischen Einladungstext gelesen und
gegen dieselbe Domainfreigabe geprüft. Die Empfängerregel gilt für diesen Einladenden.
Mehrdeutige Einladende/Links, fehlende signierte Date-/Message-ID-Header und
abgelaufene Nachrichten werden abgewiesen. Die Message-ID verhindert doppelte
Aufträge beim erneuten Import. Ohne Kalender-Endzeit gilt
`WORTLAUT_INSTANT_INVITE_MINUTES=120` ab der signierten Versandzeit. Ältere
Soforteinladungen starten keinen nachträglichen Beitritt.

Eine Google-Calendar-Einladung mit eindeutigem Meet-Link läuft durch denselben MIME-/ICS-Pfad wie Webex. Ein bereinigtes, vom vertrauenswürdigen Gateway bestätigtes `.eml` lässt sich auch ohne IMAP importieren:

```sh
curl --fail-with-body http://127.0.0.1:34601/v1/calendar/messages \
  -H "Authorization: Bearer $WORTLAUT_API_TOKEN" \
  -H 'Content-Type: message/rfc822' --data-binary @einladung.eml
```

Organizerberechtigung und Versandempfänger werden getrennt konfiguriert; Einladungs-CCs bestimmen keine Empfänger. Updates, Einzelabsagen, Sommerzeit und unterstützte RRULE/RDATE/EXDATE-Serien verwenden dauerhafte Kalenderidentitäten. `RANGE=THISANDFUTURE`, Änderungen am Zeitbezug eines bestehenden Serienmasters und hochfrequente Regeln sind nicht unterstützt; betroffene zukünftige Starts bleiben gesperrt. Link-/Zeitänderungen eines aktiven Vorkommens erzeugen einen Konflikt.

Ergebnisse gehen als TXT/VTT/JSON-Anhänge an konfigurierte Empfänger. Über dem Anhangslimit wird zuerst ZIP verwendet, danach konkrete HTTPS-Downloadbefehle mit einem Bearer-Lesezugang ausschließlich für diese Aufnahme. Der globale API-Key wird nicht verteilt. Unbekannte SMTP-DATA-Annahme bleibt `delivery_unknown`; eine bewusste Wiederholung erfolgt über `POST /v1/recordings/{id}/delivery/retry` und kann die Mail nochmals zustellen. Ohne aufgenommenes Audio entsteht keine Ergebnismail.

## Grenzen und Fehlerbehebung

- `google_meet_not_configured` / `webex_not_configured`: Providerkonfiguration prüfen. Nicht startfähige Provider belegen keine Startplätze anderer Provider.
- `audio_capacity_limit`: Rückstau, Storage und offene ASR-Aufträge prüfen. Defaults: zwei unbearbeitete Quellenstunden je Versuch, vier insgesamt, 2 GiB Audio und 2048 offene ASR-Aufträge. Die entsprechenden Settings sind in `services/meeting/src/wortlaut/settings.py` definiert.
- `audio_metadata_capacity_limit` / `audio_ingest_rate_limit`: zu viele neue Datensätze. Je Quelle gelten 512 Chunks/Bindungen/Lücken pro 60-Sekunden-Samplefenster; je Versuch ein Burst von 1024 mit Nachfüllung von 64 Datensätzen/s. Identische Replays und EOS bleiben möglich; Reconnect setzt das Kontingent nicht zurück.
- Der Worker puffert höchstens 120 Quellensekunden PCM über alle Epochen. Verworfenes Audio erscheint als endgültige Lücke. Dauerhaft gespeichertes Audio gewinnt gegen verlorene ACKs; akzeptierte Bindungen werden nicht nachträglich geändert.
- Fehlender Worklet-Eingang erzeugt nur bei bekanntem Samplebereich eine Lücke. Nullsamples bleiben Audio. Unterbrechungen der Audio-Uhr erscheinen in `audio_clock`; unbekannte Dauer wird nicht als erfundene Samplezahl aufgefüllt.
- Meet zeigt unter `receiver_sources[].encoded_transform` den Beobachterzustand, die Frameanzahl und höchstens die Metadaten des letzten Encoded-Frames. Vorhandene, reservierte und später ersetzende Provider-Transforms bleiben unangetastet. Fehlende API oder fehlgeschlagener Aufbau bleiben sichtbar; ein laufender Beobachter mit defekter Pipeline oder ausbleibender Antwort beendet den betroffenen Worker mit `encoded_transform_failed`. RTP-/Frame-/Empfangszeit ist keine PCM-Samplegrenze oder Teilnehmeridentität; die tatsächliche Bindung bleibt offen.
- Einzelne defekte Audioobjekte werden nach begrenzter Behandlung ausgewiesen, temporäre Storagefehler bleiben wiederholbar. GPU-Ausfälle lassen ASR-Aufträge warten; CUDA-/MPS-Inferenzfehler setzen den eigenen ASR-Pod unbereit und lassen ihn durch Kubernetes ersetzen.
- Audio bleibt nach Abschluss standardmäßig 24 Stunden erhalten, Text 30 Tage. Nach 72 Stunden über Terminende wird offene Verarbeitung sichtbar aufgegeben. Metadatenbereinigung wartet auf nachgewiesenes Workerende und offenen Versand; kleine Deduplizierungsdaten verhindern erneute Starts abgelaufener Aufnahmen.
- Worker verwenden Chromiums Sandbox als UID 1000. Der aktuelle Job nutzt äußeres `Unconfined`-Seccomp für User-Namespaces; ein bereits vorhandenes passendes Nodeprofil lässt sich über `WORTLAUT_WORKER_SECCOMP_TYPE=Localhost` und `WORTLAUT_WORKER_SECCOMP_PROFILE` wählen. Keine Nodeprofile oder Kernelparameter automatisch verändern.

## Prüfungen und offene Abnahme

```sh
make test
make lint
npm --prefix worker run build
npm --prefix worker run test:audio
npm --prefix worker run test:meet
# Opt-in: 90 Sekunden Ausfall mit Quellenwechseln und verlorener EOS-Antwort
WORTLAUT_TEST_LONG_TRANSPORT=true npm --prefix worker test
# Opt-in: echte GPU mit zwei getrennten Fixturequellen, keine Providerabnahme
WORTLAUT_TEST_NATIVE_ASR=true uv run --directory services/meeting pytest tests/test_asr.py::test_native_gpu_from_two_durable_sources_to_exports -q
```

PostgreSQL-/S3-Tests verwenden echte isolierte Datenbank-/Storagegrenzen. Der Ingest-Lifecycle-Test prüft 70 Bindungswechsel eines Slots, Reconnect und unveränderliche Replays mit genauen PCM-Bytes und synthetischen Teilnehmer-IDs gegen PostgreSQL/S3; er ist keine Echtzeitlastmessung oder Providerabnahme. Chromium-Fixtures prüfen Empfang, Capture, Transport und Abschluss mit synthetischen Quellen, einschließlich Encoded-Frame-Metadaten, unverändertem Tonempfang, Schutz vorhandener Provider-Transforms und Beobachterausfall. Der 90-Sekunden-Langtest verwendet den echten WebSocket-Transport mit einem Loopback-Testempfänger; er prüft Puffergrenzen, genaue Bytes/Lücken und EOS-Replay, keine DB-/S3-Haltbarkeit oder Providerzuordnung. Der vorhandene GitHub-Workflow ist für portable Prüfungen mit temporärer PostgreSQL-/S3-Instanz vorgesehen; ein lokaler Lauf beweist keinen erfolgreichen GitHub-Lauf.

Für die Abnahme fehlen ein autorisiertes Meet-Testmeeting mit getrennten Sprecherreferenzen, die tatsächliche Medien-/Teilnehmersitzungsbindung, Quellenabdeckung und der durchgängige Einladungs-/Mailpfad. Webex benötigt separat Service-App-Zugang und echte Teilnehmernachweise. Die im Pack verlangten längeren Sitzungen, mehr als 64 Quellenwechsel und Kapazitätsmessungen mit zwei Meetings bleiben eigenständige Nachweise. Konfigurierte Slots und Fixture-Sprecher-IDs beweisen keine Providerfähigkeit. Transitive Webex-Abhängigkeiten haben außerdem noch nicht abschließend bewertete Audit-Befunde.
