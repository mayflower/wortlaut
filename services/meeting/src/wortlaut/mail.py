"""One configured SMTP relay; durable acceptance, bounded explicit retries."""

import json
import smtplib
import ssl
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr

from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.exports import export_data, render_export
from wortlaut.models import Attempt, AudioChunk, AudioStream, CalendarEntry, Delivery, Recording
from wortlaut.settings import get_settings


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
    message["Subject"] = f"wortlaut: Aufnahme {recording.id}"
    period = data["scheduled_period"]
    body = (
        f"wortlaut\nTermin: {period['start']} bis {period['end']}\n"
        f"Letztes bekanntes Audio: {data['last_known_audio_utc'] or 'unbekannt'}\n"
        f"Teilnahme: {data['participation']}; "
        f"Grund: {data['participation_reason'] or 'unbekannt'}\n"
        f"Versuche: {json.dumps(data['attempts'], ensure_ascii=False)}\n"
        f"Verarbeitung: {data['processing']}\n"
        f"Aufnahmequalität: {json.dumps(data['quality'], ensure_ascii=False)}\n"
    )
    message.set_content(body)
    for format in ("txt", "vtt", "json"):
        content, media_type = render_export(data, format)
        major, minor = media_type.split(";", 1)[0].split("/", 1)
        message.add_attachment(
            content.encode(),
            maintype=major,
            subtype=minor,
            filename=f"wortlaut-{recording.id}.{format}",
        )
    if len(message.as_bytes()) > settings.mail_attachment_limit_bytes:
        message.clear_content()
        links = "\n".join(
            settings.api_url.rstrip("/") + f"/v1/recordings/{recording.id}/exports/{format}"
            for format in ("txt", "vtt", "json")
        )
        message.set_content(
            body + "\nErgebnisse per HTTPS mit Ihrem API-Bearer-Token abrufen:\n" + links
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
                    entry.organizer if entry else "default", []
                )
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
                if not has_audio or not recipients:
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
