"""Self-contained operator and transcript web UI served directly by the meeting service."""

import hashlib
import html
import json
from email.utils import parseaddr
from functools import lru_cache
from pathlib import Path

from wortlaut.languages import QWEN_ASR_LANGUAGES, effective_recording_language
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


FAVICON_DATA_URI = (
    "data:image/svg+xml,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    "%3Crect width='32' height='32' rx='8' fill='%23111113' "
    "stroke='%23059669' stroke-width='1.5'/%3E"
    "%3Cg stroke='%2334d399' stroke-width='2.4' stroke-linecap='round'%3E"
    "%3Cline x1='9' y1='13' x2='9' y2='19'/%3E"
    "%3Cline x1='13.6' y1='8.5' x2='13.6' y2='23.5'/%3E"
    "%3Cline x1='18.4' y1='11.5' x2='18.4' y2='20.5'/%3E"
    "%3Cline x1='23' y1='9.5' x2='23' y2='22.5'/%3E"
    "%3C/g%3E%3C/svg%3E"
)

_PRIVACY_STYLE_BLOCK = """  <style>
    :root {
      color-scheme: light dark;
      --priv-bg: light-dark(#fafaf9, #111113);
      --priv-surface: light-dark(#ffffff, #18181b);
      --priv-muted-bg: light-dark(#f5f5f4, #222226);
      --priv-border: light-dark(#e7e5e4, #27272a);
      --priv-text: light-dark(#1c1917, #fafaf9);
      --priv-muted: light-dark(#57534e, #a8a29e);
      --priv-emerald: light-dark(#047857, #34d399);
      --priv-emerald-bg: light-dark(rgba(5, 150, 105, 0.09), rgba(16, 185, 129, 0.12));
      --priv-emerald-border: light-dark(rgba(5, 150, 105, 0.28), rgba(16, 185, 129, 0.32));
      --priv-amber: light-dark(#92400e, #fbbf24);
      --priv-amber-bg: light-dark(#fffbeb, rgba(245, 158, 11, 0.09));
      --priv-amber-border: light-dark(#fde68a, rgba(245, 158, 11, 0.34));
    }
    html[data-theme="light"] { color-scheme: light; }
    html[data-theme="dark"] { color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100vh;
      background-color: var(--priv-bg);
      color: var(--priv-text);
      font-family: var(--font-family-body, system-ui, -apple-system, sans-serif);
      line-height: 1.62;
      -webkit-font-smoothing: antialiased;
    }
    .priv-topbar {
      border-bottom: 1px solid var(--priv-border);
      background: var(--priv-bg);
    }
    .priv-topbar-inner {
      max-width: 820px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .priv-brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--priv-text);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .priv-mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--priv-emerald-bg);
      border: 1px solid var(--priv-emerald-border);
      color: var(--priv-emerald);
      flex-shrink: 0;
    }
    .priv-pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--priv-emerald);
      background: var(--priv-emerald-bg);
      border: 1px solid var(--priv-emerald-border);
    }
    .priv-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 13px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      color: var(--priv-text);
      background: var(--priv-surface);
      border: 1px solid var(--priv-border);
      text-decoration: none;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .priv-btn:hover {
      background: var(--priv-muted-bg);
    }
    .priv-container {
      max-width: 820px;
      margin: 0 auto;
      padding: 36px 24px 64px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }
    .priv-hero {
      padding-bottom: 24px;
      border-bottom: 1px solid var(--priv-border);
    }
    .priv-title {
      margin: 0;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.22;
      color: var(--priv-text);
      text-wrap: balance;
    }
    .priv-subtitle {
      margin: 10px 0 0;
      font-size: 14.5px;
      color: var(--priv-muted);
      max-width: 68ch;
    }
    .priv-section {
      padding-bottom: 26px;
      border-bottom: 1px solid var(--priv-border);
    }
    .priv-section h2 {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 650;
      letter-spacing: -0.01em;
      color: var(--priv-text);
    }
    .priv-section p {
      margin: 0;
      font-size: 14px;
      color: var(--priv-muted);
      max-width: 72ch;
    }
    .priv-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      padding-bottom: 26px;
      border-bottom: 1px solid var(--priv-border);
    }
    @media (max-width: 640px) {
      .priv-grid { grid-template-columns: 1fr; }
    }
    .priv-card-sm {
      border-radius: 12px;
      border: 1px solid var(--priv-border);
      background: var(--priv-surface);
      padding: 20px;
    }
    .priv-card-sm h3 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 650;
      color: var(--priv-text);
    }
    .priv-card-sm p {
      margin: 0;
      font-size: 13.5px;
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
      max-width: 72ch;
    }
    .priv-list strong, .priv-section p strong, .priv-callout p strong {
      color: var(--priv-text);
      font-weight: 600;
    }
    .priv-kbd {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 6px;
      font-family: 'Liberation Mono', 'DejaVu Sans Mono', ui-monospace, monospace;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--priv-text);
      background: var(--priv-muted-bg);
      border: 1px solid var(--priv-border);
    }
    .priv-callout {
      border-radius: 12px;
      border: 1px solid var(--priv-amber-border);
      background: var(--priv-amber-bg);
      padding: 22px 24px;
    }
    .priv-callout h2 {
      margin: 0 0 10px;
      font-size: 16px;
      font-weight: 650;
      color: var(--priv-amber);
    }
    .priv-callout p {
      margin: 0;
      font-size: 14px;
      color: var(--priv-muted);
      max-width: 72ch;
    }
    .priv-callout a {
      color: var(--priv-amber);
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }
  </style>
  <script>
    (function () {
      try {
        var m = localStorage.getItem('wortlaut-theme-mode');
        var sys = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var dark = m === 'dark' || (m !== 'light' && sys);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      } catch (e) {}
    })();
  </script>"""

_BRAND_MARK_SVG = (
    '<span class="priv-mark" aria-hidden="true">'
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    'stroke-width="2.2" stroke-linecap="round">'
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/>'
    '<path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'
    "</svg></span>"
)

PRIVACY_HTML = (
    """<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Datenschutz &amp; Transparenz – __ASSISTANT_NAME__</title>
  <link rel="icon" type="image/svg+xml" href="__FAVICON_DATA_URI__">
  <link rel="stylesheet" href="/sdk/ui/app.css?v=__ASSET_VERSION__">
"""
    + _PRIVACY_STYLE_BLOCK
    + """
</head>
<body>
  <nav class="priv-topbar" aria-label="Wortlaut">
    <div class="priv-topbar-inner">
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <a href="/ui" class="priv-brand">"""
    + _BRAND_MARK_SVG
    + """<span>Wortlaut.cloud</span></a>
        <span class="priv-pill">__AI_PILL_DE__</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <a href="/privacy?lang=en" class="priv-btn">EN</a>
        <a href="/ui" class="priv-btn">Zur Web-UI →</a>
      </div>
    </div>
  </nav>

  <main class="priv-container">
    <header class="priv-hero">
      <h1 class="priv-title">
        Datenschutz- &amp; Transparenzhinweis (__ASSISTANT_NAME__)
      </h1>
      <p class="priv-subtitle">
        Informationen zur automatisierten Meeting-Protokollierung für Teilnehmende in
        Google Meet, Microsoft Teams, Zoom und Cisco Webex.
      </p>
    </header>

    <section class="priv-section">
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
        <h3>__AI_CARD_TITLE_DE__</h3>
        <p>
          __AI_CARD_BODY_DE__
        </p>
      </div>
      <div class="priv-card-sm">
        <h3>__VIDEO_CARD_TITLE_DE__</h3>
        <p>
          __VIDEO_CARD_BODY_DE__
        </p>
      </div>
    </section>

    <section class="priv-section">
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
          __TRANSCRIPT_RETENTION_ITEM_DE__
        </li>
      </ul>
    </section>

    <section class="priv-callout">
      <h2>
        3. Individueller Chat-Opt-out &amp; Beenden der Aufzeichnung
      </h2>
      <p>
        <strong>Eigene Aussagen von der Protokollierung ausschließen (Chat-Opt-out):</strong>
        Schreiben Sie während des laufenden Calls einfach <kbd class="priv-kbd">„no“</kbd> oder
        <kbd class="priv-kbd">„opt out“</kbd> in den Meeting-Chat. __OPTOUT_EFFECT_DE__<br><br>
        <strong>Off-the-Record-Pause im Chat:</strong>
        Mit <kbd class="priv-kbd">„#pause“</kbd> im Konferenz-Chat pausieren Sie die Audio- und
        Bildschirmerfassung sofort (Anzeige „OFF THE RECORD“ auf der Videokachel; verworfene Daten
        werden nicht gespeichert), bis <kbd class="priv-kbd">„#resume“</kbd> oder
        <kbd class="priv-kbd">„#weiter“</kbd> geschrieben wird.<br><br>
        <strong>Gesamte Aufzeichnung beenden:</strong> Der Bot <strong>__ASSISTANT_NAME__</strong>
        kann jederzeit direkt über die Teilnehmerliste von Google Meet, Microsoft Teams, Zoom
        oder Cisco Webex aus dem Raum entfernt oder durch die einladende Person in der
        <a href="/ui">wortlaut Web-UI</a> gestoppt und gelöscht werden.
      </p>
    </section>
  </main>
</body>
</html>
"""
)

UI_HTML = """<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wortlaut.cloud – Meeting-Transkription</title>
  <link rel="icon" type="image/svg+xml" href="__FAVICON_DATA_URI__">
  <link rel="stylesheet" href="/sdk/ui/app.css?v=__ASSET_VERSION__">
</head>
<body
  class="bg-[var(--color-background-body,#111113)]
         text-[var(--color-text-primary,#fafaf9)] antialiased"
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
            "defaultLocale": "de",
            "botEmail": None,
            "providers": {
                "google_meet": True,
                "google_meet_auth_session": False,
                "teams": True,
                "webex": True,
                "zoom": True,
                "zoom_auth_session": False,
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
            "enable_keyframes": True,
            "llmSummaryEnabled": False,
            "llmModel": "",
            "asrLanguages": list(QWEN_ASR_LANGUAGES),
            "defaultAsrLanguage": "auto",
        }

    bot_email: str | None = None
    if s.smtp_from and s.smtp_from != "wortlaut@localhost":
        bot_email = parseaddr(s.smtp_from)[1] or s.smtp_from
    elif s.imap_username and "@" in s.imap_username:
        bot_email = s.imap_username

    return {
        "assistantName": s.assistant_name or "wortlaut",
        "defaultLocale": s.default_locale,
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
            "authorizationEndpoint": s.oidc_authorization_endpoint or "",
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
        "enable_keyframes": bool(s.enable_keyframes),
        "llmSummaryEnabled": s.llm_summary_configured(),
        "llmModel": s.active_llm_model() if s.llm_summary_configured() else "",
        "asrLanguages": list(QWEN_ASR_LANGUAGES),
        "defaultAsrLanguage": effective_recording_language(None, s),
    }


def _safe_script_json(payload: object) -> str:
    """Serialize JSON safely for inline <script> injection (prevents </script> XSS)."""
    raw = json.dumps(payload, ensure_ascii=False)
    return (
        raw.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def render_ui() -> str:
    payload = {
        "failureReasons": FAILURE_REASONS,
        "instance": _build_instance_info(),
    }
    return (
        UI_HTML.replace("__BOOT_PAYLOAD_JSON__", _safe_script_json(payload))
        .replace("__FAVICON_DATA_URI__", FAVICON_DATA_URI)
        .replace("__ASSET_VERSION__", _asset_version())
    )


PRIVACY_HTML_EN = (
    """<!DOCTYPE html>
<html lang="en" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy &amp; Transparency Notice – __ASSISTANT_NAME__</title>
  <link rel="icon" type="image/svg+xml" href="__FAVICON_DATA_URI__">
  <link rel="stylesheet" href="/sdk/ui/app.css?v=__ASSET_VERSION__">
"""
    + _PRIVACY_STYLE_BLOCK
    + """
</head>
<body>
  <nav class="priv-topbar" aria-label="Wortlaut">
    <div class="priv-topbar-inner">
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <a href="/ui" class="priv-brand">"""
    + _BRAND_MARK_SVG
    + """<span>Wortlaut.cloud</span></a>
        <span class="priv-pill">__AI_PILL_EN__</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <a href="/privacy?lang=de" class="priv-btn">DE</a>
        <a href="/ui" class="priv-btn">Open Web-UI →</a>
      </div>
    </div>
  </nav>

  <main class="priv-container">
    <header class="priv-hero">
      <h1 class="priv-title">Privacy &amp; Transparency Notice (__ASSISTANT_NAME__)</h1>
      <p class="priv-subtitle">
        Participant information on automated meeting transcription in Google Meet,
        Microsoft Teams, Zoom, and Cisco Webex.
      </p>
    </header>
    <section class="priv-section">
      <h2>1. Why is __ASSISTANT_NAME__ joining this meeting?</h2>
      <p>
        The assistant <strong>__ASSISTANT_NAME__</strong> was invited by a meeting participant
        to create a speaker-attributed written transcript of this session. Upon joining, it
        announces itself in the meeting chat, names the inviter, and shares a direct link to the
        transcript and this privacy notice.
      </p>
    </section>
    <section class="priv-grid">
      <div class="priv-card-sm">
        <h3>__AI_CARD_TITLE_EN__</h3>
        <p>
          __AI_CARD_BODY_EN__
        </p>
      </div>
      <div class="priv-card-sm">
        <h3>__VIDEO_CARD_TITLE_EN__</h3>
        <p>
          __VIDEO_CARD_BODY_EN__
        </p>
      </div>
    </section>
    <section class="priv-section">
      <h2>2. Access Control &amp; Automatic Retention</h2>
      <ul class="priv-list">
        <li>
          <strong>Access:</strong> By default, only the inviting user and confirmed calendar guests
          (plus holders of an explicit read-only share link) can view the transcript.
        </li>
        <li>
          <strong>Raw Audio:</strong> Temporary per-speaker PCM segments are used strictly for
          asynchronous transcription and deleted automatically after
          <strong>__AUDIO_HOURS__ hours</strong>.
        </li>
        <li>
          __TRANSCRIPT_RETENTION_ITEM_EN__
        </li>
      </ul>
    </section>
    <section class="priv-callout">
      <h2>3. Individual In-Call Chat Opt-Out &amp; Stopping Recording</h2>
      <p>
        <strong>Exclude only your own statements (Chat Opt-Out):</strong>
        Simply type <kbd class="priv-kbd">"no"</kbd> or <kbd class="priv-kbd">"opt out"</kbd> in
        the meeting chat at any point during the call.
        __OPTOUT_EFFECT_EN__<br><br>
        <strong>Off-the-record pause:</strong>
        Type <kbd class="priv-kbd">"#pause"</kbd> in the meeting chat to immediately pause audio
        and screen capture (the bot's video tile switches to "OFF THE RECORD" and drops media in
        memory) until <kbd class="priv-kbd">"#resume"</kbd> is sent.<br><br>
        <strong>Stop the entire recording:</strong> Remove <strong>__ASSISTANT_NAME__</strong> from
        the call roster or cancel/delete the recording in the <a href="/ui">wortlaut Web-UI</a>.
      </p>
    </section>
  </main>
</body>
</html>
"""
)


def render_privacy(lang: str | None = None) -> str:
    try:
        s = get_settings()
        assistant_name = s.assistant_name or "wortlaut"
        audio_hours = s.audio_retention_hours
        transcript_days = s.transcript_retention_days
        enable_keyframes = bool(s.enable_keyframes)
        openai_configured = s.openai_chat_configured()
        llm_summary_on = bool(s.enable_llm_summary)
        effective_lang = (lang or s.default_locale or "de").strip().lower()
    except Exception:
        assistant_name = "wortlaut"
        audio_hours = 24
        transcript_days = 30
        enable_keyframes = True
        openai_configured = False
        llm_summary_on = False
        effective_lang = (lang or "de").strip().lower()
    if not openai_configured:
        ai_pill_de = "100 % Self-Hosted · Keine Cloud-Weitergabe"
        ai_card_title_de = "Keine externen KI-/Cloud-Dienste"
        ai_card_body_de = (
            "Audioerfassung und Spracherkennung laufen ausschließlich innerhalb der eigenen, "
            "selbstbetriebenen Infrastruktur auf dedizierter Hardware. Es werden keine "
            "Audio- oder Textdaten an externe Cloud-Anbieter übertragen."
        )
        ai_pill_en = "100% Self-Hosted · Zero External Cloud Transfer"
        ai_card_title_en = "No External Cloud AI"
        ai_card_body_en = (
            "Audio capture and speech-to-text run exclusively on self-hosted infrastructure "
            "using a local Qwen3-ASR model. Zero audio or transcript data is sent to "
            "third-party clouds."
        )
    elif not llm_summary_on:
        ai_pill_de = "Self-Hosted Spracherkennung · Externe Suchbegriff-Erweiterung"
        ai_card_title_de = "Lokale Spracherkennung &amp; begrenzte Such-KI"
        ai_card_body_de = (
            "Audioerfassung, Spracherkennung (Qwen3-ASR) und Protokollspeicherung laufen "
            "vollständig auf selbstbetriebener Infrastruktur. Für die MCP-Protokollsuche wird "
            "nur die kurze Suchanfrage (samt freigegebenen Glossarbegriffen, ohne Audiodaten "
            "oder Protokolltexte) an den konfigurierten OpenAI-kompatiblen Dienst gesendet."
        )
        ai_pill_en = "Self-Hosted ASR · External Search Term Expansion"
        ai_card_title_en = "Self-Hosted Speech-to-Text &amp; Query-Only Search AI"
        ai_card_body_en = (
            "Audio capture, speech-to-text (Qwen3-ASR), and transcript storage run on "
            "self-hosted infrastructure. Only short MCP search queries and active glossary terms "
            "(never audio or stored transcript passages) are sent to the configured "
            "OpenAI-compatible chat endpoint for synonym expansion."
        )
    else:
        ai_pill_de = "Self-Hosted Spracherkennung · Konfigurierter KI-Endpunkt aktiv"
        ai_card_title_de = "Lokale Spracherkennung &amp; konfigurierter KI-Endpunkt"
        ai_card_body_de = (
            "Audioerfassung und Spracherkennung (Qwen3-ASR) laufen auf selbstbetriebener "
            "Infrastruktur. Für Nachbereitungs-Zusammenfassungen, Folien-Textauszüge und "
            "MCP-Suchbegriffserweiterung überträgt die Instanz bereinigte Protokolltexte und "
            "beruhigte Folien-Standbilder (ausgenommen Opt-out-Personen und #pause-Abschnitte) "
            "an den vom Betreiber konfigurierten OpenAI-kompatiblen Dienst."
        )
        ai_pill_en = "Self-Hosted ASR · Configured External AI Endpoint"
        ai_card_title_en = "Self-Hosted Speech-to-Text &amp; Configured AI Endpoint"
        ai_card_body_en = (
            "Audio capture and speech-to-text (Qwen3-ASR) run on self-hosted infrastructure. "
            "Post-call protocol summaries, slide text extraction, and MCP search query expansion "
            "send curated transcript text and settled slide snapshots (excluding opted-out "
            "speakers and #pause intervals) to the operator-configured OpenAI-compatible endpoint."
        )
    escaped_name = html.escape(assistant_name)
    if enable_keyframes:
        video_title_de = "Keine Stimmprofile &amp; keine Kamerabilder"
        video_body_de = (
            "Es werden niemals Teilnehmer-Kamerabilder oder durchlaufendes Video aufgezeichnet; "
            "bei aktiver Bildschirmpräsentation erfasst der Bot ausschließlich einzelne, "
            "beruhigte Standbilder (Keyframes) geteilter Folien oder Diagramme. Die "
            "Sprecherzuordnung erfolgt ausschließlich über die technische "
            "Konferenz-Teilnehmersitzung (WebRTC), niemals über biometrische Stimmprofile "
            "(Voiceprints)."
        )
        retention_item_de = (
            "<strong>Transkripte, Bildschirm-Standbilder &amp; Exporte:</strong> Fertige "
            "Wortprotokolle sowie erfasste Bildschirm-Standbilder werden automatisch nach "
            f"<strong>{transcript_days} Tagen</strong> gelöscht und können in der Web-UI "
            "jederzeit einzeln oder vollständig sofort gelöscht werden."
        )
        optout_de = (
            f"{escaped_name} erkennt dies automatisch, verwirft Ihre Audiospur sowie etwaige "
            "Bildschirmfreigaben und löscht auch bereits während des Calls erfasste Redebeiträge "
            "und Bildschirm-Standbilder Ihrer Person vollständig aus dem Protokoll."
        )
        video_title_en = "No Voiceprints &amp; Zero Camera Video"
        video_body_en = (
            "Participant camera feeds and continuous video are never recorded; only settled "
            "static snapshots (keyframes) of active screen shares are captured to preserve slide "
            "and diagram context. Speaker attribution relies strictly on isolated WebRTC "
            "conference receiver tracks — never biometric voiceprints."
        )
        retention_item_en = (
            "<strong>Transcripts, Screen-Share Snapshots &amp; Exports:</strong> Completed "
            "transcripts and captured screen-share snapshots expire automatically after "
            f"<strong>{transcript_days} days</strong> and can be deleted individually or "
            "completely at any time."
        )
        optout_en = (
            f"{escaped_name} immediately discards your audio track and screen share and purges "
            "any statements and screen-share snapshots already captured from you while continuing "
            "the transcript for everyone else."
        )
    else:
        video_title_de = "Keine Stimmprofile &amp; kein Video"
        video_body_de = (
            "Es werden weder Kamerabilder noch Bildschirminhalte aufgezeichnet. Die "
            "Sprecherzuordnung erfolgt ausschließlich über die technische "
            "Konferenz-Teilnehmersitzung (WebRTC), niemals über biometrische Stimmprofile "
            "(Voiceprints)."
        )
        retention_item_de = (
            "<strong>Transkripte &amp; Exporte:</strong> Fertige Wortprotokolle werden automatisch "
            f"nach <strong>{transcript_days} Tagen</strong> gelöscht und können in der Web-UI "
            "jederzeit sofort gelöscht werden."
        )
        optout_de = (
            f"{escaped_name} erkennt dies automatisch, verwirft Ihre Audiospur und löscht auch "
            "bereits während des Calls erfasste Redebeiträge Ihrer Person vollständig aus dem "
            "Protokoll."
        )
        video_title_en = "No Voiceprints &amp; No Video"
        video_body_en = (
            "Neither camera video nor screen shares are recorded. Speaker attribution relies "
            "strictly on isolated WebRTC conference receiver tracks — never biometric voiceprints."
        )
        retention_item_en = (
            "<strong>Transcripts &amp; Exports:</strong> Completed transcripts expire "
            f"automatically after <strong>{transcript_days} days</strong> and can be deleted "
            "immediately at any time."
        )
        optout_en = (
            f"{escaped_name} immediately discards your audio track and purges any statements "
            "already captured from you while continuing the transcript for everyone else."
        )
    template = PRIVACY_HTML_EN if effective_lang.startswith("en") else PRIVACY_HTML
    return (
        template.replace("__AI_PILL_DE__", ai_pill_de)
        .replace("__AI_CARD_TITLE_DE__", ai_card_title_de)
        .replace("__AI_CARD_BODY_DE__", ai_card_body_de)
        .replace("__AI_PILL_EN__", ai_pill_en)
        .replace("__AI_CARD_TITLE_EN__", ai_card_title_en)
        .replace("__AI_CARD_BODY_EN__", ai_card_body_en)
        .replace("__VIDEO_CARD_TITLE_DE__", video_title_de)
        .replace("__VIDEO_CARD_BODY_DE__", video_body_de)
        .replace("__TRANSCRIPT_RETENTION_ITEM_DE__", retention_item_de)
        .replace("__OPTOUT_EFFECT_DE__", optout_de)
        .replace("__VIDEO_CARD_TITLE_EN__", video_title_en)
        .replace("__VIDEO_CARD_BODY_EN__", video_body_en)
        .replace("__TRANSCRIPT_RETENTION_ITEM_EN__", retention_item_en)
        .replace("__OPTOUT_EFFECT_EN__", optout_en)
        .replace("__ASSISTANT_NAME__", escaped_name)
        .replace("__AUDIO_HOURS__", str(audio_hours))
        .replace("__TRANSCRIPT_DAYS__", str(transcript_days))
        .replace("__FAVICON_DATA_URI__", FAVICON_DATA_URI)
        .replace("__ASSET_VERSION__", _asset_version())
    )
