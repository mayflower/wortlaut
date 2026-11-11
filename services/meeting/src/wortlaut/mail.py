"""One configured SMTP relay; durable acceptance, bounded explicit retries."""

import io
import shlex
import smtplib
import ssl
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr
from html import escape
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.exports import (
    export_data,
    export_reader_token,
    format_date_short_de,
    format_duration_de,
    format_period_de,
    group_transcript_turns,
    provider_label,
    render_export,
    wall_clock_time_de,
)
from wortlaut.models import Attempt, AudioChunk, AudioStream, CalendarEntry, Delivery, Recording
from wortlaut.settings import get_settings

FAILURE_REASONS = {
    "lobby_timeout": "Zeitüberschreitung im Wartebereich (Bot wurde nicht eingelassen)",
    "admission_denied": "Beitritt wurde vom Host oder Meeting-Provider abgelehnt",
    "prejoin_denied": "Meeting-Teilnahme wurde vor dem Beitritt vom Provider verweigert",
    "human_verification_required": (
        "Google Meet verlangt eine menschliche Sicherheits-/CAPTCHA-Prüfung"
    ),
    "consent_required": "Zustimmungsdialog im Meeting blockiert den automatischen Beitritt",
    "teams_auth_required": (
        "Microsoft Teams verlangt eine Konto-Anmeldung (Gastbeitritt nicht erlaubt)"
    ),
    "teams_verification_required": "Microsoft Teams verlangt einen Bestätigungscode",
    "teams_prejoin_timeout": "Microsoft Teams Beitrittsseite hat nicht rechtzeitig geladen",
    "zoom_auth_required": (
        "Zoom verlangt eine Konto-Anmeldung oder E-Mail-Registrierung "
        "(anonymer Gastbeitritt nicht erlaubt)"
    ),
    "zoom_passcode_required": "Zoom verlangt einen Meeting-Kenncode (Passcode fehlt oder ungültig)",
    "zoom_web_client_disabled": "Der Beitritt über den Zoom Web-Client ist vom Host deaktiviert",
    "zoom_prejoin_timeout": "Zoom Beitrittsseite hat nicht rechtzeitig geladen",
    "auth_session_missing": "Anmeldesitzung fehlt oder ist abgelaufen",
    "join_button_missing": "Beitrittsschaltfläche auf der Meeting-Seite nicht gefunden",
    "guest_name_missing": "Gast-Namensfeld auf der Meeting-Seite nicht verfügbar",
    "guest_name_input_failed": "Gastname konnte nicht eingegeben werden",
    "meeting_not_found": "Besprechung wurde beim Provider nicht gefunden",
    "missed": "Terminzeitfenster war vor dem Start bereits abgelaufen",
    "removed": "Bot wurde aus der Besprechung entfernt",
    "room_empty": (
        "Meeting-Raum war für 5 Minuten leer oder ohne Audioaktivität (automatisch verlassen)"
    ),
    "worker_failed": "Worker-Prozess wurde unerwartet beendet",
    "worker_startup_failed": "Browser-Start im Worker fehlgeschlagen",
}


def effective_participation_reason(data: dict) -> str | None:
    if data.get("participation_reason"):
        return data["participation_reason"]
    for attempt in reversed(data.get("attempts", [])):
        if attempt.get("end_reason"):
            return attempt["end_reason"]
    return None


def delivery_json(delivery):
    if delivery is None:
        return {"status": "not_configured" if not get_settings().enable_smtp else "pending"}
    return {
        "status": delivery.status,
        "message_id": delivery.message_id,
        "attempts": delivery.attempts,
        "error": delivery.error,
        "retry_at": delivery.retry_at,
        "delivered_at": delivery.delivered_at,
        "accepted_recipients": delivery.accepted_recipients,
        "refused_codes": delivery.refused_codes,
    }


SPEAKER_BADGE_COLORS = (
    ("#ecfdf5", "#047857", "#10b981"),
    ("#eff6ff", "#1d4ed8", "#3b82f6"),
    ("#f5f3ff", "#6d28d9", "#8b5cf6"),
    ("#fffbeb", "#b45309", "#f59e0b"),
    ("#fdf2f8", "#be185d", "#ec4899"),
    ("#f0fdfa", "#0f766e", "#14b8a6"),
)


def _speaker_breakdown(data: dict) -> list[dict]:
    totals: dict[str, float] = {}
    for seg in data.get("segments") or []:
        label = " ".join((seg.get("speaker_label") or "Sprecher").split())
        dur = max(0.0, float(seg.get("end") or 0.0) - float(seg.get("start") or 0.0))
        totals[label] = totals.get(label, 0.0) + dur
    if not totals:
        for src in data.get("sources_summary") or []:
            sec = float(src.get("speech_seconds") or 0.0)
            if sec > 0:
                name = (
                    src.get("participant_name")
                    or src.get("signaled_participant_id")
                    or "Sprecher"
                )
                totals[name] = totals.get(name, 0.0) + sec
    overall = sum(totals.values())
    items = []
    for idx, (name, secs) in enumerate(sorted(totals.items(), key=lambda kv: -kv[1])):
        pct = round((secs / overall) * 100) if overall > 0 else 0
        bg, fg, bar = SPEAKER_BADGE_COLORS[idx % len(SPEAKER_BADGE_COLORS)]
        items.append(
            {
                "name": name,
                "seconds": secs,
                "duration": format_duration_de(secs),
                "share_pct": pct,
                "bg": bg,
                "fg": fg,
                "bar": bar,
            }
        )
    return items


def _build_failed_join_bodies(
    *,
    title: str,
    human_provider: str,
    human_period: str,
    reason: str | None,
    explanation: str | None,
    ui_url: str,
) -> tuple[str, str]:
    hint = explanation or "Es wurde kein Audio im Meeting empfangen."
    reason_code = reason or "no_audio_received"
    plain = (
        f"KEINE AUFNAHME · {title}\n"
        f"{'=' * 64}\n\n"
        f"Plattform:   {human_provider}\n"
        f"Termin:      {human_period}\n"
        f"Status:      Aufnahme konnte nicht gestartet werden (Grund: {reason_code})\n\n"
        f"Ursache:\n{hint}\n\n"
        f"In der Web-Ansicht öffnen & bei Bedarf erneut starten:\n{ui_url}\n\n"
        "Es wurde kein Audio aufgezeichnet; daher sind keine Transkript-Anhänge enthalten.\n"
    )
    html = (
        "<!DOCTYPE html><html lang='de'><head><meta charset='utf-8'></head>"
        "<body style='margin:0;padding:24px 12px;background:#f4f6f9;"
        "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;"
        "color:#0f172a;'>"
        "<div style='max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;"
        "border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.05);'>"
        "<div style='background:#0f172a;padding:20px 28px;color:#ffffff;'>"
        "<div style='font-size:12px;letter-spacing:0.08em;text-transform:uppercase;"
        "color:#94a3b8;font-weight:700;'>wortlaut · Konferenz-Benachrichtigung</div>"
        "<h1 style='margin:6px 0 0;font-size:20px;line-height:1.35;color:#ffffff;'>"
        f"{escape(title)}</h1>"
        "</div>"
        "<div style='padding:24px 28px;'>"
        "<div style='background:#fef2f2;border:1px solid #fecaca;border-radius:12px;"
        "padding:14px 16px;margin-bottom:20px;color:#991b1b;font-size:14px;line-height:1.5;'>"
        f"<strong>Aufnahme nicht zustande gekommen:</strong> {escape(hint)}"
        "<div style='margin-top:4px;font-size:12px;color:#b91c1c;'>"
        f"Grund: {escape(reason_code)}</div>"
        "</div>"
        "<table style='width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px;'>"
        "<tr><td style='padding:6px 0;color:#64748b;width:130px;'>Plattform</td>"
        "<td style='padding:6px 0;font-weight:600;color:#0f172a;'>"
        f"{escape(human_provider)}</td></tr>"
        "<tr><td style='padding:6px 0;color:#64748b;'>Termin</td>"
        f"<td style='padding:6px 0;color:#0f172a;'>{escape(human_period)}</td></tr>"
        "</table>"
        f"<a href='{escape(ui_url)}' style='display:inline-block;background:#059669;"
        "color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;"
        "padding:11px 20px;border-radius:10px;'>"
        "In der Web-Ansicht prüfen &amp; erneut starten →</a>"
        "</div></div></body></html>"
    )
    return plain, html


def _build_completed_bodies(
    *,
    title: str,
    human_provider: str,
    human_period: str,
    time_origin_utc: str | None = None,
    speakers: list[dict],
    turns: list[dict],
    notices: list[str],
    ui_url: str,
    reader_url: str | None,
    include_inline_transcript: bool = True,
) -> tuple[str, str]:
    total_speech_sec = sum(s["seconds"] for s in speakers)
    speech_summary = (
        f"{format_duration_de(total_speech_sec)} ({len(speakers)} "
        f"{'Sprecher' if len(speakers) != 1 else 'Sprecher'})"
        if speakers
        else "Audio erfasst (keine Sprachsegmente erkannt)"
    )
    primary_link = reader_url or ui_url

    plain_lines = [
        f"WORTPROTOKOLL · {title}",
        "=" * 68,
        "",
        f"Plattform:    {human_provider}",
        f"Termin:       {human_period}",
        f"Sprechzeit:   {speech_summary}",
        f"Web-Ansicht:  {primary_link}",
    ]
    if reader_url:
        plain_lines.append(f"Alle Meetings: {ui_url}")

    if notices:
        plain_lines.extend(["", "Hinweise zur Sitzung:"])
        for note in notices:
            plain_lines.append(f"• {note}")

    if speakers:
        plain_lines.extend(["", "SPRECHERANTEILE", "-" * 68])
        for sp in speakers:
            plain_lines.append(f"• {sp['name']} — {sp['duration']} ({sp['share_pct']} %)")

    color_by_speaker = {sp["name"]: (sp["bg"], sp["fg"]) for sp in speakers}
    inline_turns: list[dict] = []
    inline_truncated = False
    if include_inline_transcript and turns:
        char_budget = 3600
        used_chars = 0
        for turn in turns:
            snippet = turn["text"]
            if len(snippet) > 420:
                snippet = snippet[:417].rstrip() + "…"
                inline_truncated = True
            if used_chars + len(snippet) > char_budget and inline_turns:
                inline_truncated = True
                break
            inline_turns.append({**turn, "snippet": snippet})
            used_chars += len(snippet)
            if len(inline_turns) >= 24 and len(turns) > 24:
                inline_truncated = True
                break

    if include_inline_transcript:
        plain_lines.extend(["", "WORTPROTOKOLL", "-" * 68])
        if not inline_turns:
            plain_lines.append("Keine gesprochenen Textsegmente im Aufzeichnungszeitraum erkannt.")
        else:
            for turn in inline_turns:
                ts = wall_clock_time_de(time_origin_utc, turn["start"])
                plain_lines.append(f"[{ts}] {turn['speaker']}:")
                plain_lines.append(turn["snippet"])
                plain_lines.append("")
            if inline_truncated:
                plain_lines.append(
                    "… Vollständiges Wortprotokoll im angehängten Markdown-Dokument (.md) "
                    "sowie in der Web-Ansicht."
                )
                plain_lines.append("")

    plain_lines.extend(
        [
            "-" * 68,
            "Anhänge: Markdown (.md), Text (.txt), Untertitel (.vtt), Rohdaten (.json)",
        ]
    )
    plain_body = "\n".join(plain_lines).rstrip() + "\n"

    notice_html = ""
    if notices:
        items_html = "".join(
            f"<div style='margin:3px 0;'>• {escape(note)}</div>" for note in notices
        )
        notice_html = (
            "<div style='background:#fffbeb;border:1px solid #fde68a;border-radius:12px;"
            "padding:12px 16px;margin-bottom:20px;color:#92400e;font-size:13px;line-height:1.5;'>"
            "<strong style='display:block;margin-bottom:2px;'>Hinweis zur Sitzung</strong>"
            f"{items_html}</div>"
        )

    speakers_html = ""
    if speakers:
        rows = []
        for sp in speakers:
            pct = max(4, min(100, sp["share_pct"]))
            rows.append(
                "<div style='margin-bottom:10px;'>"
                "<div style='display:flex;justify-content:space-between;font-size:13px;"
                "margin-bottom:4px;'>"
                f"<span style='font-weight:600;color:#0f172a;'>{escape(sp['name'])}</span>"
                "<span style='color:#64748b;'>"
                f"{escape(sp['duration'])} · {sp['share_pct']}&nbsp;%</span>"
                "</div>"
                "<div style='height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;'>"
                f"<div style='width:{pct}%;height:6px;background:{sp['bar']};"
                "border-radius:999px;'></div>"
                "</div></div>"
            )
        speakers_html = (
            "<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;"
            "padding:16px 18px;margin-bottom:22px;'>"
            "<div style='font-size:11px;font-weight:700;text-transform:uppercase;"
            "letter-spacing:0.07em;color:#64748b;margin-bottom:12px;'>Sprecheranteile</div>"
            + "".join(rows)
            + "</div>"
        )

    transcript_html = ""
    if include_inline_transcript:
        if not inline_turns:
            turn_blocks = (
                "<p style='color:#64748b;font-size:14px;margin:0;'>"
                "Keine gesprochenen Textsegmente im Aufzeichnungszeitraum erkannt.</p>"
            )
        else:
            blocks = []
            for turn in inline_turns:
                bg, fg = color_by_speaker.get(turn["speaker"], ("#f1f5f9", "#334155"))
                ts = wall_clock_time_de(time_origin_utc, turn["start"])
                blocks.append(
                    "<div style='padding:12px 0;border-bottom:1px solid #f1f5f9;'>"
                    "<div style='margin-bottom:5px;'>"
                    f"<span style='display:inline-block;background:{bg};color:{fg};"
                    "font-weight:700;font-size:12px;padding:2px 9px;border-radius:999px;'>"
                    f"{escape(turn['speaker'])}</span>"
                    f"<span style='font-size:12px;color:#94a3b8;margin-left:8px;"
                    f"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'>{ts}</span>"
                    "</div>"
                    "<div style='font-size:14px;line-height:1.6;color:#1e293b;'>"
                    f"{escape(turn['snippet'])}</div></div>"
                )
            if inline_truncated:
                blocks.append(
                    "<div style='padding-top:12px;font-size:13px;color:#475569;font-style:italic;'>"
                    "Vollständiges Wortprotokoll im angehängten Markdown-Dokument "
                    "(<code>.md</code>) oder in der interaktiven Web-Ansicht.</div>"
                )
            turn_blocks = "".join(blocks)
        transcript_html = (
            "<div style='margin-top:8px;'>"
            "<div style='font-size:11px;font-weight:700;text-transform:uppercase;"
            "letter-spacing:0.07em;color:#64748b;margin-bottom:8px;'>Wortprotokoll</div>"
            f"{turn_blocks}</div>"
        )

    html_body = (
        "<!DOCTYPE html><html lang='de'><head><meta charset='utf-8'></head>"
        "<body style='margin:0;padding:24px 12px;background:#f4f6f9;"
        "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;"
        "color:#0f172a;'>"
        "<div style='max-width:680px;margin:0 auto;background:#ffffff;border-radius:16px;"
        "border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.05);'>"
        "<div style='background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);"
        "padding:22px 28px;color:#ffffff;'>"
        "<div style='display:flex;align-items:center;justify-content:space-between;'>"
        "<span style='font-size:12px;letter-spacing:0.08em;text-transform:uppercase;"
        "color:#34d399;font-weight:700;'>wortlaut · Wortprotokoll</span>"
        "<span style='font-size:12px;background:rgba(255,255,255,0.12);color:#e2e8f0;"
        f"padding:3px 10px;border-radius:999px;'>{escape(human_provider)}</span>"
        "</div>"
        "<h1 style='margin:8px 0 4px;font-size:22px;line-height:1.3;color:#ffffff;'>"
        f"{escape(title)}</h1>"
        "<div style='font-size:13px;color:#cbd5e1;'>"
        f"{escape(human_period)} · {escape(speech_summary)}</div>"
        "</div>"
        "<div style='padding:24px 28px;'>"
        "<div style='margin-bottom:22px;'>"
        f"<a href='{escape(primary_link)}' style='display:inline-block;background:#059669;"
        "color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;"
        "padding:11px 20px;border-radius:10px;'>Protokoll im Browser öffnen →</a>"
        "</div>"
        f"{notice_html}"
        f"{speakers_html}"
        f"{transcript_html}"
        "<div style='margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;"
        "font-size:12px;color:#64748b;line-height:1.5;'>"
        "<strong>Angehängte Dateien:</strong> Markdown-Protokoll (<code>.md</code>), "
        "Text-Transkript (<code>.txt</code>), Untertitel (<code>.vtt</code>) und "
        "strukturierte Metadaten (<code>.json</code>)."
        "</div></div></div></body></html>"
    )
    return plain_body, html_body


def build_message(db, recording, delivery):
    settings = get_settings()
    data = export_data(db, recording)
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = ", ".join(delivery.recipients)
    message["Message-ID"] = delivery.message_id
    period = data["scheduled_period"]
    quality = data["quality"]
    reason = effective_participation_reason(data)
    explanation = FAILURE_REASONS.get(reason) if reason else None
    human_provider = provider_label(recording.provider)
    human_period = format_period_de(period["start"], period["end"])
    date_short = format_date_short_de(period["start"])
    ui_url = f"{settings.api_url.rstrip('/')}/ui"
    title = recording.title or f"Besprechung ({human_provider})"

    capture_anomaly = bool(quality.get("capture_anomaly"))
    anomaly_hint = (
        "Im Raum wurden Teilnehmer signalisiert, aber keine aktiven Sprachpakete empfangen "
        "(mögliche Erfassungsstörung)."
    )

    if quality["no_audio_received"]:
        is_anomaly = capture_anomaly and reason in (None, "room_empty")
        effective_reason = "capture_anomaly" if is_anomaly else reason
        effective_explanation = anomaly_hint if is_anomaly else explanation
        reason_label = effective_reason or "no_audio_received"
        message["Subject"] = (
            f"wortlaut · Keine Aufnahme: {title} — fehlgeschlagen ({reason_label})"
        )
        plain_body, html_body = _build_failed_join_bodies(
            title=title,
            human_provider=human_provider,
            human_period=human_period,
            reason=effective_reason,
            explanation=effective_explanation,
            ui_url=ui_url,
        )
        message.set_content(plain_body)
        message.add_alternative(html_body, subtype="html")
        return message

    message["Subject"] = (
        f"wortlaut · Wortprotokoll: {recording.title} ({date_short})"
        if recording.title
        else f"wortlaut · Wortprotokoll ({human_provider}, {date_short})"
    )
    reader_cred = export_reader_token(recording) if recording.export_reader_nonce else None
    reader_url = (
        f"{ui_url}#token=wortlaut-read-{recording.id}.{reader_cred.removeprefix('wortlaut-read-')}"
        if reader_cred
        else None
    )
    notices: list[str] = []
    if capture_anomaly:
        notices.append(anomaly_hint)
    if explanation:
        notices.append(explanation)
    if quality["has_audio_gaps"]:
        notices.append("Während der Aufnahme traten kurze Audiolücken auf.")
    if data["processing_error"] or quality["failed_asr_ranges"]:
        notices.append("Einzelne Audioabschnitte konnten nicht vollständig transkribiert werden.")

    time_origin_utc = data.get("time_origin_utc") or period.get("start")
    speakers = _speaker_breakdown(data)
    turns = group_transcript_turns(data.get("segments") or [])
    plain_body, html_body = _build_completed_bodies(
        title=title,
        human_provider=human_provider,
        human_period=human_period,
        time_origin_utc=time_origin_utc,
        speakers=speakers,
        turns=turns,
        notices=notices,
        ui_url=ui_url,
        reader_url=reader_url,
        include_inline_transcript=True,
    )
    message.set_content(plain_body)
    message.add_alternative(html_body, subtype="html")

    exports = {}
    for format in ("md", "txt", "vtt", "json"):
        content, media_type = render_export(data, format)
        major, minor = media_type.split(";", 1)[0].split("/", 1)
        exports[f"wortlaut-{recording.id}.{format}"] = content.encode()
        message.add_attachment(
            content.encode(),
            maintype=major,
            subtype=minor,
            filename=f"wortlaut-{recording.id}.{format}",
        )
    if len(message.as_bytes()) > settings.mail_attachment_limit_bytes:
        compact_plain, _ = _build_completed_bodies(
            title=title,
            human_provider=human_provider,
            human_period=human_period,
            time_origin_utc=time_origin_utc,
            speakers=speakers,
            turns=turns,
            notices=notices,
            ui_url=ui_url,
            reader_url=reader_url,
            include_inline_transcript=False,
        )
        message.clear_content()
        message.set_content(
            compact_plain + "\nDie vier vollständigen Exporte liegen im ZIP-Anhang.\n"
        )
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            for filename, content in exports.items():
                entry = zipfile.ZipInfo(filename)
                entry.compress_type = zipfile.ZIP_DEFLATED
                zipped.writestr(entry, content)
        message.add_attachment(
            archive.getvalue(),
            maintype="application",
            subtype="zip",
            filename=f"wortlaut-{recording.id}.zip",
        )
        if len(message.as_bytes()) > settings.mail_attachment_limit_bytes:
            target = urlsplit(settings.api_url)
            if (
                target.scheme != "https"
                or not target.hostname
                or target.username
                or target.password
                or target.query
                or target.fragment
            ):
                raise ValueError("Large-export download requires an HTTPS API origin")
            recording.export_reader_nonce = recording.export_reader_nonce or uuid.uuid4()
            credential = export_reader_token(recording)
            sig = credential.removeprefix("wortlaut-read-")
            ui_link = f"{ui_url}#token=wortlaut-read-{recording.id}.{sig}"
            message.clear_content()
            base_url = settings.api_url.rstrip("/") + f"/v1/recordings/{recording.id}/exports"
            downloads = "\n".join(
                f"curl --fail --header {shlex.quote('Authorization: Bearer ' + credential)} "
                f"{shlex.quote(base_url + '/' + format)} "
                f"--output 'wortlaut-{recording.id}.{format}'"
                for format in ("md", "txt", "vtt", "json")
            )
            message.set_content(
                compact_plain
                + "\nDie vollständigen Exporte überschreiten auch komprimiert das Anhangslimit.\n"
                "Lesezugang nur für die Exporte dieser Aufnahme, bis zum Ablauf der "
                "Transkriptaufbewahrung. Dieser Zugang erlaubt keine Steuerung.\n"
                f"Web-Ansicht (schreibgeschützter Lese-Link):\n{ui_link}\n"
                "Download im Terminal (Zugang vertraulich behandeln):\n" + downloads + "\n"
            )
    return message


def transmit(message, recipients):
    settings = get_settings()
    connection = None
    sending = False
    try:
        if settings.smtp_tls == "implicit":
            connection = smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=15,
                context=ssl.create_default_context(),
            )
        else:
            connection = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15)
            if settings.smtp_tls == "starttls":
                connection.starttls(context=ssl.create_default_context())
        if settings.smtp_username:
            if not settings.smtp_password:
                return "failed", {}, "smtp_credentials_missing"
            connection.login(settings.smtp_username, settings.smtp_password.get_secret_value())
        sending = True
        refused = connection.send_message(message, to_addrs=recipients)
        return "accepted", {address: int(result[0]) for address, result in refused.items()}, None
    except smtplib.SMTPRecipientsRefused as error:
        return (
            "failed",
            {address: int(result[0]) for address, result in error.recipients.items()},
            "recipients_refused",
        )
    except smtplib.SMTPResponseException as error:
        return "failed", {}, f"smtp_{error.smtp_code}"
    except (OSError, smtplib.SMTPException):
        # Once sending begins a disconnect may follow accepted DATA. Never
        # infer rejection or send again automatically without an SMTP answer.
        return ("unknown" if sending else "failed"), {}, "smtp_disconnected"
    finally:
        if connection:
            # QUIT failure after an accepted DATA reply must not erase success.
            connection.close()


def smtp_pass(engine):
    settings = get_settings()
    if not settings.smtp_host:
        return
    now = datetime.now(UTC)
    with Session(engine) as db:
        # A persisted in-flight send after process restart has unknown acceptance.
        for delivery in db.scalars(select(Delivery).where(Delivery.status == "sending")):
            delivery.status, delivery.error = "delivery_unknown", "process_interrupted"
        db.commit()
        records = db.scalars(
            select(Recording)
            .where(
                Recording.processing.in_(["completed", "failed"]),
                Recording.transcript_deleted_at.is_(None),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for recording in records:
            delivery = db.get(Delivery, recording.id)
            if delivery is not None and (
                delivery.status != "pending" or (delivery.retry_at and delivery.retry_at > now)
            ):
                continue
            if delivery is None:
                entry = (
                    db.get(CalendarEntry, recording.calendar_entry_id)
                    if recording.calendar_entry_id
                    else None
                )
                recipients = settings.result_recipients.get(
                    entry.organizer
                    if entry
                    else (recording.owner_email or "default"),
                    settings.result_recipients.get("default", []),
                )
                if (entry and settings.mail_reply_to_sender
                        and settings.mail_sender_auth == "dkim"
                        and entry.organizer.rsplit("@", 1)[-1]
                        in settings.mail_allowed_sender_domains):
                    recipients = [entry.organizer]
                elif (
                    not entry
                    and recording.owner_email
                    and settings.mail_reply_to_sender
                    and (
                        not settings.mail_allowed_sender_domains
                        or recording.owner_email.rsplit("@", 1)[-1].lower()
                        in {d.lower() for d in settings.mail_allowed_sender_domains}
                    )
                ):
                    recipients = [recording.owner_email]
                has_audio = db.scalar(
                    select(AudioChunk.id)
                    .join(AudioStream)
                    .join(Attempt)
                    .where(
                        Attempt.recording_id == recording.id,
                        AudioChunk.sample_count > 0,
                    )
                    .limit(1)
                )
                end_reason = recording.participation_reason or db.scalar(
                    select(Attempt.end_reason)
                    .where(
                        Attempt.recording_id == recording.id,
                        Attempt.end_reason.is_not(None),
                    )
                    .order_by(Attempt.ended_at.desc().nullslast())
                    .limit(1)
                )
                failed_join = (
                    recording.participation == "ended"
                    and recording.cancelled_at is None
                    and (entry is not None or end_reason in FAILURE_REASONS)
                )
                if (not has_audio and not failed_join) or not recipients:
                    continue
                domain = parseaddr(settings.smtp_from)[1].rsplit("@", 1)[-1]
                delivery = Delivery(
                    recording_id=recording.id,
                    message_id=f"<wortlaut.{recording.id.hex}@{domain}>",
                    recipients=list(dict.fromkeys(recipients)),
                    accepted_recipients=[],
                )
                db.add(delivery)
                db.flush()
            try:
                message = build_message(db, recording, delivery)
            except (ValueError, TypeError, UnicodeError):
                delivery.status, delivery.error = "failed", "mail_configuration_invalid"
                db.commit()
                continue
            pending = [
                address
                for address in delivery.recipients
                if address not in delivery.accepted_recipients
            ]
            delivery.status, delivery.attempts = "sending", delivery.attempts + 1
            db.commit()
            status, refused, reason = transmit(message, pending)
            if status == "accepted":
                delivery.accepted_recipients = list(
                    dict.fromkeys(
                        delivery.accepted_recipients
                        + [address for address in pending if address not in refused]
                    )
                )
            delivery.refused_codes = refused
            if status == "unknown":
                delivery.status, delivery.error = "delivery_unknown", reason
            elif status == "accepted" and not refused:
                delivery.status, delivery.error, delivery.delivered_at = "delivered", None, now
            else:
                delivery.status = (
                    "failed" if delivery.attempts >= settings.mail_max_attempts else "pending"
                )
                delivery.error = reason or "recipients_refused"
                delivery.retry_at = now + timedelta(seconds=60 * delivery.attempts)
            db.commit()
