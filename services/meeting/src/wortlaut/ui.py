"""Self-contained operator and transcript web UI served directly by the meeting service."""

import hashlib
import html
import json
from functools import lru_cache
from pathlib import Path

from wortlaut.mail import FAILURE_REASONS
from wortlaut.settings import get_settings


@lru_cache(maxsize=1)
def _asset_version() -> str:
    digest = hashlib.sha256()
    found = False
    here = Path(__file__).resolve()
    candidates = [Path("/app/sdk/ui/app.js"), Path("/app/sdk/ui/app.css")]
    if len(here.parents) > 4:
        candidates.extend(
            [
                here.parents[4] / "worker/dist/ui/app.js",
                here.parents[4] / "worker/dist/ui/app.css",
            ]
        )
    for candidate in candidates:
        if candidate.is_file():
            digest.update(candidate.read_bytes())
            found = True
    return digest.hexdigest()[:12] if found else "1"


PRIVACY_HTML = """<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Datenschutz &amp; Transparenz – __ASSISTANT_NAME__</title>
  <link rel="stylesheet" href="/sdk/ui/app.css?v=__ASSET_VERSION__">
  <style>
    :root {
      --priv-bg: var(--color-background-body, #0f1014);
      --priv-surface: var(--color-background-surface, #181920);
      --priv-surface-hover: var(--color-background-muted, #23252f);
      --priv-border: var(--color-border, #2b2d38);
      --priv-text: var(--color-text-primary, #f2f3f8);
      --priv-muted: var(--color-text-secondary, #a2a6b8);
      --priv-emerald: #34d399;
      --priv-emerald-bg: rgba(16, 185, 129, 0.10);
      --priv-emerald-border: rgba(16, 185, 129, 0.28);
      --priv-amber: #fbbf24;
      --priv-amber-bg: rgba(245, 158, 11, 0.08);
      --priv-amber-border: rgba(245, 158, 11, 0.30);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100vh;
      background-color: var(--priv-bg);
      color: var(--priv-text);
      font-family: var(--font-family-body, system-ui, -apple-system, sans-serif);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .priv-container {
      max-width: 780px;
      margin: 0 auto;
      padding: 48px 24px 64px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .priv-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--priv-border);
      flex-wrap: wrap;
    }
    .priv-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      color: var(--priv-emerald);
      background: var(--priv-emerald-bg);
      border: 1px solid var(--priv-emerald-border);
      margin-bottom: 12px;
    }
    .priv-title {
      margin: 0;
      font-size: 24px;
      font-weight: 650;
      letter-spacing: -0.02em;
      line-height: 1.25;
      color: var(--priv-text);
    }
    .priv-subtitle {
      margin: 8px 0 0;
      font-size: 14px;
      color: var(--priv-muted);
    }
    .priv-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--priv-text);
      background: var(--priv-surface);
      border: 1px solid var(--priv-border);
      text-decoration: none;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .priv-btn:hover {
      background: var(--priv-surface-hover);
    }
    .priv-card {
      border-radius: 14px;
      border: 1px solid var(--priv-border);
      background: var(--priv-surface);
      padding: 24px;
    }
    .priv-card h2 {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 600;
      color: var(--priv-text);
    }
    .priv-card p {
      margin: 0;
      font-size: 14px;
      color: var(--priv-muted);
    }
    .priv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    @media (max-width: 640px) {
      .priv-grid { grid-template-columns: 1fr; }
    }
    .priv-card-sm {
      border-radius: 14px;
      border: 1px solid var(--priv-border);
      background: var(--priv-surface);
      padding: 20px;
    }
    .priv-card-sm h3 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 600;
      color: var(--priv-emerald);
    }
    .priv-card-sm p {
      margin: 0;
      font-size: 13px;
      color: var(--priv-muted);
    }
    .priv-list {
      margin: 0;
      padding-left: 20px;
      font-size: 14px;
      color: var(--priv-muted);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .priv-list strong, .priv-card p strong, .priv-callout p strong {
      color: var(--priv-text);
      font-weight: 600;
    }
    .priv-callout {
      border-radius: 14px;
      border: 1px solid var(--priv-amber-border);
      background: var(--priv-amber-bg);
      padding: 24px;
    }
    .priv-callout h2 {
      margin: 0 0 8px;
      font-size: 16px;
      font-weight: 600;
      color: var(--priv-amber);
    }
    .priv-callout p {
      margin: 0;
      font-size: 14px;
      color: var(--priv-muted);
    }
    .priv-callout a {
      color: var(--priv-amber);
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main class="priv-container">
    <header class="priv-header">
      <div style="flex: 1; min-width: 260px;">
        <div class="priv-badge">
          100 % Self-Hosted · Keine Cloud-Weitergabe
        </div>
        <h1 class="priv-title">
          Datenschutz- &amp; Transparenzhinweis (__ASSISTANT_NAME__)
        </h1>
        <p class="priv-subtitle">
          Informationen zur automatisierten Meeting-Protokollierung für Teilnehmende in
          Google Meet, Microsoft Teams, Zoom und Cisco Webex.
        </p>
      </div>
      <a href="/ui" class="priv-btn">
        Zur Web-UI →
      </a>
    </header>

    <section class="priv-card">
      <h2>
        1. Warum nimmt __ASSISTANT_NAME__ an diesem Meeting teil?
      </h2>
      <p>
        Der Bot <strong>__ASSISTANT_NAME__</strong> wurde von einer am Meeting teilnehmenden
        Person gezielt eingeladen, um ein schriftliches Wortprotokoll (Transkript) der
        Besprechung zu erstellen. Beim Beitritt stellt sich der Bot im Meeting-Chat vor,
        nennt die einladende Person und verlinkt das Protokoll sowie diesen Datenschutzhinweis.
      </p>
    </section>

    <section class="priv-grid">
      <div class="priv-card-sm">
        <h3>Keine externen KI-/Cloud-Dienste</h3>
        <p>
          Audioerfassung und Spracherkennung laufen ausschließlich innerhalb des eigenen
          Mayflower-Kubernetes-Clusters auf dedizierter GPU-Infrastruktur. Es werden keine
          Audio- oder Textdaten an externe Cloud-Anbieter übertragen.
        </p>
      </div>
      <div class="priv-card-sm">
        <h3>Keine Stimmprofile &amp; kein Video</h3>
        <p>
          Es werden weder Kamerabilder noch Bildschirminhalte aufgezeichnet. Die
          Sprecherzuordnung erfolgt ausschließlich über die technische
          Konferenz-Teilnehmersitzung (WebRTC), niemals über biometrische Stimmprofile
          (Voiceprints).
        </p>
      </div>
    </section>

    <section class="priv-card">
      <h2>
        2. Zugriffsschutz &amp; automatische Löschfristen
      </h2>
      <ul class="priv-list">
        <li>
          <strong>Zugriff auf Protokolle:</strong> Standardmäßig haben nur die einladende Person
          und bestätigte Kalendergäste nach Authentifizierung Zugriff auf das Protokoll (sowie
          Personen, denen explizit ein schreibgeschützter Lese-Link geteilt wurde).
        </li>
        <li>
          <strong>Roh-Audiodaten:</strong> Temporäre Audiospuren dienen ausschließlich der
          asynchronen Spracherkennung und werden automatisch nach
          <strong>__AUDIO_HOURS__ Stunden</strong> gelöscht.
        </li>
        <li>
          <strong>Transkripte &amp; Exporte:</strong> Fertige Wortprotokolle werden automatisch
          nach <strong>__TRANSCRIPT_DAYS__ Tagen</strong> gelöscht und können in der Web-UI
          jederzeit sofort gelöscht werden.
        </li>
      </ul>
    </section>

    <section class="priv-callout">
      <h2>
        3. Widerspruch &amp; Beenden der Aufzeichnung
      </h2>
      <p>
        Wenn Sie keine Protokollierung wünschen, können Sie der Aufzeichnung jederzeit
        widersprechen: Der Bot <strong>__ASSISTANT_NAME__</strong> kann direkt über die
        Teilnehmerliste von Google Meet, Microsoft Teams, Zoom oder Cisco Webex aus dem Raum
        entfernt oder durch die einladende Person in der
        <a href="/ui">wortlaut Web-UI</a>
        gestoppt und gelöscht werden.
      </p>
    </section>
  </main>
</body>
</html>
"""

UI_HTML = """<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut – Meeting-Transkription</title>
  <link rel="stylesheet" href="/sdk/ui/app.css?v=__ASSET_VERSION__">
</head>
<body
  class="bg-[var(--color-background-body,#101018)]
         text-[var(--color-text-primary,#f0f0f9)] antialiased"
>
  <div id="root">
    <!-- Bot in ein Meeting schicken · title-search · participation-filter -->
    <!-- rejoin-rec-btn · copy-transcript-btn -->
  </div>
  <script>
    window.__WORTLAUT_BOOT__ = __BOOT_PAYLOAD_JSON__;
  </script>
  <script type="module" src="/sdk/ui/app.js?v=__ASSET_VERSION__"></script>
</body>
</html>
"""


def _build_instance_info() -> dict:
    try:
        s = get_settings()
    except Exception:
        return {
            "assistantName": "wortlaut",
            "botEmail": None,
            "providers": {
                "google_meet": True,
                "google_meet_auth_session": False,
                "teams": True,
                "webex": False,
                "zoom": False,
            },
            "mail": {
                "imapEnabled": False,
                "smtpEnabled": False,
                "senderAuth": "gateway",
                "allowedDomains": [],
            },
            "limits": {
                "maxActiveMeetings": 15,
                "lobbyTimeoutSeconds": 600,
                "emptyRoomTimeoutSeconds": 300,
            },
            "retention": {
                "audioHours": 24,
                "transcriptDays": 30,
            },
            "oidc": {
                "enabled": False,
                "issuer": "",
                "clientId": "wortlaut",
                "allowedDomains": [],
            },
            "calendarOAuth": {
                "googleEnabled": False,
                "microsoftEnabled": False,
                "googleClientId": "",
                "microsoftClientId": "",
                "microsoftTenantId": "common",
            },
            "privacyUrl": "/privacy",
        }

    bot_email: str | None = None
    if s.smtp_from and s.smtp_from != "wortlaut@localhost":
        bot_email = s.smtp_from
    elif s.imap_username and "@" in s.imap_username:
        bot_email = s.imap_username

    return {
        "assistantName": s.assistant_name or "wortlaut",
        "botEmail": bot_email,
        "providers": {
            "google_meet": bool(s.enable_google_meet),
            "google_meet_auth_session": bool(s.meet_storage_state_secret),
            "teams": bool(s.enable_teams),
            "webex": bool(s.webex_service_token) or bool(s.enable_webex_browser),
            "zoom": bool(s.enable_zoom),
            "zoom_auth_session": bool(s.zoom_storage_state_secret),
        },
        "mail": {
            "imapEnabled": bool(s.enable_imap),
            "smtpEnabled": bool(s.enable_smtp),
            "senderAuth": s.mail_sender_auth,
            "allowedDomains": list(s.mail_allowed_sender_domains or []),
        },
        "limits": {
            "maxActiveMeetings": s.max_active_meetings,
            "lobbyTimeoutSeconds": s.lobby_timeout_seconds,
            "emptyRoomTimeoutSeconds": s.empty_room_timeout_seconds,
        },
        "retention": {
            "audioHours": s.audio_retention_hours,
            "transcriptDays": s.transcript_retention_days,
        },
        "oidc": {
            "enabled": bool(s.oidc_issuer),
            "issuer": s.oidc_issuer,
            "clientId": s.oidc_client_id,
            "allowedDomains": list(s.oidc_allowed_domains or []),
        },
        "calendarOAuth": {
            "googleEnabled": bool(
                s.google_calendar_client_id and s.google_calendar_client_secret
            ),
            "microsoftEnabled": bool(s.microsoft_calendar_client_id),
            "googleClientId": s.google_calendar_client_id or "",
            "microsoftClientId": s.microsoft_calendar_client_id or "",
            "microsoftTenantId": s.microsoft_calendar_tenant_id or "common",
        },
        "privacyUrl": s.privacy_url or "/privacy",
        "llmSummaryEnabled": bool(s.enable_llm_summary and s.ollama_url),
        "llmModel": s.ollama_model if s.enable_llm_summary else "",
    }


def render_ui() -> str:
    payload = {
        "failureReasons": FAILURE_REASONS,
        "instance": _build_instance_info(),
    }
    return (
        UI_HTML.replace("__BOOT_PAYLOAD_JSON__", json.dumps(payload, ensure_ascii=False))
        .replace("__ASSET_VERSION__", _asset_version())
    )


def render_privacy() -> str:
    try:
        s = get_settings()
        assistant_name = s.assistant_name or "wortlaut"
        audio_hours = s.audio_retention_hours
        transcript_days = s.transcript_retention_days
    except Exception:
        assistant_name = "wortlaut"
        audio_hours = 24
        transcript_days = 30
    return (
        PRIVACY_HTML.replace("__ASSISTANT_NAME__", html.escape(assistant_name))
        .replace("__AUDIO_HOURS__", str(audio_hours))
        .replace("__TRANSCRIPT_DAYS__", str(transcript_days))
        .replace("__ASSET_VERSION__", _asset_version())
    )

