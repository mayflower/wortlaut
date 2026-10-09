# wortlaut: Vervollständigung und Google Meet

Gemeinsames Review und Codex-Astra-Promptpack · 6. Oktober 2026

Überarbeitet am 7. Oktober 2026: Google Meet ausschließlich als Browserteilnehmer; alle Media-API-Alternativen entfernt. Parallelbetrieb verschiedener Provider ist verbindlich; Teams folgt als weitere Integration.

Geprüfter Stand: [`mayflower/wortlaut@63005fbd48728d37438d5ecbf795075b5659a4a0`](https://github.com/mayflower/wortlaut/commit/63005fbd48728d37438d5ecbf795075b5659a4a0), Commit vom 6. Oktober 2026, 14:47 UTC. Dieses Pack setzt auf der vorhandenen Implementierung auf und ersetzt den bisherigen ausschließlich auf Webex ausgerichteten Arbeitsauftrag für die nächsten Schritte.

## Entscheidung

**Die gemeinsame Infrastruktur weiterverwenden und Google Meet als ersten praktisch betriebenen Provider fertigstellen. Google Meet, Webex und künftig Microsoft Teams werden in derselben wortlaut-Instanz parallel unterstützt.**

Parallel bedeutet gleichzeitig laufende Meetings verschiedener Provider, jeweils mit eigenem Worker und eigenen Zugangsdaten. Der Provider gehört zum einzelnen Auftrag; es gibt keine globale Auswahl eines einzigen Providers und keine gegenseitige Deaktivierung. ASR, Datenbank, Storage, Scheduler, Exporte und Mail bleiben gemeinsam. Dieses Pack implementiert Meet und erhält Webex; die konkrete Teams-Integration folgt separat, nutzt aber dieselbe Architektur und dieselben Sprecheranforderungen.

Die Codebasis enthält bereits erheblich mehr als ein Gerüst: dauerhafte Audioannahme, lokale ASR, Exporte, Kubernetes-Jobs, Kalendereinladungen und Mailversand. Das Hauptproblem ist die noch fehlende durchgehende Zuordnung von Audio zu Teilnehmern. Im Webex-Produktionspfad wird weiterhin für jede Sprecherquelle `speaker_id: null` gesetzt. Dazu kommen konkrete Fehler bei Quellenwechseln, Wiederaufnahme und Verarbeitung.

Für Google Meet ist ausschließlich der **Browserteilnehmer mit direktem WebRTC-Abgriff über Playwright/Chromium** vorgesehen. Keine Meet Media API, Meet REST API oder Google Calendar API integrieren, auch nicht bei bereits vorhandenem API-Zugang. Ein konfigurierter legitimer Browseraccount oder ein im Zieltenant zugelassener Gast ist der Teilnahmeweg. Einladungen bleiben beim vorhandenen MIME-/ICS-Pfad; die interne wortlaut-API bleibt erhalten.

Unverändert verbindlich: **ASR je tatsächlich getrennter Sprecherquelle, mit technischer Teilnehmerbindung. Kein Meetingmix, keine nachträgliche Diarisierung, keine Lautstärke-/Kachelhervorhebungs-Heuristik als Sprecheridentität.** Anzeigenamen dürfen fehlen; eine belegte Teilnehmer-ID genügt. Mehrere Menschen an einem Raummikrofon sind weiterhin eine Gerätequelle.

## 1. Umfang und Belastbarkeit des Reviews

Gelesen wurden alle produktiven Python- und TypeScript-Komponenten, Migrationen, Deploymentdateien, `AGENTS.md`, `prompts.md`, README und die relevanten Tests. Die frühere Fassung des Promptpacks wurde zusätzlich abgeglichen; für den Iststand ist der Repository-Code maßgeblich.

In dieser Review-Umgebung wurden die sechs vorhandenen reinen TypeScript-Verhaltenstests aus `chunks.test.ts` und `webex.test.ts` ausgeführt: **6 bestanden**. Dafür wurden isolierte Kopien mit Nodes eingebauter TypeScript-Transformation ausgeführt; das ist kein vollständiger Build oder Typecheck. Ein zusätzlicher Versuch am tatsächlichen `AudioTransport` zeigte: 80 wechselnde Quellenepochen mit jeweils fünf Sekunden PCM halten **400 Quellensekunden / 12.830.140 Frame-Bytes** ohne globale Pufferbegrenzung vor.

Die Python-Abhängigkeiten konnten hier nicht vollständig aus dem lokalen Cache installiert werden; konkret fehlte das gesperrte `botocore==1.43.108`. PostgreSQL-/S3-, Kubernetes-, GPU- und echte Providerläufe wurden in diesem Review deshalb **nicht erneut ausgeführt**. Die README dokumentiert frühere echte Cluster-/GPU-Läufe mit synthetischen Quellen. Diese sind wertvoll, aber kein Nachweis für einen echten Webex- oder Meet-Sprecherpfad. Das Review änderte weder das Repository auf GitHub noch die laufende Umgebung.

### Vorhandenes unbedingt behalten

- FastAPI-Meeting-Dienst, PostgreSQL/SQLAlchemy/Alembic und die überschaubaren Hintergrundschleifen.
- Binäre Audioframes, unveränderliche Chunk-IDs und Metadaten, bedingtes S3-Anlegen und ACK erst nach DB-Commit.
- Quellenbezogene VAD, gespeicherte Fortschritte, stabile ASR-Aufträge und getrennte Teilnahme-/Verarbeitungszustände.
- Ein geladenes Parakeet-Modell, GPU-Inferenzsperre, Wortzeitstempel und Begrenzung offener Arbeit.
- Deterministische Kubernetes-Jobs, exklusiver Workeranspruch, keine neue Teilnahme nach bloß fehlendem Heartbeat.
- MIME/ICS-Verarbeitung, UID/RECURRENCE-ID, Updates/Absagen, kontrollierte Serienexpansion und getrennte Ergebnisempfänger.
- TXT/VTT/JSON sowie explizites `delivery_unknown` bei unklarer SMTP-Annahme.

## 2. Konkrete Lücken

P0 = Kernfunktion fehlt. P1 = funktionaler Fehler oder erhebliche Zuverlässigkeitslücke. P2 = notwendige Betriebs-/Produktabrundung. Die Zeilen beziehen sich auf den oben genannten Commit; vor Änderungen aktuellen Stand abgleichen.

| ID | Priorität | Befund und Auswirkung | Fundstelle | Umsetzung |
|---|---|---|---|---|
| F01 | P0 | Webex setzt im realen Capturepfad immer `speaker_id: null`; `capability` bleibt `unverified`. Teilnehmerinformationen werden lediglich diagnostisch gesammelt. Das ist ASR pro Empfangsabschnitt, noch keine verlässlich teilnehmerbezogene ASR. | `worker/src/page.ts:32–61,169`; `worker/src/webex.ts:37–91` | 2, 3, 8 |
| F02 | P0 | Meet fehlt durchgehend. URL-Prüfung, ICS-Erkennung, Scheduler, Bootstrap und Runtime sind auf Webex festgelegt; es gibt kein persistiertes Providerfeld. Ohne Webex-Service-Token startet der Scheduler keinen Auftrag. Nur einen Meet-Adapter hinzuzufügen reicht nicht. | `models.py:Recording`; `validation.py`; `calendar.py:43–67`; `controller.py:388`; `app.py:125,450–499`; `worker/runtime/main.ts` | 1, 2, 6 |
| F03 | P1 | Beim 65. `AudioStream` eines Versuchs lehnt Ingest ab. Gezählt werden alle historischen Epochen, nicht gleichzeitig aktive Quellen. Capture erzeugt bei beobachteten Quellenwechseln neue Stream-/Epoch-UUIDs. Ein längeres Gespräch kann dadurch regulär abbrechen. | `ingest.py:209–215`; `worker/src/capture.ts:create`; `worker/src/page.ts:39–58` | 3, 4 |
| F04 | P1 | Die 120-Sekunden-Puffergrenze gilt je `(stream_id, epoch)`. Häufige Quellenwechsel umgehen eine globale Zeit-/Bytegrenze. Außerdem wird `drained=false` zwar in der Seite gesetzt, aber weder in die Runtime-Diagnose noch den Abschlussstatus übernommen. | `worker/src/transport.ts:46–85`; `worker/src/page.ts:77`; `worker/runtime/main.ts:28–31,79–83,140–154` | 4 |
| F05 | P1 | Ein fehlendes/beschädigtes S3-Objekt in `segment_stream()` bricht die gesamte Transaktion mit bis zu 16 Streams ab. Fortschritt und `last_scanned_at` aller betroffenen Streams rollen zurück; derselbe defekte Stream kann immer wieder zuerst ausgewählt werden und gesunde Meetings mit blockieren. | `processing.py:108–126,221–233`; `app.py:55–63` | 5 |
| F06 | P1 | Nach gespeicherter Startabsicht, aber fehlgeschlagenem Job-Create, führt ein späteres 404 dauerhaft zu `unknown/job_missing`. Es wird nicht zwischen definitiv abgelehntem Create und möglicherweise laufendem alten Worker unterschieden. Der belegte Versuch kann weitere Starts blockieren. | `controller.py:183–188,207–233` | 7 |
| F07 | P1 | Bestätigte Gap-Meldungen werden in `timeline()` erst nach Einfrieren des ganzen Versuchs berücksichtigt. Nach einem irreversibel verworfenen Chunk wartet die Segmentierung daher auch auf nachfolgendem, gesundem Audio bis zum Meetingende. Lange Meetings können so unnötig in die Rückstaugrenze laufen. | `processing.py:35–83`; `worker/src/transport.ts:55–62` | 4, 5 |
| F08 | P1 | `inference_pass()` verarbeitet genau einen Auftrag, anschließend wartet die Schleife zwei Sekunden. Damit liegt die theoretische Obergrenze schon ohne Modelllaufzeit unter 0,5 Jobs/s. Die Reihenfolge nach Hash-ID ist zudem keine Alters-/Fairnessordnung. | `app.py:55–79`; `asr.py:60–84,114–160` | 5 |
| F09 | P1 | Für Capture gibt es keine belastbare Unterscheidung zwischen fehlendem Medienempfang, Stille, unterbrochener Audiouhr und Quellenabdeckung. Bei fehlenden Worklet-Eingangsframes läuft der Samplezähler nicht weiter. Ob Chromium bei einer konkreten Unterbrechung Leerinput oder Nullsamples liefert, muss getestet werden; im Leerinput-Fall kann die Zeitachse zusammengeschoben werden. | `worker/public/pcm-worklet.js:process`; `worker/src/capture.ts`; `WorkerStatus` | 3, 4 |
| F10 | P1 | Export setzt `source_coverage` immer auf `unknown`; es gibt keinen Weg zu einem positiv geprüften Meet-Ergebnis. `no_audio_received` prüft nur, ob Streamzeilen existieren, nicht ob Samples angenommen wurden. Ein Begin ohne PCM erscheint dadurch nicht als „kein Audio“. | `exports.py:95–103,140`; `asr.py:finalize_processing` | 6 |
| F11 | P2 | Große Ergebnisse werden durch Links auf Endpunkte ersetzt, die den globalen API-Bearer verlangen. Für normale Mail-Empfänger ist das kein fertiger Abrufweg; die Weitergabe dieses Tokens würde zugleich Steuerungszugriff erlauben. Der Mailbody enthält zudem vollständige technische Qualitätsstrukturen statt einer lesbaren Ergebnisbeschreibung. | `mail.py:42–69`; `app.py:api_auth,get_export` | 6 |
| F12 | P2 | `check_range()` liest pro Chunk die gesamte Chunk-/Gap-Historie; `timeline()` und Status lesen diese ebenfalls vollständig. Wiederholte Aufnahme führt dadurch zu wachsender DB-Arbeit. Das ist ein belegtes Zugriffsmuster, noch kein gemessener Engpass. | `ingest.py:159–186`; `processing.py:timeline`; `app.py:get_recording` | 5, 9 |
| F13 | P2 | Es gibt keine Recording-Liste für den Betrieb, keinen CI-Workflow im geprüften Tree und keinen Meet-Integrationstest. Die Tests decken hauptsächlich vorhandene synthetische Grenzen ab. `make test` benötigt die Entwicklungsdienste, andernfalls werden DB-/S3-Prüfungen übersprungen. | `app.py`; `Makefile`; `tests/conftest.py`; Repository-Tree | 6, 9 |
| F14 | P2 | Audio-/Transkript-Retention entfernt PCM bzw. `TranscriptSegment`, behält aber Einladungstext, Teilnehmermetadaten und Chunk-/Kontrollhistorie. Das entspricht keiner vollständigen Löschung der Meetingdaten und lässt Metadaten weiter wachsen. | `retention.py`; `models.py:CalendarEntry,AudioControl,AudioChunk` | 6 |

### Was daraus nicht folgt

Die vorhandene Verarbeitung muss nicht neu gebaut werden. Weder Redis/Celery noch ein Agentenframework, eine zusätzliche Workflow-Engine oder LiveKit lösen diese Lücken. Auch mehr Diagnostik allein löst F01 nicht: Es muss ein funktionierender Medien-/Teilnehmerpfad entstehen.

Die bisherigen Aussagen zur Webex-Fähigkeit bleiben ausdrücklich offen: Fehlender Zugang ist kein Nachweis, dass Webex das benötigte Audio nicht liefern kann. Umgekehrt beweisen mehrere Receiver keine korrekte Teilnehmerzuordnung. [R1]

## 3. Google Meet: recherchierter Integrationsweg

### Verbindlicher Browserzugang

Playwright/Chromium nimmt über den normalen Meet-Webclient teil. Beitritt, Zulassung und Leave werden im Browser ausgeführt; empfangene WebRTC-Medien und die tatsächlich verfügbaren technischen Teilnehmermetadaten werden dort erfasst. [V1,V2]

Die Anzahl gleichzeitig ungemischt empfangener Quellen und deren Teilnehmerbindung müssen am tatsächlichen Browserpfad gemessen werden. Keine feste Quellenzahl und keine Gleichsetzung von CSRC, SSRC und Teilnehmer-ID ohne Nachweis voraussetzen. Meet-Untertitel ersetzen die lokale ASR pro Quelle nicht.

### Vexa gezielt verwenden

Geprüft wurde Vexa unter `18e7ac1d6a0201d1489ce30b12b6f7138067a598`. Das isolierte `@vexa/join` ist eine sinnvolle Quelle für Meet-Beitritt, Lobby, Ablehnung und Leave. Vor direkter Paketübernahme muss seine tatsächliche Verfügbarkeit und Kompatibilität mit dem bereits gesperrten Playwright geprüft werden; im geprüften Unterpaket steht Playwright 1.56.0, wortlaut nutzt 1.63.0. Die bloße Existenz einer `package.json` beweist keine passende veröffentlichte npm-Version. [V1]

Vexas `gmeet-capture` greift Medienobjekte ab. Der `GmeetChannelBinder` korreliert jedoch Energie und sichtbare Sprecherhervorhebung, mit einem abklingenden Korrelationswert. Diese Bindung ist **nicht** der gesuchte eindeutige Medien-/Teilnehmernachweis. Die Capture-Implementierung überspringt außerdem leise Blöcke; eine Übernahme müsste den Zeitbezug der ausgelassenen Intervalle erhalten. Daher Join-Code gezielt nutzen, vorhandene wortlaut-Audiopipeline behalten und den Binder nicht übernehmen. [V2,V3]

Die WebRTC-Schnittstelle `getContributingSources()` enthält Quellen aus einem zurückliegenden Zehn-Sekunden-Fenster. Eine solche Liste oder ein fünfsekündiges Polling darf nicht ungeprüft zum Bindungszeitpunkt eines PCM-Blocks erklärt werden. [W1]

Als zusätzliche Gegenprobe wurde Attendee unter `ce53d04ebe736bbcc57690c8355e61dbf30478ba` gelesen. Dort gibt es Protokoll-/Device-Metadaten, aber der betrachtete `handleAudioTrack` wählt die lauteste der gemeldeten Quellen; der alte Frame-Interceptor ist im betrachteten Abschnitt zudem auskommentiert. Auch das ist keine fertige, nachgewiesene Lösung für wortlaut. Das Repository steht unter Elastic License 2.0 und wird hier nicht als zu übernehmende Bibliothek beauftragt. [A1]

### Die tatsächlich fehlende Verbindung

Jeder transkribierte Bereich benötigt diese zusammenhängende Information:

`empfangene Medienframes → Quellkennung im Medienzeitintervall → Provider-Teilnehmersitzung → lokaler Samplebereich → ASR-Auftrag`

Transportidentität, Quellenidentität und Anzeigename bleiben verschiedene Felder. Der normale Meet-Webclient hat einen eigenen Signalisierungsvertrag; dessen tatsächliche Quellkennungen, Teilnehmer- und Sitzungsmetadaten müssen im Browser beobachtet und mit den empfangenen Medien verbunden werden. Keine fremden Signalisierungsschemas oder lediglich namensbasierte Zuordnung voraussetzen.

Praktischer Implementierungsweg: zunächst nativen Receiver und dessen Medien-/Teilnehmerinformationen zusammen erfassen. Wo eine präzise Framebindung im dekodierten Pfad nicht zugänglich ist, einen **beobachtenden Encoded-Transform-Pfad** prüfen. `RTCEncodedAudioFrame`-Metadaten sehen unter anderem CSRCs und RTP-Zeitstempel vor. Verfügbarkeit und vorhandene Transform-Nutzung müssen im gesperrten Chromium getestet werden. Bei nötiger zusätzlicher Dekodierung vorhandenes WebCodecs `AudioDecoder` bzw. eine passende etablierte Opus-Implementierung verwenden; keine eigene RTP-/Opus-Engine schreiben. Der eigentliche Meet-Empfang wird unverändert weiterbedient. [W2,W3]

Dieser Pfad ist ein konkreter Implementierungsansatz, kein bereits ausgeführter Meet-Nachweis. Die offene Frage lautet nicht „kann Chromium Audio liefern?“, sondern „welche Medienframes gehören beim Quellenwechsel nachweislich zu welcher Teilnehmersitzung?“. Genau das wird früh in Prompt 2/3 umgesetzt und geprüft.

## 4. Ausführung des Promptpacks

Gemeinsamen Auftrag einmal vorgeben, danach Prompt 1 bis 9 in Reihenfolge. Alle Meet-Prompts verwenden ausschließlich den Browserzugang. Pro Sitzung bis zum Ergebnis arbeiten; keine Bestätigung nach jedem Unterpunkt. Bei neuem Kontext gemeinsamen Auftrag erneut mitgeben.

Die vorhandene Regel „Webex ist der einzige Provider“ in `AGENTS.md` und der alte Auftrag in `prompts.md` werden gezielt an diesen ausdrücklich beauftragten parallelen Providerbetrieb mit Meet/Webex und künftig Teams angepasst. Andere Regeln – insbesondere Entwicklungsnamespace, Schutz unabhängiger Änderungen und kein automatischer Commit/Push – bleiben erhalten.

### Gemeinsamer Auftrag

```text
Du vervollständigst mayflower/wortlaut auf Grundlage dieses Reviews und
führst Google Meet als zweiten Provider ein. Meet soll zuerst real betrieben
werden können; die noch fehlende Webex-App darf keinen Meet-Pfad blockieren.
Liefere ausführbaren Code, Migrationen, Worker-Image, vorhandenes Deployment
und eine kurze, brauchbare Betriebsanleitung.

Lies AGENTS.md, README.md, prompts.md und den aktuellen Code. Ausgangspunkt
des Reviews ist 63005fbd48728d37438d5ecbf795075b5659a4a0. Prüfe bei anderem
HEAD die betroffenen Stellen; repariere keine bereits behobenen Befunde
erneut. Arbeite im vorhandenen Checkout und erhalte fremde Änderungen.

Die neue Nutzeranforderung erweitert ausdrücklich Webex-only zu Webex plus
Google Meet im Parallelbetrieb; Microsoft Teams soll später als weiterer
paralleler Provider hinzukommen. Aktualisiere diese Produktvorgabe in AGENTS.md/prompts.md, ohne
andere Projekt- oder Berechtigungsregeln umzuschreiben.

Verbindlich:
- Produktname wortlaut. Direkter Empfang getrennter Quellen vor dem Mix.
- ASR pro Teilnehmerquelle mit technischer Teilnehmerbindung im jeweiligen
  Audiozeitintervall. Kein Meetingmix, keine Diarisierung, Voiceprints,
  Sprecherhervorhebungs- oder Lautstärkeheuristik als Identitätsersatz.
- Ein Teilnehmername ist Anzeige, keine ID. Gleiche Namen, Umbenennen,
  Wiedereintritt und mehrere Geräte müssen unterscheidbar bleiben.
- Teilnehmer-ID ohne Anzeigenamen ist zulässig. Eine unbekannte Quelle
  darf diagnostisch erhalten bleiben, ist aber kein erfüllter Sprecherpfad.
- Ein Raummikrofon mit mehreren Personen bleibt eine Gerätequelle.
- Ein geladenes Parakeet-Modell, gemeinsame VAD/ASR/Storage/Exporte/Mail.
- Bestehende Architektur weiterverwenden. Keine zweite Audio-Ingest-API,
  kein Provider-Pluginframework, keine Queue-/Workflow-Plattform, kein
  Agentenframework, kein zusätzliches Frontend und keine Cloud-ASR.
- Provider je Aufnahme wählen; Meetings verschiedener Provider laufen
  gleichzeitig in derselben Instanz. Kein globaler Providerumschalter.
- Zugänge und Startvoraussetzungen je Provider prüfen. Ein fehlender oder
  deaktivierter Zugang sperrt nur diesen Provider. Gemeinsame Kapazitäts-
  grenzen gelten für alle Meetings; sie sind kein Providerwahlmodus.
- Kleine explizite Providerzweige genügen; Teams später auf demselben Weg
  ergänzen. Lifecycle/Capture/Transport und Verarbeitung dort teilen, wo
  sie tatsächlich gemeinsam gebraucht werden. Keine fertige Teams-
  Unterstützung behaupten, bevor Beitritt und Sprecherpfad umgesetzt sind.

Google-Zugang:
- Ausschließlich Browserteilnehmer mit direktem WebRTC-Abgriff über
  Playwright/Chromium. Keine Google-Medien-, Meet-REST- oder Calendar-API
  integrieren, auch nicht bei bereits vorhandenem Zugang.
- Browserauthentifizierung über einen konfigurierten legitimen Account
  oder zulässigen Gast; keine Google-API-Tokens als Teilnahmeweg verwenden.
- Keine automatische Ausweichkette nach Ablehnung, Entfernung oder einer
  Autorisierungsentscheidung. Einladungen weiter über MIME/ICS verarbeiten.
- Authentifizierung, Providerfähigkeit und Aufnahmequalität getrennt melden.
  Fehlende Zugangsdaten bedeuten nicht capability_unsupported.

Arbeitsweise:
- Nutze make setup/make dev und die bestehende Projektumgebung, soweit
  verfügbar. Kubernetes immer mit projektlokaler Kubeconfig, Context data
  und wortlaut-<Benutzer>; globale Infrastruktur nicht verändern.
- Wiederverwende vorhandene Bibliotheken. Pinne konkret verfügbare Quellen
  und Versionen, keine erfundenen npm-Pakete und kein blindes SDK-Upgrade.
- Implementiere die angefragten Änderungen vollständig. Ein Diagnosebericht
  oder ein weiterer dauerhaft unverified bleibender Adapter ist nicht das Ziel.
- Ein fehlender externer Zugang blockiert nur den jeweiligen echten Test.
  Alle unabhängig ausführbaren Implementierungen und Prüfungen fortsetzen.
- Prüfe echte Fehlerpfade mit passenden Verhaltenstests. Kein generischer
  Testszenario-Generator, keine Testpyramide als Selbstzweck, kein eigener
  Provenance-/Freigabeworkflow. Nach ausreichender Prüfung weiterarbeiten.
- Keine Token, Cookies, vollständigen SDP-/Signalisierungsnachrichten oder
  Meetinginhalte in normale Logs. Kleine bereinigte Testtraces genügen.
- Ohne ausdrücklichen Auftrag keine Subagenten, Commits oder Pushes.

Berichte pro Prompt kurz: umgesetzt, geprüft, noch konkret blockiert.
Bewerte Meet und Webex getrennt. Synthetische Tests, reale Provideraufnahme
und Lastmessung sind unterschiedliche Nachweise.
```

## Prompt 1 — Provider durch das vorhandene System führen

**Ergebnis:** Meet- und Webex-Aufträge können gleichzeitig angelegt, geplant und gestartet werden; jeder benötigt nur seinen eigenen Zugang. Die bisherige Datenbank bleibt nutzbar.

```text
Implementiere die kleine Providererweiterung im vorhandenen wortlaut.
Beachte den gemeinsamen Auftrag.

Betroffene Stellen: models.py, neue Alembic-Migration, validation.py,
RecordingRequest/recording_json/bootstrap/WorkerStatus in app.py,
calendar.py, recurrence.py, controller.py, settings.py,
worker/runtime/main.ts sowie AGENTS.md/prompts.md.

1. Persistiere provider = webex | google_meet auf Recording. Migriere
   vorhandene Zeilen zu webex. Bestehende Clients mit Webex-URL bleiben
   kompatibel. Leite den Provider eindeutig aus einer validierten URL ab;
   falls zusätzlich explizit angegeben, muss er zur URL passen.
   Provider- und URL-Wechsel während eines aktiven Versuchs sind ein
   Konflikt, kein stiller Umbau des laufenden Workers.

2. Implementiere eine gemeinsame URL-Normalisierung mit zwei kleinen
   Providerzweigen. Für Meet zunächst https://meet.google.com/abc-defg-hij
   mit validiertem Meetingcode. Benutzerinfo, andere Ports, fremde Hosts,
   Suffix-Tricks und beliebige Weiterleitungsziele ablehnen. harmlose
   Tracking-/authuser-Parameter nicht zur Meetingidentität machen.
   Kurzcodes/Nicknames/Lookup-Links nur unterstützen, wenn ein konkreter
   autorisierter Auflösungsweg gebraucht und implementiert wird.

3. Provider durch Einzeltermin, Serienmaterialisierung, Status, Export
   und Job-Bootstrap führen. Kalendereinladungen weiterhin über den
   bestehenden MIME/ICS-Weg verarbeiten. Keine zweite Calendar-Sync bauen.
   Meet-Links auch in Googles X-GOOGLE-CONFERENCE und üblichen ICS-Feldern
   berücksichtigen; vorhandene UID/Organizer/RECURRENCE-ID beibehalten.
   Unterschiedliche Links nach Normalisierung deduplizieren. Bei mehreren
   echten Konferenzzielen einen sichtbaren Konflikt erzeugen.

4. Scheduler-Konfiguration providerbezogen prüfen. Meet und Webex müssen
   bei vorhandenen Zugängen gleichzeitig betrieben werden können. Ein ausgeschalteter
   oder nicht konfigurierter Webex-Zugang verhindert keine Meet-Jobs.
   Für Meet keine Gasttoken-Ausgabe über webex.py aufrufen.
   Bootstrap liefert gemeinsame Aufnahme-/Deadline-/Transportdaten und
   nur die zum gewählten Provider gehörende Konfiguration.

5. Teile die Runtime minimal: gemeinsamer Anspruch, Heartbeat, Deadline,
   Stop und Abschluss; zwei explizite Startpfade. Webex-Gast-Refresh bleibt
   ausschließlich im Webex-Pfad. Capture-Diagnose um die tatsächlich
   benötigten Meet-Felder erweitern, keine abstrakte Capability-Registry.

6. Secret-/Tilt-/Job-Konfiguration für den Meet-Browserzugang ergänzen.
   Nur erforderlichen Browserzustand konfigurieren; keine Google-API-Keys,
   OAuth-API-Tokens, Service Accounts oder Cloud-Projekte voraussetzen.
   Bestehende Aufnahmen und Jobs nicht neu erzeugen oder neu beitreten.

Prüfe: Migration mit bestehenden Webex-Zeilen; alter Webex-API-Auftrag;
Meet per interner wortlaut-API und ICS ohne Webex-Token; widersprüchlicher Provider; doppelt
vorkommende identische Meet-Links; zwei verschiedene Links; Serienupdate
und Absage. Prüfe am Job-Manifest, dass Meet keine Webex-Secrets erhält. Plane Meet
und Webex gleichzeitig und prüfe getrennte Worker, Zugänge und Zustände
unter denselben gemeinsamen Kapazitätsgrenzen.
```

## Prompt 2 — Meet beitreten und reale Medien erschließen

**Ergebnis:** Ein echter Meet-Teilnehmer im vorhandenen Worker, mit funktionierendem Medienempfang und sauberem Lebenszyklus. Bereits in diesem Schritt echte Quellenwechsel untersuchen; nicht erst nach Kalender- und Betriebsarbeiten.

```text
Implementiere ausschließlich den Meet-Browserteilnehmer mit dem vorhandenen
Playwright/Chromium. Lies die Vexa-Dateien am fixierten Stand und prüfe den
aktuellen Meet-Webclient. Vorhandenen autorisierten Browserzustand bzw.
zulässige Gastteilnahme prüfen, ohne Secretwerte auszugeben. Kein Google-
API-Zugang wird benötigt, geprüft oder als alternativer Pfad implementiert.

Beitritt und Medienempfang im Browser:
- Playwright/Chromium im vorhandenen Worker verwenden. Vexas isolierte
  Meet-Join-/Admission-/Leave-Logik prüfen und geeignete kleine Teile mit
  Lizenzhinweisen übernehmen, falls das veröffentlichte Paket nicht ohne
  dessen restlichen Stack und Versionskonflikte nutzbar ist.
- Keine weitere Playwright-Version, keine Stealth-/Mausbewegungssimulation
  oder Vexa-Infrastruktur allein für den Beitritt einführen.
- Einen konfigurierten, legitimen Botaccount oder im Zieltenant zulässigen
  Gast verwenden. Einen autorisierten Browserzustand bei Bedarf schreibgeschützt
  laden und pro Job in ein frisches Profil kopieren. Keine Google-API-Tokens
  als Browserzustand verwenden. Keine Passwörter/MFA automatisiert erraten.
- Sprache/Locale bewusst setzen; Mikrofon und Kamera ausschalten, Audio
  empfangen. Zulassung, Ablehnung, Lobby-Timeout, Entfernen, Meetingende,
  Deadline und SIGTERM als verschiedene Ereignisse behandeln.
- Hooks auf RTCPeerConnection/Receiver und relevante Signalisierung vor
  der Seitennavigation installieren. Native Methoden/Events funktionsfähig
  lassen und neue/ersetzte Tracks deduplizieren. Keine Capture-Erfassung
  erst nach einem langen erfolgreichen Join-Dialog beginnen.
- Ermittele tatsächliche Quellkennungen und Teilnehmermetadaten des
  aktuellen Webclients. Dessen tatsächlichen Signalisierungsvertrag prüfen;
  nur benötigte Felder mit etablierter Parsingbibliothek verarbeiten.
  Keine Teilnehmer-IDs aus Namenslisten oder Lautstärke erfinden.

Browserbridge und Transport:
- Worker-Credential und globaler API-Key gehören nicht in die Google-Seite.
  Der Node-Worker hält den authentifizierten Backendtransport. Die Browser-
  Bridge erhält nur Capturekonfiguration und liefert begrenzte Audio-/Source-
  Nachrichten; Aufrufe auf erwartete Seite/Frame und Versuch beschränken.
- Audio in handlichen Blöcken übergeben, nicht einen RPC pro 128 Samples.
  Falls für die Browserbridge serialisiert werden muss, nur dort; zum
  Backend bleibt das bestehende binäre Audioformat erhalten.
- Capture/Resampler als lokale gepinnte Assets packen. Die bestehenden
  /sdk-Pfade dürfen im Meet-Origin nicht versehentlich auf Google zeigen.
  Den tatsächlichen AudioWorklet-/WASM-Ladeweg unter der realen CSP prüfen;
  weder externe Skript-CDNs noch pauschales Abschalten von Browser-Sicherheit.
- Ein abgelehnter oder entfernter Teilnehmer tritt nicht automatisch erneut
  bei. Fehlender Medienfluss ist nicht gleichbedeutend mit normaler Stille.

Prüfe mit zwei getrennten Teilnehmergeräten: Zulassung, verständlicher
Empfang zweier Quellen, kontrollierter Wechsel A→B→A und gleichzeitiges
Sprechen. Notiere nur die konkrete beobachtete Quell-/Teilnehmerkette.
Das endgültige teilnehmerbezogene PCM implementierst du direkt in Prompt 3.
Fehlt externer Zugang, implementiere alle ausführbaren Teile und benenne
genau den fehlenden Zugang; ersetze ihn nicht durch eine Erfolgssimulation.
```

## Prompt 3 — Audio wirklich an Teilnehmer binden

**Ergebnis:** Teilnehmer A und B werden auch bei Überlappung und Slotwechseln getrennt transkribiert. Dies ist der zentrale Integrationsauftrag.

```text
Vervollständige den Meet-Capturepfad bis zur nachweisbaren Teilnehmerbindung.
Nutze vorhandene Chunk-/Bind-/VAD-Verträge und ändere sie nur, wo der reale
Medienpfad es erfordert. Relevante Dateien: capture.ts, chunks.ts,
pcm-worklet.js, neuer Meet-Capturezweig, ingest.py und processing.py.

1. Unterscheide Provider-Session, Empfangsslot/Track, tatsächliche Quelle,
   Teilnehmersitzung und Anzeigename. Namespace IDs je Provider/Meeting.
   Behalte einen Teilnehmer über Slotwechsel hinweg identifizierbar;
   Wiedereintritt darf eine neue Sitzung sein. Namensgleichheit verbindet
   niemals zwei Personen. Freigabe-Audio getrennt kennzeichnen.

2. Verwende die in Prompt 2 beobachtete Medien-/Signalisierungszuordnung
   des tatsächlich verwendeten, versionsgebundenen Meet-Webclientpfads.
   Die Zuordnung muss das konkrete Medienzeitintervall abdecken.
   Ein sourceUpdate-Ankunftszeitpunkt oder die bloße Anwesenheit einer
   Quelle in getContributingSources() ist keine exakte PCM-Grenze.
   Weder höchstes audioLevel noch eine leuchtende Kachel entscheidet die ID.

3. Prüfe zuerst einen nativen dekodierten Pfad mit belastbarer Frame-
   Zuordnung. Reicht er beim Slotwechsel nicht aus, implementiere einen
   beobachtenden Encoded-Transform-Pfad, soweit Chromium/Meet ihn tatsächlich
   anbieten. Nutze Frame-CSRC/RTP-Zeitstempel; vorhandene Provider-Transforms
   nicht überschreiben. Originalframes unverändert weiterreichen.
   Feature-Detect und Fehlerfall sind ausführbarer Code, kein Kommentar.

4. Falls die PCM-Zuordnung zusätzliche Dekodierung braucht, nutze einen
   vorhandenen Decoder, vorzugsweise unterstütztes WebCodecs AudioDecoder.
   Prüfe Codec/Format real mit isConfigSupported und dem tatsächlichen
   Empfang. Ein EncodedAudioFrame ist nicht von selbst fertiges PCM.
   Kein eigener Codec, Jitterbuffer oder allgemeiner RTP-Server.
   Decoderzustand, Reordering und Reset bei Quellwechseln gezielt prüfen;
   ein Reset darf keine stillschweigend verworfenen Übergangsframes erzeugen.

5. Übersetze Medienzeit in eine gemeinsame Meetingzeit und 16-kHz-Samples.
   RTP-Zeitstempel verschiedener SSRCs sind nicht ohne Weiteres dieselbe Uhr;
   Wraparound, Discontinuities und Capture-/Playout-Verzögerung berücksichtigen.
   Nutze verfügbare native Zeitbezüge, keine Date.now()-Zuordnung pro Chunk.
   Bei Resampling Zähler/Filterverzögerung konsistent führen. Ein ausbleibender
   Eingangsblock darf nicht die folgenden Samples zeitlich nach vorn schieben.

6. Audio und zugehörige Metadaten vor Annahme gemeinsam ordnen. Kurzzeitig
   vorauseilendes Audio darf begrenzt auf Quellenmetadaten warten; danach
   bleibt der Bereich ausdrücklich ungebunden. Keine nachträgliche Umbenennung
   bereits akzeptierter Chunks. Bei belegter Bindungsgrenze Chunk flushen,
   Bindung persistieren, VAD-/Decoderzustand passend schließen. Unklare
   Übergangsspannen nicht einer Person zuschlagen.

7. Transport- und Quellwechsel dürfen keine unbegrenzte Streamneuanlage
   erzwingen. Nutze vorhandenes bindAtSample/bind bei exakter Grenze, sonst
   explizite Epoche. Zähle aktive Quellen separat von historischen Epochen.
   Begrenze Speicher/Rate statt nach 64 regulären Wechseln das Meeting zu stoppen.

8. Pro tatsächlich getrennter Quelle segmentieren. Derselbe Audiomix darf
   nicht als mehrere Sprecherjobs dupliziert werden. Quellabdeckung separat
   erfassen: Was nicht vom Provider geliefert wird, kann wortlaut nicht
   transkribieren. Keine pauschale Vollständigkeit aus leeren Gap-Listen.

Prüfe ein echtes Meet mit mindestens vier Teilnehmern:
- A und B gleichzeitig mit verschiedenen, vorher bekannten Texten;
- A→B→C→A bei fortbestehenden Receivern, mehrfach wiederholen;
- gleiche Anzeigenamen, Umbenennen, Mute/Unmute, Austritt/Wiedereintritt;
- zusätzliche Freigabe mit Audio; abschließender kurzer Satz vor Stop;
- mehr als 64 kontrollierte Bindungswechsel ohne historischen Streamdeckel.
Vier gleichzeitig sprechende Quellen dienen zusätzlich zur Ermittlung der
tatsächlichen Browser-Providergrenze; die gelieferte Quellenzahl messen.

Prüfe PCM und Transkript pro Teilnehmer gegen die getrennten Referenzen.
Für die kontrollierten zugeordneten Bereiche sind falsche Teilnehmerbindungen
und Kopien fremder Quellen Fehler; ungebundene Sprachdauer separat messen.
Wenn der beobachtete Providerpfad die Anforderung nicht erfüllt, die genaue
Ursache und die getesteten Zugänge nennen. Nicht einfach einen dritten
anonymen Track-Recorder bauen und ihn als per-speaker fertig deklarieren.
```

## Prompt 4 — Puffer, Lücken und Abschluss zuverlässig machen

**Ergebnis:** Ein kurzer Dienstausfall oder Quellenwechsel führt weder zu unbemerktem Audioverlust noch zu wachsendem RAM ohne Gesamtgrenze.

```text
Behebe F03/F04/F07/F09 im gemeinsamen Capture-/Transport-/Ingestpfad.
Erhalte das bestehende ACK-/S3-/DB-Modell; kein zweites Warteschlangensystem.

1. Begrenze unbestätigte Frames über den gesamten Worker nach tatsächlichen
   Bytes und Quellendauer. Berücksichtige geschlossene Epochen, Metadaten,
   Browserbridge und WebSocket-bufferedAmount. Per-Stream-Limits allein
   reichen nicht. Ausgeschöpfte Kapazität erzeugt einen expliziten Verlust-
   oder Stopgrund; sie darf keine endlos wachsende Sammlung alter Epochen sein.

2. Begin/Bind/End/Gap bleiben geordnet und wiederholbar. Control-Limits
   müssen nachvollziehbare Grenzen haben; überschrittene Steuerkapazität
   darf das einzige Verlustsignal nicht selbst lautlos verwerfen.
   Falls Bereiche komprimiert werden, keine bestätigten IDs/Verträge ändern.

3. Definiere einen kleinen, eindeutigen Abschluss für unwiederbringlich
   verworfene Bereiche. Bereits dauerhaft gespeichertes Audio gewinnt
   weiterhin gegen verlorene ACKs. Bestätigte Verlustbereiche dürfen nach
   geklärter Replay-/Verbindungsreihenfolge die laufende Segmentierung
   fortsetzen lassen, ohne das ganze Meeting einzufrieren.
   Prüfe ausdrücklich die Konkurrenz einer alten und neuen Verbindung;
   ein später gültiger Replay darf keinen bereits finalisierten Bereich
   heimlich umdeuten. Nutze die kleinste nötige Sitzungs-/Abschlussregel.

4. Stop-Reihenfolge: Capture stoppen, Resampler-/Chunkrest flushen, EOS und
   bekannte Abschlussgrenzen persistieren, Transport begrenzt leeren,
   Provider verlassen, Browser schließen, finalen Status melden.
   Persistiere drained/undelivered_audio mit dem vorhandenen Statuspfad.
   Unvollständiger Drain darf nicht end_reason=normal mit unauffälligem
   Qualitätsergebnis ergeben. Keine unendlichen Stop-Wartezeiten.

5. Trenne Providerverbindung, Empfang, Capturefluss und dauerhaften Ingest.
   Prüfe AudioContext suspended/interrupted und leere Worklet-Inputs.
   Normale Nullsamples/Stille sind nicht Netzwerkverlust. Bekannte
   Unterbrechungen erhalten einen Zeitbereich; unbekannte Grenzen bleiben
   unbekannt und werden nicht durch erfundene Samplezahlen aufgefüllt.

6. Unveränderte Quellensignale dürfen Capture nicht neu starten. Beobachtete
   Teilnehmerwechsel schließen den richtigen Bereich ohne Doppel-Capture.
   Alte Listener, Decoder und Worklets nach Abschluss freigeben.

Gezielte Prüfungen: 90 Sekunden Ingest-Ausfall mit wechselnden Quellen;
Überschreiten der Gesamtgrenze; gespeicherter Chunk mit verlorenem ACK;
mehrere Epochen bei demselben Slot; verlorene EOS-Antwort; Stop während
Reconnect; fehlendes EOS nach Browserabsturz; Audio-Uhr-Unterbrechung.
Prüfe echte Bytes und Grenzen, nicht nur Logmeldungen. Der letzte Satz
muss im erfolgreich geleerten Fall enthalten sein; Verluste sichtbar.
```

## Prompt 5 — Verarbeitung gegen Einzeldefekte schützen und Rückstau abbauen

**Ergebnis:** Ein defekter Stream blockiert keine anderen Meetings. Vorhandene GPU-Leistung wird ohne künstliche Pausen genutzt.

```text
Behebe F05/F08 und die relevanten Teile von F07/F12 in processing.py,
asr.py, app.py und den bestehenden Datenbankzugriffen.

1. Isoliere Segmentierungsfortschritt pro Stream/kleiner Arbeitseinheit.
   Ein fehlendes Objekt, Integritätsfehler oder vorübergehender S3-Fehler
   darf nicht Fortschritt aller 16 ausgewählten Streams zurückrollen.
   Nutze kleine Transaktionen oder passende Savepoints. Halte DB-Sperren
   nicht unnötig während vieler Objektlesevorgänge.

2. Temporäre Storageprobleme bleiben wiederholbar. Dauerhaft defekte
   Bereiche bekommen nach begrenzter Behandlung einen konkret sichtbaren
   Verarbeitungsfehler; gesunde Bereiche und andere Meetings laufen weiter.
   Nicht einfach scan_complete=true setzen und den fehlenden Satz vergessen.
   Bereits akzeptierte Audio-/Bindingverträge und ASR-IDs bleiben stabil.

3. Der ASR-Consumer arbeitet bei vorhandenem Rückstau direkt weiter.
   Warten nur im Leerlauf, bei sinnvoller Fairnessgrenze oder Retry-Backoff.
   Bestehende PostgreSQL-Claims und GPU-Sperre weiterverwenden. Starte nicht
   mehrere Modellkopien oder einen CUDA-Thread je Sprecher.

4. Ordne neue Aufträge nachvollziehbar nach Alter; verhindere dauerhafte
   Bevorzugung niedriger Hash-IDs. Ein einfaches created_at plus bestehender
   Claim-Mechanismus genügt. 429/Timeout/temporäre Ausfälle zurückstellen,
   valide späte Ergebnisse deduplizieren, explizit aufgegebene Arbeit nicht
   wiederbeleben. Modell-/Wortzeitstempelfehler weiterhin prüfen.

5. Begrenze Datenbankarbeit: Range-Validierung über benachbarte Sequenzen
   und relevante Überlappungen statt vollständiger Historie pro Chunk;
   Segmentierung ab gespeichertem Fortschritt mit nötigem Kontext.
   Kleine geeignete Indizes und SQL-Abfragen vor zusätzlicher Infrastruktur.
   Audiofortschritt und Status nach Möglichkeit aggregiert lesen. Erhalte
   weiterhin die Prüfung von Reihenfolge, Lücken und Bindungsgrenzen.

6. Ergänze wenige nützliche Messwerte in vorhandene Status-/Loggingwege:
   offene Quellensekunden, Alter des ältesten Auftrags, Inferenzdauer,
   Zeit von Sprachende bis gespeichertem Segment, Fehler je Komponente.
   Kein Observability-Projekt oder neuer Metrikdienst.

Prüfe: ein beschädigtes PCM-Objekt plus gesundes zweites Meeting; S3-Ausfall
und Wiederkehr; Modell-HTTP-Timeout bei weiterlaufender GPU; 429; Wiederstart
mit offenem VAD-Segment; langer Satz über ASR-Kerngrenzen ohne verlorene
oder doppelte Wörter. Zeige, dass gesunde Arbeit trotz defekter Quelle
abschließt und dass bei Backlog keine feste Zwei-Sekunden-Pause bleibt.
```

## Prompt 6 — Kalender, Ergebnisqualität und Versand vervollständigen

**Ergebnis:** Ein Meet-Termin kann per Einladung bis zum verständlichen, abrufbaren Ergebnis durchlaufen. Der Betriebsstatus lässt sich ohne neue Oberfläche nutzen.

```text
Vervollständige die vorhandenen Kalender-/Export-/Mailpfade für beide
Provider; behebe F10/F11/F13/F14. Kein separates Google-Kalenderprodukt.

1. Prüfe echte, bereinigte Google-Calendar-ICS-Beispiele: URL/LOCATION/
   DESCRIPTION/X-GOOGLE-CONFERENCE, HTML-Mail, identische Linkvarianten,
   Einzeltermin, Serie, Sommerzeit, verschobener Einzeltermin und Absage.
   Bestehende eingeschränkte Serienunterstützung dokumentiert beibehalten;
   keine vollständige iTIP-Engine nachbauen. Eine API-Key-geschützte
   Kalenderzuführung braucht weiterhin keinen IMAP-Dienst.

2. Erzeuge einen fachlichen Qualitätsstatus aus tatsächlichen Fakten:
   Audio empfangen, Teilnehmerzuordnung, bekannte Lücken, ungebundene
   Sprachbereiche, Providerabdeckung, unvollständiger Drain, ASR-Ausfälle.
   Verarbeitung=completed bedeutet nur, dass die Verarbeitung beendet ist.
   Teilnehmer- und Quellenanforderung müssen zusätzlich sichtbar erfüllt
   oder verletzt sein. Keine fest verdrahtete source_coverage=unknown für
   alle zukünftig erfolgreich geprüften Aufnahmen.
   Keine Gap-Liste ist aber auch kein Beweis für vollständige Providerabdeckung.

3. no_audio_received aus angenommenen Samples bestimmen, nicht aus der
   Existenz eines Begin-Eintrags. Kein Audio, nachgewiesene Stille und
   fehlgeschlagene Aufnahme unterscheidbar machen. Bei null Audio keine
   leere Erfolgsmail; dem Betreiber einen konkreten Abschlussgrund zeigen.

4. TXT/VTT/JSON enthalten Provider, stabiles Teilnehmerlabel und korrekte
   Meetingzeiten. Echte Überlappungen erhalten. JSON enthält die technischen
   Details, TXT/Mail eine kurze lesbare Beschreibung vorhandener Lücken.
   Ein ungebundener Bereich darf nicht als benannter Sprecher erscheinen.
   Quellen-/Teilnehmer-Metadaten aus Prompt 3 durch alle Schichten erhalten.

5. Bestehende getrennte Empfängerkonfiguration und SMTP-Annahmesemantik
   beibehalten. Standard bleiben Anhänge. Große Exporte verlustfrei komprimiert
   oder auf mehrere Anhänge verteilt vollständig zustellen; niemals Text
   abschneiden, um unter das Größenlimit zu kommen. Ein vorhandener
   authentifizierter Downloadzugang kann wiederverwendet werden.
   Den globalen Steuerungs-API-Key niemals als Leser-Credential verteilen.
   Wenn ein separater API-Abruf nötig ist, minimal auf genau eine Aufnahme
   und Lesen beschränken und den Nutzungsweg konkret dokumentieren; keine
   neue Benutzerverwaltung. Keine Tokens in URLs oder normalen Logs.
   Nicht lediglich unbrauchbare Links als erfolgreichen Versand verkaufen.

6. Kleine paginierte GET-/v1/recordings-Liste mit Zeit, Provider, Teilnahme,
   Verarbeitungs-/Qualitäts-/Versandstatus ergänzen. Bestehenden API-Schutz
   verwenden; keine neue Weboberfläche.

7. Retention präzisieren und vervollständigen: nach Transkriptaufbewahrung
   zugehörige sensible Teilnehmer-/Einladungs-/Audiometadaten entfernen oder
   minimieren, soweit sie nicht für aktive Serien/noch laufende Arbeit nötig
   sind. Für Idempotenz nötige kleine Tombstones können bleiben. Historische
   Deduplizierung darf nicht durch Löschung einen neuen Botstart ermöglichen.

Prüfe Einladung→Meet-Auftrag→Audio→Export→lokaler SMTP-Empfang; separates
Resultat bei reiner Stille, null PCM, Zuordnungsfehler und ASR-Ausfall;
großer Export; Leser-Credential ohne Steuerungsrechte; Retention mit aktiver
Serie und altem abgeschlossenem Termin. Keine echten Empfänger ungefragt
anschreiben; bestehendes Testpostfach/Test-SMTP verwenden.
```

## Prompt 7 — Kubernetes-Startfehler reparieren, aktive Meetings erhalten

**Ergebnis:** Ein fehlgeschlagener Start bleibt nicht dauerhaft festgesetzt. Unklare alte Teilnehmer werden trotzdem nicht dupliziert.

```text
Behebe F06 im bestehenden Controller. Erhalte den exklusiven Anspruch je
Vorkommen, deterministische Jobnamen und backoffLimit=0.

1. Unterscheide vor Providerbeitritt: Startabsicht gespeichert, Create
   definitiv abgelehnt, Create-Antwort verloren, Job vorhanden, Worker hat
   Anspruch. Ein bestätigter 4xx-Validierungsfehler ist nicht derselbe Fall
   wie ein verschwundener bereits laufender Pod.

2. Für einen noch nicht beanspruchten Versuch einen fehlgeschlagenen Create
   mit derselben Attempt-/Jobidentität kontrolliert wiederholen bzw. einen
   definitiven Konfigurationsfehler terminal melden. Auch bei konkurrierenden
   oder verspäteten Starts darf nur ein Worker den Providerbeitritt erreichen.
   Nie neue Namen/Attempts erzeugen, um die vorhandene Sperre zu umgehen.

3. Nach beobachtetem Workeranspruch, Pod-/Job-Identität oder unklarem
   Prozessende bleibt Doppelbeitritt ausgeschlossen. Provider-Entfernung
   oder Ablehnung löst keinen Ersatzbeitritt aus. Bereits vorhandene
   bestätigte Prozessbeendigung und Secretbereinigung weiterverwenden.

4. Startabbrüche vor Jobanlage und verwaiste attemptbezogene Secrets
   sauber abräumen, ohne Secrets eines laufenden oder ungeklärten Workers
   zu entfernen. Ein einzelner defekter Auftrag darf die übrige Scheduler-
   Schleife nicht dauerhaft blockieren. Fehler mit Attempt-ID und sicherem
   Grund statt nur Exceptionklasse sichtbar machen.

5. Laufende Meet- und Webex-Jobs überstehen den Neustart des Meeting-Dienstes.
   Sie erhalten beim Release kein neues Browserprofil und keinen neuen
   Providerbeitritt. Providerbezogene Deadline, Lobby und Abbruch beibehalten.

Prüfe am bestehenden echten Cluster-Testpfad: Create definitiv abgelehnt;
Create erfolgreich, Antwort verloren; Controllerabsturz direkt vor/nach
Create; konkurrierende Jobs mit identischem Versuch; Worker vor Bootstrap
gescheitert; SIGTERM; unklar verschwundener alter Pod. Am Ergebnis zeigen:
höchstens ein Providerbeitritt je beanspruchtem Versuch und kein dauerhaft
unknown bei einem nachweislich nie gestarteten, reparierbaren Create.
Keine CRDs, Operatoren, neuen Lease-Dienste oder Clusteränderungen.
```

## Prompt 8 — Webex kompatibel mitziehen

**Ergebnis:** Die gemeinsame Verbesserung beschädigt Webex nicht; seine offene Teilnehmerbindung bleibt als konkrete Integrationsaufgabe sichtbar.

```text
Übertrage die gemeinsamen Capture-/Bindungs-/Transport-/Lifecyclekorrekturen
auf den vorhandenen Webex-Zweig, ohne den Meet-Betrieb davon abhängig zu machen.

1. Bestehende Service-App-Gastverwaltung, Refresh und SDK-Join erhalten.
   Providerneutralen Code aus dem alten page.ts mit Meet teilen; nur die
   Webex-Ereignisse und SDK-Zugriffe bleiben Webex-spezifisch.

2. Die tatsächlich gesperrten SDK-Versionen und deren RemoteMedia-/Receiver-
   Zuordnung verwenden. Keine Annahme CSI=SSRC=CSRC allein aufgrund gleicher
   Zahlenwerte. Teilnehmerdaten, Capturegrenze und Audioquelle verbinden.
   Soweit der in Prompt 3 implementierte Framepfad im Webex-Receiver nutzbar
   ist, wiederverwenden. Sonst den kleinen benötigten Providerzweig ergänzen.

3. Aktives Polling dient Gesundheit/Diagnose; es definiert keine fünfsekündige
   Sprechergrenze. Quellwechsel und Trackersatz schließen die richtigen
   Abschnitte. Alle historischen Epochen bleiben abrufbar, ohne die alte
   64-Stream-Lebenszeitgrenze. Share-Audio bleibt eigene Quelle.

4. Webex ohne Zugang als not_configured/unverified ausweisen und nur dessen
   reale Prüfung offenlassen. Nicht capability_unsupported behaupten.
   Meet bleibt vollständig start- und betriebsfähig. Im README exakt eine
   kurze Anleitung für den späteren echten Webex-Test hinterlegen.

Prüfe bestehende Webex-Unit-/Browserfixturetests und neue gemeinsame
Regressionsfälle. Wenn reale Credentials vorhanden sind, denselben
Überlappungs-/Quellenwechseltest wie bei Meet durchführen. Ohne sie keine
Webex-Vollabnahme behaupten; alle verfügbaren Implementierungsarbeiten
trotzdem abschließen.
```

## Prompt 9 — Durchgängiger Betrieb und gezielte Abnahme

**Ergebnis:** Ein konkret benutzbarer Meet-Pfad mit gemessenen Grenzen und reproduzierbarem Start. Keine neue Testplattform.

```text
Führe die Integration im vorhandenen wortlaut-Entwicklungsnamespace durch.
Korrigiere dabei auftretende Fehler und beende die Arbeit erst mit dem
erreichbaren vollständigen Ergebnis. Keine zusätzlichen Funktionen anfangen.

1. make lint/make test, Worker-Build und betroffene PostgreSQL-/S3-Tests
   ausführen. Prüfe Migrationen mit bestehender Datenbank und echte binäre
   Audioübertragung. Übersprungene Integrationsprüfungen nicht als bestanden
   zählen. Einen kleinen CI-Workflow für portable Prüfungen ergänzen;
   optional konfigurierte DB-/S3-Jobs müssen ihre Voraussetzungen deutlich
   haben. Keine Produktivcredentials in PR-Workflows.

2. Ein reales Meet vollständig durchlaufen lassen:
   Interne wortlaut-API und eine echte bereinigte Google-Calendar-Einladung,
   Lobby, Zulassung,
   mehrere getrennte Sprecher, Überlappung, Slotwechsel, letzter Satz,
   geordnetes Ende, lokale Parakeet-Inferenz, TXT/VTT/JSON und Test-Mail.
   Die Teilnehmerbindung anhand getrennter Referenzen prüfen.

3. Im selben Ablauf die relevanten Ausfälle einmal gezielt auslösen:
   Meeting-Dienst-Neustart, kurzer GPU-Ausfall, Ingest-Reconnect und kontrollierter
   Workerstop. Bereits bestätigte Chunks/Segmente bleiben erhalten. Keine
   Doppelteilnahme, keine doppelten finalen Segmente, keine verborgenen Lücken.
   Gesunden zweiten Auftrag gleichzeitig gegen einen defekten Stream prüfen.

4. Eine längere Sitzung bzw. eine zeitgetreue Aufnahme mit zahlreichen
   Quellenwechseln durchlaufen lassen. Mehr als 64 Bindungswechsel abdecken.
   Für Kapazität die konfigurierte Parallelität von zwei Meetings prüfen,
   möglichst mit drei gelieferten aktiven Quellen je Meeting. Bei Zugang
   zu beiden Providern ausdrücklich ein Meet- und ein Webex-Meeting
   gleichzeitig in derselben Instanz betreiben: getrennte Credentials
   und Worker, gemeinsame Kapazitätsgrenze, Verarbeitung und Exporte.
   Fehlenden Providerzugang als offene Prüfung ausweisen. Die spätere
   Teams-Integration muss denselben Parallelbetrieb mit den bestehenden
   Providern erfüllen. Gemessene aktive Quellen nennen, nicht aus
   Teilnehmerzahl oder VRAM ableiten.
   Lastmessung darf ein aufgezeichnetes, korrekt gebundenes PCM-Replay nutzen;
   es ersetzt nicht den separaten realen Meet-Quellennachweis.

5. Berichte wenige aussagekräftige Werte:
   - falsche Teilnehmerbindungen und ungebundene Sprachdauer;
   - Quellenabdeckung und konkret beobachtete Providergrenze;
   - WER gegen die bekannten Sprecherreferenzen;
   - p50/p95/p99 für Sprachende→finales Segment und Inferenz, mit Anzahl
     beobachteter Segmente; bei kleiner Stichprobe als solche kennzeichnen;
   - verarbeitete Quellensekunden je Sekunde, ältester ASR-Rückstau;
   - Worker-RAM/CPU und offene Audio-Bytes bei Quellenwechsel/Ausfall;
   - EOS→fertiger Export sowie erhaltene/fehlende Audiozeit.
   Ergebnisse wirklich messen; keine Sollwerte als Benchmarks ausgeben.

6. README auf den tatsächlich benutzbaren Weg kürzen: Start, Meet-Konfiguration,
   Einladung/wortlaut-API-Beispiel, Statusliste, Ergebnisabruf, Fehlerbehebung und
   bekannte Grenzen. Externe Voraussetzungen konkret benennen. Historische
   Testberichte bei Bedarf in eine bestehende Dokumentationsdatei auslagern;
   keine umfangreiche neue Dokumentationsstruktur.

7. Zum Abschluss Änderungen und Prüfergebnis knapp zusammenfassen. Meet und
   Webex haben getrennte Zustände. Fehlender Webex-Zugang darf nicht das
   geprüfte Meet-Ergebnis verdecken. Bestehende Entwicklungsdienste weiterlaufen
   lassen; kein automatisches tilt down, Prune, Commit oder Push.
```

## 5. Fachliche Abschlusskriterien

| Bereich | Erfüllt, wenn … |
|---|---|
| Browser-only | Meet-Beitritt, Medienempfang und Teilnehmerbindung erfolgen im Playwright-/Chromium-Webclient; es gibt keine Meet-Media-/REST-/Calendar-API-Anbindung oder davon abhängige Konfiguration. |
| Parallele Provider | Meet und Webex laufen gleichzeitig in derselben Instanz mit getrennten Zugängen; Teams ist als weiterer Provider vorgesehen, ohne globale Providerumschaltung oder separate Infrastruktur. |
| Meet ohne Webex | Meet-Aufträge werden ohne Webex-App/-Token geplant und ausgeführt. |
| Sprecher | Zugeordnete PCM-/Textbereiche stammen aus getrennten Quellen und tragen die richtige technische Teilnehmersitzung; gleiche Namen verschmelzen nicht. |
| Wechsel/Überlappung | A/B-Überlappung bleibt getrennt, Slotwechsel mischen keine Bindungen; mehr als 64 Wechsel funktionieren. |
| Mediengrenze | Nicht gelieferte oder nicht bindbare Quellen werden als Einschränkung ausgewiesen; es gibt keine falsche Zusage vollständiger Aufnahme. |
| Haltbarkeit | ACK bestätigt S3 und DB; Replay verändert nichts, dupliziert nichts. |
| Ausfälle | Fehlende GPU blockiert Capture nicht sofort; ein defekter Stream blockiert keine gesunden Meetings; Puffer sind insgesamt begrenzt. |
| Ende | Letzte Restframes werden verarbeitet; fehlendes EOS/Drain wird sichtbar, statt ein normales vollständiges Ende vorzutäuschen. |
| Betrieb | Kalenderupdate/-absage, Controller-Neustart, Fehlerstart, Status und Ergebnisversand funktionieren im bestehenden Stack. |
| Webex | Vorhandener Pfad bleibt kompatibel; echte noch offene Providerprüfungen sind unabhängig vom Meet-Status benannt. |

**Kein Ersatz für die Sprecheranforderung:** „zwei Audiospuren“, „Namen meist richtig“, „Text aus Meet-Untertiteln“ oder ein synthetischer Test mit selbst vorgegebenen Sprecher-IDs.

## 6. Quellen und feste Anknüpfungspunkte

Abruf/Codeprüfung am 6. Oktober 2026. Repository-Links sind auf die geprüften Commits festgelegt. Aktuelle Dokumentation vor späterer Implementierung erneut prüfen, wenn sich der Integrationsvertrag geändert hat.

- **R1 – wortlaut:** [geprüfter Commit](https://github.com/mayflower/wortlaut/tree/63005fbd48728d37438d5ecbf795075b5659a4a0). Zentrale Dateien: [Worker-Seite](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/worker/src/page.ts), [Transport](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/worker/src/transport.ts), [Ingest](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/services/meeting/src/wortlaut/ingest.py), [Segmentierung](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/services/meeting/src/wortlaut/processing.py), [Controller](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/services/meeting/src/wortlaut/controller.py), [ASR](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/services/meeting/src/wortlaut/asr.py), [API](https://github.com/mayflower/wortlaut/blob/63005fbd48728d37438d5ecbf795075b5659a4a0/services/meeting/src/wortlaut/app.py).
- **V1 – Vexa Join:** [isoliertes Join-Modul](https://github.com/Vexa-ai/vexa/tree/18e7ac1d6a0201d1489ce30b12b6f7138067a598/core/meetings/modules/join), [package.json](https://github.com/Vexa-ai/vexa/blob/18e7ac1d6a0201d1489ce30b12b6f7138067a598/core/meetings/modules/join/package.json).
- **V2 – Vexa Meet-Capture:** [README](https://github.com/Vexa-ai/vexa/blob/18e7ac1d6a0201d1489ce30b12b6f7138067a598/core/meetings/modules/gmeet-capture/README.md), [Capture-Code](https://github.com/Vexa-ai/vexa/blob/18e7ac1d6a0201d1489ce30b12b6f7138067a598/core/meetings/modules/gmeet-capture/src/gmeet-capture.ts).
- **V3 – Vexa Sprecherbindung:** [GmeetChannelBinder](https://github.com/Vexa-ai/vexa/blob/18e7ac1d6a0201d1489ce30b12b6f7138067a598/core/meetings/modules/gmeet-capture/src/gmeet-channel-binder.ts). Energie-/Glow-Korrelation, keine direkte technische Teilnehmerbindung.
- **W1 – WebRTC-Quellenlisten:** [W3C WebRTC, RTCRtpReceiver](https://w3c.github.io/webrtc-pc/#dom-rtcrtpreceiver-getcontributingsources).
- **W2 – Framebezogene Metadaten:** [W3C WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/), insbesondere `RTCEncodedFrameMetadata` und `RTCEncodedAudioFrame`.
- **W3 – vorhandener Decoderpfad:** [W3C WebCodecs](https://www.w3.org/TR/webcodecs/), `AudioDecoder`/`AudioData`; tatsächliche Browser-/Codecunterstützung prüfen.
- **A1 – zusätzliche Gegenprobe:** [Attendee Meet-Payload](https://github.com/attendee-labs/attendee/blob/ce53d04ebe736bbcc57690c8355e61dbf30478ba/bots/google_meet_bot_adapter/google_meet_chromedriver_payload.js), [Lizenz](https://github.com/attendee-labs/attendee/blob/ce53d04ebe736bbcc57690c8355e61dbf30478ba/LICENSE). Keine Übernahme dieses Codes beauftragt.
