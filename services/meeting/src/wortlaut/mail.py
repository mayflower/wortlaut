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


NORMAL_COMPLETED_REASONS = frozenset({"normal", "room_empty", "cancelled", "deadline"})

_EMAIL_HEAD_STYLE = (
    "<meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<meta name='color-scheme' content='light dark'>"
    "<meta name='supported-color-schemes' content='light dark'>"
    "<style>"
    "@media (prefers-color-scheme: dark) {"
    " .wl-body { background-color: #111113 !important; color: #fafaf9 !important; }"
    " .wl-sheet { background-color: #181920 !important; border-color: #2b2d38 !important;"
    "   box-shadow: none !important; }"
    " .wl-rule { border-color: #2b2d38 !important; }"
    " .wl-rule-soft { border-color: #23252f !important; }"
    " .wl-ink { color: #fafaf9 !important; }"
    " .wl-body-text { color: #fafaf9 !important; }"
    " .wl-muted { color: #a8a29e !important; }"
    " .wl-ts { color: #78716c !important; }"
    " .wl-pill { background-color: #23252f !important; border-color: #2b2d38 !important;"
    "   color: #a8a29e !important; }"
    " .wl-avatar { background-color: #23252f !important; border-color: #2b2d38 !important;"
    "   color: #fafaf9 !important; }"
    " .wl-track { background-color: #23252f !important; }"
    " .wl-bar { background-color: #10b981 !important; }"
    " .wl-emerald-text { color: #34d399 !important; }"
    " .wl-cta { background-color: #10b981 !important; color: #022c22 !important; }"
    " .wl-warn { background-color: #451a03 !important;"
    "   border-color: #b45309 !important; color: #fbbf24 !important; }"
    " .wl-err { background-color: #451a03 !important;"
    "   border-color: #b45309 !important; color: #fbbf24 !important; }"
    "}"
    "</style>"
)

_EMAIL_BRAND_MARK_HTML = (
    "<span style='display:inline-block;vertical-align:middle;width:24px;height:24px;"
    "border-radius:6px;background:#d1fae5;border:1px solid #6ee7b7;text-align:center;"
    "line-height:22px;margin-right:9px;'>"
    "<span style='display:inline-block;width:2px;height:8px;background:#059669;"
    "border-radius:2px;vertical-align:middle;margin:0 1px;'></span>"
    "<span style='display:inline-block;width:2px;height:13px;background:#059669;"
    "border-radius:2px;vertical-align:middle;margin:0 1px;'></span>"
    "<span style='display:inline-block;width:2px;height:6px;background:#059669;"
    "border-radius:2px;vertical-align:middle;margin:0 1px;'></span>"
    "<span style='display:inline-block;width:2px;height:11px;background:#059669;"
    "border-radius:2px;vertical-align:middle;margin:0 1px;'></span>"
    "</span>"
)


def _speaker_initials(name: str) -> str:
    parts = [p for p in str(name or "").strip().split() if p and p[0].isalnum()]
    if not parts:
        return "S"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


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
    for name, secs in sorted(totals.items(), key=lambda kv: -kv[1]):
        pct = round((secs / overall) * 100) if overall > 0 else 0
        items.append(
            {
                "name": name,
                "initials": _speaker_initials(name),
                "seconds": secs,
                "duration": format_duration_de(secs),
                "share_pct": pct,
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
        f"<!DOCTYPE html><html lang='de'><head>{_EMAIL_HEAD_STYLE}</head>"
        "<body class='wl-body' style='margin:0;padding:28px 12px;background:#fafaf9;"
        "font-family:system-ui,-apple-system,Liberation Sans,sans-serif;"
        "color:#1c1917;-webkit-font-smoothing:antialiased;'>"
        "<div class='wl-sheet' style='max-width:640px;margin:0 auto;background:#ffffff;"
        "border-radius:12px;border:1px solid #e7e5e4;overflow:hidden;'>"
        "<div class='wl-rule' style='padding:16px 28px;border-bottom:1px solid #e7e5e4;'>"
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0'>"
        "<tr><td valign='middle'>"
        f"{_EMAIL_BRAND_MARK_HTML}"
        "<span class='wl-ink' style='font-size:14px;font-weight:700;color:#1c1917;"
        "vertical-align:middle;letter-spacing:-0.01em;'>Wortlaut.cloud</span>"
        "</td><td align='right' valign='middle'>"
        "<span class='wl-pill' style='display:inline-block;font-size:13px;font-weight:600;"
        "background:#fafaf9;border:1px solid #e7e5e4;color:#57534e;"
        f"padding:3px 10px;border-radius:999px;'>{escape(human_provider)}</span>"
        "</td></tr></table></div>"
        "<div style='padding:24px 28px;'>"
        "<h1 class='wl-ink' style='margin:0 0 6px;font-size:22px;font-weight:700;"
        f"line-height:1.25;letter-spacing:-0.02em;color:#1c1917;'>{escape(title)}</h1>"
        "<div class='wl-muted' style='font-size:13px;color:#57534e;margin-bottom:20px;"
        f"font-variant-numeric:tabular-nums;'>{escape(human_period)}</div>"
        "<div class='wl-err' style='background:#fef3c7;border:1px solid #fde68a;"
        "border-radius:8px;padding:14px 16px;margin-bottom:20px;color:#78350f;"
        "font-size:14px;line-height:1.55;'>"
        f"<strong>Aufnahme nicht zustande gekommen:</strong> {escape(hint)}"
        "<div style='margin-top:4px;font-size:13px;opacity:0.9;"
        "font-family:Liberation Mono,DejaVu Sans Mono,ui-monospace,monospace;'>"
        f"Grund: {escape(reason_code)}</div>"
        "</div>"
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' "
        "style='font-size:14px;margin-bottom:22px;border-collapse:collapse;'>"
        "<tr><td class='wl-muted' style='padding:6px 0;color:#78716c;width:130px;'>Plattform</td>"
        "<td class='wl-ink' style='padding:6px 0;font-weight:600;color:#1c1917;'>"
        f"{escape(human_provider)}</td></tr>"
        "<tr><td class='wl-muted' style='padding:6px 0;color:#78716c;'>Termin</td>"
        "<td class='wl-ink' style='padding:6px 0;color:#1c1917;"
        f"font-variant-numeric:tabular-nums;'>{escape(human_period)}</td></tr>"
        "</table>"
        f"<a href='{escape(ui_url)}' class='wl-cta' style='display:inline-block;"
        "background:#047857;color:#ffffff;text-decoration:none;font-weight:600;"
        "font-size:14px;padding:10px 18px;border-radius:999px;'>"
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
    summary: dict | None = None,
    speakers: list[dict],
    turns: list[dict],
    pause_windows: list[dict] | None = None,
    keyframe_count: int = 0,
    notices: list[str],
    ui_url: str,
    reader_url: str | None,
    include_inline_transcript: bool = True,
) -> tuple[str, str]:
    total_speech_sec = sum(s["seconds"] for s in speakers)
    speech_summary = (
        f"{format_duration_de(total_speech_sec)} ({len(speakers)} Sprecher)"
        if speakers
        else "Audio erfasst (keine Sprachsegmente erkannt)"
    )
    primary_link = reader_url or ui_url

    summary_text = str(summary.get("summary") or "").strip() if isinstance(summary, dict) else ""
    topics = [
        t
        for t in ((summary.get("topics") if isinstance(summary, dict) else None) or [])
        if isinstance(t, dict) and (t.get("title") or t.get("details"))
    ]
    actions = [
        a
        for a in ((summary.get("action_items") if isinstance(summary, dict) else None) or [])
        if isinstance(a, dict) and str(a.get("task") or "").strip()
    ]

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

    has_summary_content = bool(summary_text or topics or actions)
    if summary_text or topics:
        plain_lines.extend(["", "ZUSAMMENFASSUNG", "-" * 68])
        if summary_text:
            plain_lines.append(summary_text)
        if topics:
            if summary_text:
                plain_lines.append("")
            for t in topics:
                t_title = " ".join(str(t.get("title") or "Thema").split())
                t_details = " ".join(str(t.get("details") or "").split())
                plain_lines.append(f"• {t_title}: {t_details}" if t_details else f"• {t_title}")

    if has_summary_content:
        plain_lines.extend(["", "TO-DO-LISTE", "-" * 68])
        if actions:
            for a in actions:
                owner = " ".join(str(a.get("owner") or "Team").split()) or "Team"
                task = " ".join(str(a["task"]).split())
                due = " ".join(str(a.get("due") or "").split())
                suffix = f" (Fällig: {due})" if due else ""
                plain_lines.append(f"[ ] {owner}: {task}{suffix}")
        else:
            plain_lines.append("Keine offenen Aufgaben vereinbart.")

    if speakers:
        plain_lines.extend(["", "SPRECHERANTEILE", "-" * 68])
        for sp in speakers:
            plain_lines.append(f"• {sp['name']} — {sp['duration']} ({sp['share_pct']} %)")

    initials_by_speaker = {sp["name"]: sp["initials"] for sp in speakers}
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

    # Chronologically interleave Off-the-Record pause windows that fall within the excerpt range
    timeline_entries: list[dict] = [
        {"kind": "turn", "start": float(t["start"]), "turn": t} for t in inline_turns
    ]
    if include_inline_transcript and pause_windows:
        max_shown_start = max((float(t["start"]) for t in inline_turns), default=float("inf"))
        for pw in pause_windows:
            p_start = float(pw.get("offset_seconds") or pw.get("start") or 0.0)
            if not inline_truncated or p_start <= max_shown_start + 30.0:
                timeline_entries.append({"kind": "pause", "start": p_start, "pause": pw})
        timeline_entries.sort(key=lambda e: (e["start"], 0 if e["kind"] == "pause" else 1))

    if include_inline_transcript:
        plain_lines.extend(["", "WORTPROTOKOLL", "-" * 68])
        if not timeline_entries:
            plain_lines.append("Keine gesprochenen Textsegmente im Aufzeichnungszeitraum erkannt.")
        else:
            for item in timeline_entries:
                if item["kind"] == "pause":
                    pw = item["pause"]
                    p_s = float(pw.get("offset_seconds") or pw.get("start") or 0.0)
                    ts0 = wall_clock_time_de(time_origin_utc, p_s)
                    p_end = (
                        pw.get("end_offset_seconds")
                        if pw.get("end_offset_seconds") is not None
                        else pw.get("end")
                    )
                    ts_range = (
                        f"{ts0}–{wall_clock_time_de(time_origin_utc, float(p_end))}"
                        if p_end is not None
                        else f"ab {ts0}"
                    )
                    by = " ".join(str(pw.get("by") or pw.get("paused_by") or "").split())
                    who = f" ({by})" if by else ""
                    plain_lines.append(f"[{ts_range}] Off-the-Record-Pause{who}")
                    plain_lines.append("")
                else:
                    turn = item["turn"]
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
            "<div class='wl-warn' style='background:#fef3c7;border:1px solid #fde68a;"
            "border-radius:8px;padding:12px 16px;margin-bottom:22px;color:#78350f;"
            "font-size:13px;line-height:1.55;'>"
            "<strong style='display:block;margin-bottom:2px;'>Hinweis zur Sitzung</strong>"
            f"{items_html}</div>"
        )

    summary_html = ""
    if has_summary_content:
        summary_parts = []
        if summary_text:
            summary_parts.append(
                "<div class='wl-body-text' style='font-size:14px;line-height:1.65;"
                f"color:#1c1917;margin-bottom:14px;'>{escape(summary_text)}</div>"
            )
        if topics:
            topic_rows = []
            for t in topics:
                t_title = " ".join(str(t.get("title") or "Thema").split())
                t_details = " ".join(str(t.get("details") or "").split())
                body_html = (
                    f"<strong class='wl-ink'>{escape(t_title)}:</strong> {escape(t_details)}"
                    if t_details
                    else f"<strong>{escape(t_title)}</strong>"
                )
                topic_rows.append(
                    "<li class='wl-body-text' style='margin:6px 0;font-size:14px;"
                    f"line-height:1.58;color:#1c1917;'>{body_html}</li>"
                )
            summary_parts.append(
                "<div style='margin-top:10px;'>"
                "<div class='wl-muted' style='font-size:13px;font-weight:600;"
                "color:#57534e;margin-bottom:6px;'>"
                "Besprochene Themen &amp; Ergebnisse</div>"
                f"<ul style='margin:0;padding-left:18px;'>{''.join(topic_rows)}</ul></div>"
            )
        if actions:
            action_rows = []
            for a in actions:
                owner = " ".join(str(a.get("owner") or "Team").split()) or "Team"
                task = " ".join(str(a["task"]).split())
                due = " ".join(str(a.get("due") or "").split())
                due_html = (
                    f" <span class='wl-muted' style='color:#78716c;font-size:13px;'>"
                    f"(Fällig: {escape(due)})</span>"
                    if due
                    else ""
                )
                action_rows.append(
                    "<div class='wl-body-text' style='margin:6px 0;font-size:14px;"
                    "line-height:1.55;color:#1c1917;'>"
                    f"☐ <strong class='wl-ink'>{escape(owner)}:</strong> "
                    f"{escape(task)}{due_html}</div>"
                )
            action_items_html = "".join(action_rows)
        else:
            action_items_html = (
                "<div class='wl-muted' style='font-size:13px;line-height:1.5;color:#78716c;'>"
                "Keine offenen Aufgaben vereinbart.</div>"
            )
        summary_parts.append(
            "<div class='wl-rule-soft' style='margin-top:14px;padding-top:12px;"
            "border-top:1px solid #e7e5e4;'>"
            "<div class='wl-emerald-text' style='font-size:13px;font-weight:600;"
            "color:#047857;margin-bottom:6px;'>To-Do-Liste</div>"
            f"{action_items_html}</div>"
        )
        summary_html = (
            "<div class='wl-rule' style='padding-bottom:22px;margin-bottom:22px;"
            "border-bottom:1px solid #e7e5e4;'>"
            "<h2 class='wl-ink' style='margin:0 0 12px;font-size:16px;font-weight:600;"
            "letter-spacing:-0.01em;color:#1c1917;'>Zusammenfassung &amp; Aufgaben</h2>"
            + "".join(summary_parts)
            + "</div>"
        )

    speakers_html = ""
    if speakers:
        rows = []
        for sp in speakers:
            pct = max(3, min(100, sp["share_pct"]))
            rows.append(
                "<div style='margin-bottom:11px;'>"
                "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' "
                "border='0' style='margin-bottom:4px;'><tr>"
                "<td class='wl-ink' style='font-size:13px;font-weight:600;color:#1c1917;'>"
                f"{escape(sp['name'])}</td>"
                "<td align='right' class='wl-muted' style='font-size:13px;color:#78716c;"
                "font-family:Liberation Mono,DejaVu Sans Mono,ui-monospace,monospace;'>"
                f"{escape(sp['duration'])} · {sp['share_pct']}&nbsp;%</td>"
                "</tr></table>"
                "<div class='wl-track' style='height:6px;background:#e7e5e4;"
                "border-radius:999px;overflow:hidden;'>"
                f"<div class='wl-bar' style='width:{pct}%;height:6px;background:#059669;"
                "border-radius:999px;'></div>"
                "</div></div>"
            )
        speakers_html = (
            "<div class='wl-rule' style='padding-bottom:16px;margin-bottom:22px;"
            "border-bottom:1px solid #e7e5e4;'>"
            "<h2 class='wl-ink' style='margin:0 0 12px;font-size:16px;font-weight:600;"
            "letter-spacing:-0.01em;color:#1c1917;'>Sprecheranteile</h2>"
            + "".join(rows)
            + "</div>"
        )

    transcript_html = ""
    if include_inline_transcript:
        if not timeline_entries:
            turn_blocks = (
                "<p class='wl-muted' style='color:#78716c;font-size:14px;margin:0;'>"
                "Keine gesprochenen Textsegmente im Aufzeichnungszeitraum erkannt.</p>"
            )
        else:
            blocks = []
            for item in timeline_entries:
                if item["kind"] == "pause":
                    pw = item["pause"]
                    p_s = float(pw.get("offset_seconds") or pw.get("start") or 0.0)
                    ts0 = wall_clock_time_de(time_origin_utc, p_s)
                    p_end = (
                        pw.get("end_offset_seconds")
                        if pw.get("end_offset_seconds") is not None
                        else pw.get("end")
                    )
                    ts_range = (
                        f"{ts0} – {wall_clock_time_de(time_origin_utc, float(p_end))}"
                        if p_end is not None
                        else f"ab {ts0}"
                    )
                    by = " ".join(str(pw.get("by") or pw.get("paused_by") or "").split())
                    who_html = f" · {escape(by)}" if by else ""
                    blocks.append(
                        "<div class='wl-warn' style='margin:10px 0;padding:8px 12px;"
                        "background:#fef3c7;border:1px solid #fde68a;border-radius:8px;"
                        "font-size:13px;color:#78350f;'>"
                        f"<strong>Off-the-Record-Pause</strong> · {escape(ts_range)}{who_html}"
                        "</div>"
                    )
                else:
                    turn = item["turn"]
                    initials = initials_by_speaker.get(
                        turn["speaker"], _speaker_initials(turn["speaker"])
                    )
                    ts = wall_clock_time_de(time_origin_utc, turn["start"])
                    blocks.append(
                        "<div class='wl-rule-soft' style='padding:12px 0;"
                        "border-bottom:1px solid #e7e5e4;'>"
                        "<div style='margin-bottom:5px;'>"
                        "<span class='wl-avatar' style='display:inline-block;width:22px;"
                        "height:22px;line-height:20px;text-align:center;border-radius:999px;"
                        "background:#fafaf9;border:1px solid #e7e5e4;color:#57534e;"
                        "font-size:13px;font-weight:700;vertical-align:middle;margin-right:7px;'>"
                        f"{escape(initials[:1])}</span>"
                        "<span class='wl-ink' style='font-weight:600;font-size:14px;"
                        f"color:#1c1917;vertical-align:middle;'>{escape(turn['speaker'])}</span>"
                        "<span class='wl-ts' style='font-size:13px;color:#78716c;"
                        "margin-left:8px;vertical-align:middle;"
                        "font-family:Liberation Mono,DejaVu Sans Mono,ui-monospace,monospace;'>"
                        f"{ts}</span>"
                        "</div>"
                        "<div class='wl-body-text' style='font-size:14px;line-height:1.6;"
                        f"color:#1c1917;'>{escape(turn['snippet'])}</div></div>"
                    )
            if inline_truncated:
                blocks.append(
                    "<div class='wl-muted' style='padding-top:12px;font-size:13px;"
                    "color:#57534e;'>"
                    "Vollständiges Wortprotokoll im angehängten Markdown-Dokument "
                    "(<code>.md</code>) oder in der interaktiven Web-Ansicht.</div>"
                )
            turn_blocks = "".join(blocks)
        transcript_html = (
            "<div style='margin-top:4px;'>"
            "<h2 class='wl-ink' style='margin:0 0 8px;font-size:16px;font-weight:600;"
            "letter-spacing:-0.01em;color:#1c1917;'>Wortprotokoll</h2>"
            f"{turn_blocks}</div>"
        )

    slides_meta = (
        f" · {keyframe_count} {'Bildschirm-Folie' if keyframe_count == 1 else 'Bildschirm-Folien'}"
        if keyframe_count > 0
        else ""
    )

    html_body = (
        f"<!DOCTYPE html><html lang='de'><head>{_EMAIL_HEAD_STYLE}</head>"
        "<body class='wl-body' style='margin:0;padding:28px 12px;background:#fafaf9;"
        "font-family:system-ui,-apple-system,Liberation Sans,sans-serif;"
        "color:#1c1917;-webkit-font-smoothing:antialiased;'>"
        "<div class='wl-sheet' style='max-width:680px;margin:0 auto;background:#ffffff;"
        "border-radius:12px;border:1px solid #e7e5e4;overflow:hidden;'>"
        "<div class='wl-rule' style='padding:16px 28px;border-bottom:1px solid #e7e5e4;'>"
        "<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0'>"
        "<tr><td valign='middle'>"
        f"{_EMAIL_BRAND_MARK_HTML}"
        "<span class='wl-ink' style='font-size:14px;font-weight:700;color:#1c1917;"
        "vertical-align:middle;letter-spacing:-0.01em;'>Wortlaut.cloud</span>"
        "</td><td align='right' valign='middle'>"
        "<span class='wl-pill' style='display:inline-block;font-size:13px;font-weight:600;"
        "background:#fafaf9;border:1px solid #e7e5e4;color:#57534e;"
        f"padding:3px 10px;border-radius:999px;'>{escape(human_provider)}</span>"
        "</td></tr></table></div>"
        "<div class='wl-rule' style='padding:24px 28px 22px;border-bottom:1px solid #e7e5e4;'>"
        "<h1 class='wl-ink' style='margin:0 0 6px;font-size:22px;font-weight:700;"
        f"line-height:1.25;letter-spacing:-0.02em;color:#1c1917;'>{escape(title)}</h1>"
        "<div class='wl-muted' style='font-size:13px;color:#57534e;"
        "font-variant-numeric:tabular-nums;'>"
        f"{escape(human_period)} · {escape(speech_summary)}{escape(slides_meta)}</div>"
        "<div style='margin-top:16px;'>"
        f"<a href='{escape(primary_link)}' class='wl-cta' style='display:inline-block;"
        "background:#047857;color:#ffffff;text-decoration:none;font-weight:600;"
        "font-size:14px;padding:10px 18px;border-radius:999px;'>"
        "Protokoll im Browser öffnen →</a>"
        "</div></div>"
        "<div style='padding:24px 28px;'>"
        f"{notice_html}"
        f"{summary_html}"
        f"{speakers_html}"
        f"{transcript_html}"
        "<div class='wl-rule wl-muted' style='margin-top:24px;padding-top:16px;"
        "border-top:1px solid #e7e5e4;font-size:13px;color:#78716c;line-height:1.55;'>"
        "<strong class='wl-ink' style='color:#57534e;'>Angehängte Dateien:</strong> "
        "Markdown-Protokoll (<code>.md</code>), Text-Transkript (<code>.txt</code>), "
        "Untertitel (<code>.vtt</code>) und strukturierte Metadaten (<code>.json</code>)."
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
    public_base = settings.public_base_url()
    ui_url = f"{public_base}/ui"
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
    if explanation and reason not in NORMAL_COMPLETED_REASONS:
        notices.append(explanation)
    if quality["has_audio_gaps"]:
        notices.append("Während der Aufnahme traten kurze Audiolücken auf.")
    if data["processing_error"] or quality["failed_asr_ranges"]:
        notices.append("Einzelne Audioabschnitte konnten nicht vollständig transkribiert werden.")

    time_origin_utc = data.get("time_origin_utc") or period.get("start")
    summary_data = data.get("summary")
    speakers = _speaker_breakdown(data)
    turns = group_transcript_turns(data.get("segments") or [])
    pause_windows = data.get("pause_windows") or []
    keyframe_count = len(data.get("keyframes") or [])
    plain_body, html_body = _build_completed_bodies(
        title=title,
        human_provider=human_provider,
        human_period=human_period,
        time_origin_utc=time_origin_utc,
        summary=summary_data,
        speakers=speakers,
        turns=turns,
        pause_windows=pause_windows,
        keyframe_count=keyframe_count,
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
        filename = f"wortlaut-{recording.id}.{format}"
        exports[filename] = content.encode("utf-8")
        if major == "text":
            message.add_attachment(
                content,
                subtype=minor,
                charset="utf-8",
                filename=filename,
            )
        else:
            message.add_attachment(
                exports[filename],
                maintype=major,
                subtype=minor,
                filename=filename,
            )
    if len(message.as_bytes()) > settings.mail_attachment_limit_bytes:
        compact_plain, _ = _build_completed_bodies(
            title=title,
            human_provider=human_provider,
            human_period=human_period,
            time_origin_utc=time_origin_utc,
            summary=summary_data,
            speakers=speakers,
            turns=turns,
            pause_windows=pause_windows,
            keyframe_count=keyframe_count,
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
            target = urlsplit(public_base)
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
            base_url = public_base + f"/v1/recordings/{recording.id}/exports"
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
