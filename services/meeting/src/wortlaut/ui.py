"""Self-contained operator and transcript web UI served directly by the meeting service."""

import html
import json

from wortlaut.mail import FAILURE_REASONS
from wortlaut.settings import get_settings

PRIVACY_HTML = """<!DOCTYPE html>
<html lang="de" data-theme="dark" data-astryx-theme="stone">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Datenschutz &amp; Transparenz – __ASSISTANT_NAME__</title>
  <link rel="stylesheet" href="/sdk/ui/app.css">
</head>
<body
  class="min-h-screen bg-[var(--color-background-body,#101018)]
         text-[var(--color-text-primary,#f0f0f9)] antialiased"
>
  <main class="mx-auto max-w-3xl px-6 py-12 space-y-8">
    <header
      class="border-b border-[var(--color-border,#2e2e36)] pb-6
             flex items-start justify-between gap-4"
    >
      <div>
        <div
          class="inline-flex items-center gap-2 rounded-full border border-emerald-500/30
                 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 mb-3"
        >
          100 % Self-Hosted · Keine Cloud-Weitergabe
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">
          Datenschutz- &amp; Transparenzhinweis (__ASSISTANT_NAME__)
        </h1>
        <p class="mt-2 text-sm text-[var(--color-text-secondary,#ababb3)]">
          Informationen zur automatisierten Meeting-Protokollierung für Teilnehmende in
          Google Meet, Microsoft Teams und Cisco Webex.
        </p>
      </div>
      <a
        href="/ui"
        class="shrink-0 rounded-lg border border-[var(--color-border,#2e2e36)]
               bg-[var(--color-background-surface,#1b1b21)] px-3.5 py-2 text-xs font-medium
               hover:bg-[var(--color-background-muted,#3a3a42)]"
      >
        Zur Web-UI →
      </a>
    </header>

    <section
      class="rounded-xl border border-[var(--color-border,#2e2e36)]
             bg-[var(--color-background-surface,#1b1b21)] p-6 space-y-3"
    >
      <h2 class="text-base font-semibold">
        1. Warum nimmt __ASSISTANT_NAME__ an diesem Meeting teil?
      </h2>
      <p class="text-sm leading-relaxed text-[var(--color-text-secondary,#ababb3)]">
        Der Bot <strong>__ASSISTANT_NAME__</strong> wurde von einer am Meeting teilnehmenden
        Person gezielt eingeladen, um ein schriftliches Wortprotokoll (Transkript) der
        Besprechung zu erstellen. Beim Beitritt stellt sich der Bot im Meeting-Chat vor,
        nennt die einladende Person und verlinkt das Protokoll sowie diesen Datenschutzhinweis.
      </p>
    </section>

    <section class="grid gap-4 sm:grid-cols-2">
      <div
        class="rounded-xl border border-[var(--color-border,#2e2e36)]
               bg-[var(--color-background-surface,#1b1b21)] p-5 space-y-2"
      >
        <h3 class="text-sm font-semibold text-emerald-400">Keine externen KI-/Cloud-Dienste</h3>
        <p class="text-xs leading-relaxed text-[var(--color-text-secondary,#ababb3)]">
          Audioerfassung und Spracherkennung (lokales NVIDIA-Parakeet-ASR-Modell) laufen
          ausschließlich innerhalb des eigenen Kubernetes-Clusters. Es werden keine Audio- oder
          Textdaten an externe Cloud-Anbieter übertragen.
        </p>
      </div>
      <div
        class="rounded-xl border border-[var(--color-border,#2e2e36)]
               bg-[var(--color-background-surface,#1b1b21)] p-5 space-y-2"
      >
        <h3 class="text-sm font-semibold text-emerald-400">Keine Stimmprofile &amp; kein Video</h3>
        <p class="text-xs leading-relaxed text-[var(--color-text-secondary,#ababb3)]">
          Es werden weder Kamerabilder noch Bildschirminhalte aufgezeichnet. Die
          Sprecherzuordnung erfolgt ausschließlich über die technische
          Konferenz-Teilnehmersitzung (WebRTC), niemals über biometrische Stimmprofile
          (Voiceprints).
        </p>
      </div>
    </section>

    <section
      class="rounded-xl border border-[var(--color-border,#2e2e36)]
             bg-[var(--color-background-surface,#1b1b21)] p-6 space-y-3"
    >
      <h2 class="text-base font-semibold">
        2. Zugriffsschutz &amp; automatische Löschfristen
      </h2>
      <ul class="list-disc pl-5 text-sm text-[var(--color-text-secondary,#ababb3)] space-y-2">
        <li>
          <strong>Zugriff auf Protokolle:</strong> Standardmäßig hat nur die einladende Person
          nach Authentifizierung Zugriff auf das Protokoll (sowie Personen, denen explizit ein
          schreibgeschützter Lese-Link geteilt wurde).
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

    <section class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 space-y-2">
      <h2 class="text-base font-semibold text-amber-200">
        3. Widerspruch &amp; Beenden der Aufzeichnung
      </h2>
      <p class="text-sm leading-relaxed text-[var(--color-text-secondary,#ababb3)]">
        Wenn Sie keine Protokollierung wünschen, können Sie der Aufzeichnung jederzeit
        widersprechen: Der Bot <strong>__ASSISTANT_NAME__</strong> kann direkt über die
        Teilnehmerliste von Google Meet, Microsoft Teams oder Cisco Webex aus dem Raum
        entfernt oder durch die einladende Person in der
        <a href="/ui" class="underline text-amber-300 hover:text-amber-200">wortlaut Web-UI</a>
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
  <link rel="stylesheet" href="/sdk/ui/app.css">
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
    }


def render_ui() -> str:
    payload = {
        "failureReasons": FAILURE_REASONS,
        "instance": _build_instance_info(),
    }
    return UI_HTML.replace(
        "__BOOT_PAYLOAD_JSON__", json.dumps(payload, ensure_ascii=False)
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
    )

