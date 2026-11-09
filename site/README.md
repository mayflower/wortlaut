# wortlaut.cloud — Statische Produkt- & Open-Source-Website

Dieses Verzeichnis enthält die statische, zweisprachige (**Deutsch / Englisch**) Produkt- und Open-Source-Website für **`wortlaut.cloud`**.

## Dateien

- [`index.html`](index.html) – Vollständige Landingpage im **Astryx Stone Editorial Design** mit Hero-Split-Stage (WebRTC-Einzelspur-Visualizer + UI-Vorschau), Architektur-Kontrast, interaktivem 6-Persona-Rundgang, 4-Provider-Matrix (Google Meet, Microsoft Teams, Cisco Webex, Zoom), Datenschutz-Sektion (`/privacy`), SVG-Systemarchitektur und Open-Source-Quickstart (`https://github.com/mayflower/wortlaut`, GNU AGPLv3).
- [`styles.css`](styles.css) – Design-Tokens (`--stone-*`, `--emerald-*`), Layout-Grids, responsive Breakpoints und Wellenform-Animationen.
- [`app.js`](app.js) – Zweisprachiges Wörterbuch (`DE` / `EN`, umschaltbar per Button, `localStorage` oder URL-Parameter `?lang=de|en`), interaktive Persona-Tabs, 1-Klick-Kalender-Toggle-Demo, Live-Transkript-Suchfilter und Copy-to-Clipboard für alle Installationsbefehle.
- [`favicon.svg`](favicon.svg) – `wortlaut` `AudioLines`-Signet.
- [`CNAME`](CNAME) – Custom-Domain-Konfiguration (`wortlaut.cloud`) für GitHub Pages.

## Lokale Vorschau

Da die Website ohne Build-Schritt auskommt, reicht jeder statische Webserver:

```bash
python3 -m http.server 8080 --directory site
# -> http://127.0.0.1:8080 (Deutsch)
# -> http://127.0.0.1:8080/?lang=en (Englisch)
```

## Hosting auf GitHub Pages (`wortlaut.cloud`)

Der Workflow [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) veröffentlicht das Verzeichnis `site/` bei jedem Push auf `main` automatisch auf GitHub Pages.

### Einmalige Einrichtung in GitHub & DNS

1. **In GitHub (`mayflower/wortlaut` → Settings → Pages)**:
   - Unter *Build and deployment → Source* die Option **GitHub Actions** auswählen.
   - Nach dem ersten Lauf von `pages.yml` **Enforce HTTPS** aktivieren.
2. **Beim DNS-Provider für `wortlaut.cloud`**:
   - **Apex-Domain (`wortlaut.cloud`)**: `A`-Records auf die GitHub-Pages-IPs setzen:
     - `185.199.108.153`
     - `185.199.109.153`
     - `185.199.110.153`
     - `185.199.111.153`
   - **Subdomain (`www.wortlaut.cloud`)**: `CNAME`-Record auf `mayflower.github.io.` setzen.
