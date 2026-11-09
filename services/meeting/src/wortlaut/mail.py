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
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.exports import export_data, export_reader_token, render_export
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
    title_line = f"Titel: {recording.title}\n" if recording.title else ""
    if quality["no_audio_received"]:
        message["Subject"] = (
            f"wortlaut: Aufnahme {recording.id} fehlgeschlagen ({reason or 'no_audio_received'})"
        )
        body = (
            f"wortlaut – {recording.provider}\n"
            + title_line
            + f"Termin: {period['start']} bis {period['end']}\n"
            f"Teilnahme: {data['participation']}; "
            f"Grund: {reason or 'unbekannt'}\n"
            f"Hinweis: {explanation or 'Es wurde kein Audio im Meeting empfangen.'}\n"
            f"Verarbeitung: {data['processing']}\n"
            f"Web-UI (Status & Erneut starten): {settings.api_url.rstrip('/')}/ui\n"
            "Es wurde kein Audio aufgezeichnet; daher sind keine Transkript-Exporte angehängt.\n"
        )
        message.set_content(body)
        return message
    message["Subject"] = (
        f"wortlaut: {recording.title} (Aufnahme {recording.id})"
        if recording.title
        else f"wortlaut: Aufnahme {recording.id}"
    )
    attribution = "unklar" if quality["attribution_unknown"] else "keine ungebundenen Samples"
    drain = "unvollständig" if quality["incomplete_drain"] else "kein bekannter Drain-Fehler"
    clock = (
        "Unterbrechung beobachtet"
        if quality["audio_clock_interrupted"]
        else "keine bekannte Unterbrechung"
    )
    failure = data["processing_error"] or (
        "ASR-Ausfälle" if quality["failed_asr_ranges"] else "keiner"
    )
    reader_cred = export_reader_token(recording) if recording.export_reader_nonce else None
    reader_ui_line = (
        f"Web-Ansicht (schreibgeschützter Lese-Link): "
        f"{settings.api_url.rstrip('/')}/ui#token=wortlaut-read-{recording.id}.{reader_cred.removeprefix('wortlaut-read-')}\n"
        if reader_cred
        else ""
    )
    body = (
        f"wortlaut – {recording.provider}\n"
        + title_line
        + f"Termin: {period['start']} bis {period['end']}\n"
        f"Letztes bekanntes Audio: {data['last_known_audio_utc'] or 'unbekannt'}\n"
        f"Teilnahme: {data['participation']}; "
        f"Grund: {reason or 'unbekannt'}\n"
        + (f"Hinweis: {explanation}\n" if explanation else "")
        + f"Verarbeitung: {data['processing']}\n"
        f"Audiolücken: {'vorhanden' if quality['has_audio_gaps'] else 'keine bekannten'}\n"
        f"Audio-Uhr: {clock}\n"
        f"Aufnahmeende: {'unbekannt' if quality['capture_end_unknown'] else 'bekannt'}\n"
        f"Sprecherzuordnung: {attribution}\n"
        f"Quellenabdeckung: {quality['source_coverage']}\n"
        f"Audioabschluss: {drain}\n"
        f"Verarbeitungsfehler: {failure}\n"
        f"Web-UI: {settings.api_url.rstrip('/')}/ui\n"
        + reader_ui_line
        + "Die vollständigen Qualitäts- und Zeitangaben stehen im JSON-Export.\n"
    )
    message.set_content(body)
    exports = {}
    for format in ("txt", "vtt", "json"):
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
        message.clear_content()
        message.set_content(body + "\nDie drei vollständigen Exporte liegen im ZIP-Anhang.\n")
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
            ui_link = f"{settings.api_url.rstrip('/')}/ui#token=wortlaut-read-{recording.id}.{sig}"
            message.clear_content()
            base_url = settings.api_url.rstrip("/") + f"/v1/recordings/{recording.id}/exports"
            downloads = "\n".join(
                f"curl --fail --header {shlex.quote('Authorization: Bearer ' + credential)} "
                f"{shlex.quote(base_url + '/' + format)} "
                f"--output 'wortlaut-{recording.id}.{format}'"
                for format in ("txt", "vtt", "json", "md")
            )
            message.set_content(
                body
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
