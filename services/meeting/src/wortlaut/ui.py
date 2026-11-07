"""Self-contained operator and transcript web UI served directly by the meeting service."""

import json

from wortlaut.mail import FAILURE_REASONS
from wortlaut.settings import get_settings

UI_HTML = """<!DOCTYPE html>
<html lang="de" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wortlaut – Meeting-Transkription</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body class="bg-[#0b1120] text-slate-100 antialiased">
  <div id="root">
    <!-- Bot in ein Meeting schicken · title-search · participation-filter -->
    <!-- rejoin-rec-btn · copy-transcript-btn -->
  </div>
  <script>
    window.__WORTLAUT_BOOT__ = __BOOT_PAYLOAD_JSON__;
  </script>
  <script type="module" src="/sdk/ui/app.js"></script>
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
            },
            "mail": {
                "imapEnabled": False,
                "smtpEnabled": False,
                "senderAuth": "gateway",
                "allowedDomains": [],
            },
            "limits": {
                "maxActiveMeetings": 2,
                "lobbyTimeoutSeconds": 600,
                "emptyRoomTimeoutSeconds": 300,
            },
            "retention": {
                "audioHours": 24,
                "transcriptDays": 30,
            },
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
    }


def render_ui() -> str:
    payload = {
        "failureReasons": FAILURE_REASONS,
        "instance": _build_instance_info(),
    }
    return UI_HTML.replace(
        "__BOOT_PAYLOAD_JSON__", json.dumps(payload, ensure_ascii=False)
    )
