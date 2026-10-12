# wortlaut

## Auftrag und Architektur

- `README.md` beschreibt Einrichtung, Betrieb und aktuelle Grenzen. Die folgenden Architekturvorgaben gelten für die Weiterentwicklung; arbeite am jeweils ausdrücklich beauftragten Umfang.
- Produktname: `wortlaut`. Webex und Google Meet werden parallel in derselben Instanz unterstützt; Microsoft Teams folgt als weiterer paralleler Provider. Provider je Aufnahme wählen, keine globale Providerumschaltung. Zugänge und Startvoraussetzungen je Provider getrennt prüfen, Infrastruktur und Kapazitätsgrenzen gemeinsam nutzen. Meet verwendet ausschließlich Playwright/Chromium und direkte WebRTC-Erfassung im Webclient; keine Google-Media-, Meet-REST- oder Calendar-API. Getrennte empfangene Audioquellen vor dem Mix erfassen; ASR pro Quelle. Keine Diarisierung, Voiceprints, Active-Speaker-Namensheuristiken oder gemischtes Audio als Ersatz.
- Meeting-Dienst: Python/FastAPI, PostgreSQL, API, Scheduler, Kubernetes-Reconciliation, Ingest, Exporte und Mail in einem Prozess. GPU-Dienst: ein gemeinsam geladenes lokales Parakeet-Modell. Worker: TypeScript/Playwright/Chromium, kurzlebiger Kubernetes-Job, eigene HTTPS-SDK-Seite.
- Sprecheridentität ist die nachgewiesene Provider-Teilnehmersitzung. Stabile anonyme Quellenlabels allein erfüllen die Anforderung nicht; fehlende Anzeigenamen sind bei erhaltener Teilnehmerbindung zulässig. Quellenbindung und Teilnehmermetadaten erhalten; Meet und Webex getrennt bewerten, keine Providerabnahme ohne echte Nachweise behaupten. Fehlender Providerzugang bedeutet ungeprüft, nicht capability_unsupported; SDK-Ereignisse und zugänglichen WebRTC-Pfad untersuchen. Webex-Zugang darf Meet nicht blockieren.

## Entwicklung

- Beginne mit `make setup`. Normaler Entwicklungsstart: `make dev`. Tilt läuft lokal, Images werden mit Kubernetes-BuildKit für `linux/amd64` gebaut, Anwendungen laufen im Context `data`.
- Namespace: `wortlaut-$(id -un)`. Default-Kubeconfig-Quelle: `~/.kube/data-lan-mayflower`; `make setup` erzeugt die ignorierte projektlokale `.dev/kubeconfig` mit Context `data`. Niemals den globalen Context ändern.
- Tilt: `127.0.0.1:34604`; Meeting-API: `127.0.0.1:34601`; PostgreSQL: `127.0.0.1:34632`. Vor Steuerung einer Tilt-Instanz deren Tiltfile-Pfad prüfen. Keine fremden Instanzen oder Namespaces steuern.
- Kubernetes-Aufrufe immer mit explizitem Kubeconfig, `--context data` und projektspezifischem Namespace. Keine Cluster-Operatoren, CRDs, GPU-Treiber oder gemeinsame Infrastruktur installieren oder verändern.
- Zugangsdaten ausschließlich in ignorierten lokalen Dateien und Kubernetes-Secrets. Keine Tokenwerte in Logs, URLs, Images oder ConfigMaps. Fehlende Providerzugänge als konkrete offene Prüfung melden; keine Erfolgssimulation.

## Arbeitsregeln

- Vorhandene Bibliotheken und Infrastruktur verwenden, kleinste passende Änderung. Keine zusätzlichen Frameworks, Dienste pro Modul, Queue-Systeme, UI oder speculative Skalierung.
- Unabhängige Änderungen erhalten. Selbst verursachte Ausführungsfehler untersuchen, korrigieren und den autorisierten Auftrag fortsetzen.
- `make test` und `make lint` für betroffene Implementierung verwenden. Tests schützen Verhalten und tatsächliche Fehlerpfade. PostgreSQL-/S3-Semantik durch echte Integrationsgrenzen prüfen; Quelltextassertionen und Mocks beweisen diese Semantik nicht.
- Echte Meet-/Webex-Tests jeweils getrennt von synthetischen Audio-/Lifecycle-Tests berichten. Teilnahme und verständliches Mixaudio allein erfüllen die Sprecheranforderung nicht.
- Entwicklungsumgebung nach normaler Arbeit laufen lassen. Kein automatisches `tilt down`, Prune oder Löschen persistierter Daten.
- Keine Subagenten ohne ausdrücklichen Nutzerauftrag. Keine Commits oder Pushes ohne entsprechenden Auftrag; bei einem Commit nur die vorgesehenen Dateien stagen und Conventional Commits verwenden.
