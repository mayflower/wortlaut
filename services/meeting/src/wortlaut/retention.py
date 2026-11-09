"""Finite retry/audio retention, independent of worker-process termination."""

from datetime import UTC, datetime, timedelta

import recurring_ical_events
from icalendar import Calendar
from sqlalchemy import delete, or_, select, text
from sqlalchemy.orm import Session

from wortlaut.calendar import MAIL_LOCK
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    CalendarEntry,
    Delivery,
    MailImport,
    Recording,
    TranscriptSegment,
)
from wortlaut.settings import get_settings
from wortlaut.storage import get_storage


def remove_audio_metadata(db, recording, stream_ids, now):
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    if recording.participation != "ended" or any(a.process_ended_at is None for a in attempts):
        return  # Do not erase diagnostics needed to reconcile a possibly live worker.
    delivery = db.get(Delivery, recording.id)
    if delivery and delivery.status == "sending":
        return  # The SMTP result can still update its recipient metadata.
    jobs = select(AsrJob.id).where(AsrJob.stream_id.in_(stream_ids))
    db.execute(delete(TranscriptSegment).where(TranscriptSegment.id.in_(jobs)))
    db.execute(delete(AsrJob).where(AsrJob.stream_id.in_(stream_ids)))
    db.execute(delete(AudioControl).where(AudioControl.stream_id.in_(stream_ids)))
    db.execute(delete(AudioChunk).where(AudioChunk.stream_id.in_(stream_ids)))
    db.execute(delete(AudioStream).where(AudioStream.id.in_(stream_ids)))
    for attempt in attempts:
        attempt.diagnostics = {}
        attempt.worker_id = attempt.audio_connection_id = None
    if delivery:
        delivery.recipients = delivery.accepted_recipients = []
        delivery.refused_codes = {}
    recording.meeting_url = ""
    recording.title = None
    recording.guest_name = None
    recording.owner_sub = None
    recording.owner_email = None
    recording.export_reader_nonce = None
    recording.metadata_deleted_at = now


def calendar_retention(engine, now):
    # Calendar import and series expansion take this lock before recording locks.
    # Run separately so metadata cleanup cannot invert that lock order.
    with Session(engine) as db:
        if not db.scalar(text(f"SELECT pg_try_advisory_xact_lock({MAIL_LOCK})")):
            return
        entries = db.scalars(
            select(CalendarEntry).where(
                CalendarEntry.recurrence_key == "",
                select(Recording.id)
                .where(
                    Recording.calendar_entry_id == CalendarEntry.id,
                    Recording.metadata_deleted_at.is_not(None),
                )
                .exists(),
            )
        ).all()
        retained_ids = set()
        for entry in entries:
            family = db.scalars(
                select(CalendarEntry).where(
                    CalendarEntry.mailbox == entry.mailbox,
                    CalendarEntry.uid == entry.uid,
                    CalendarEntry.organizer == entry.organizer,
                )
            ).all()
            retained_ids.update(str(item.id) for item in family)
            needed = db.scalar(
                select(Recording.id)
                .where(
                    Recording.calendar_entry_id == entry.id,
                    Recording.metadata_deleted_at.is_(None),
                )
                .limit(1)
            )
            calendars = [
                (item, Calendar.from_ical(item.original)) for item in family if item.original
            ]
            future = False
            if entry.recurrence_anchor and entry.status != "cancelled" and entry.original:
                source = Calendar.from_ical(entry.original)
                for item, calendar in calendars:
                    if item.recurrence_key and item.status != "cancelled":
                        source.add_component(calendar.walk("VEVENT")[0])
                future = next(recurring_ical_events.of(source).after(now), None) is not None
            for item, calendar in calendars:
                if needed is None and not future:
                    item.original = ""
                    continue
                # Keep the actual recurrence/timezone/link contract, without
                # attendees, names, descriptions, attachments or alarm contents.
                for event in calendar.walk("VEVENT"):
                    for key in list(event):
                        if key not in {
                            "UID",
                            "ORGANIZER",
                            "SEQUENCE",
                            "DTSTAMP",
                            "DTSTART",
                            "DTEND",
                            "DURATION",
                            "RECURRENCE-ID",
                            "RRULE",
                            "RDATE",
                            "EXDATE",
                            "STATUS",
                            "URL",
                        }:
                            del event[key]
                    if "ORGANIZER" in event:
                        event["ORGANIZER"].params.clear()
                    event.subcomponents = []
                for key in list(calendar):
                    if key not in {"VERSION", "METHOD", "CALSCALE"}:
                        del calendar[key]
                calendar["PRODID"] = "-//wortlaut//retained schedule//EN"
                item.original = calendar.to_ical().decode("utf-8")
        # Cached IMAP import replies contain organizer metadata too. The cursor
        # and unique message identity remain the replay tombstone.
        cached = (
            db.scalars(
                select(MailImport).where(
                    or_(*(MailImport.result.contains([{"id": value}]) for value in retained_ids))
                )
            )
            if retained_ids
            else []
        )
        for imported in cached:
            minimized = []
            for result in imported.result:
                identifier = result.get("id")
                if identifier in retained_ids:
                    result = {key: value for key, value in result.items() if key != "organizer"}
                minimized.append(result)
            if minimized != imported.result:
                imported.result = minimized
        db.commit()


def retention_pass(engine):
    now, settings = datetime.now(UTC), get_settings()
    with Session(engine) as db:
        identifiers = db.scalars(
            select(Recording.id)
            .where(
                Recording.audio_deleted_at.is_(None)
                | Recording.transcript_deleted_at.is_(None)
                | Recording.metadata_deleted_at.is_(None),
                (Recording.ends_at < now - timedelta(hours=settings.processing_max_age_hours))
                | (Recording.processing_finished_at.is_not(None)),
            )
            .order_by(Recording.ends_at)
        ).all()
    for identifier in identifiers:
        with Session(engine) as db:
            recording = db.scalar(
                select(Recording)
                .where(Recording.id == identifier)
                .with_for_update(skip_locked=True)
            )
            if recording is None:
                continue
            streams = db.scalars(
                select(AudioStream)
                .join(Attempt)
                .where(Attempt.recording_id == recording.id)
                .with_for_update(of=AudioStream)
            ).all()
            stream_ids = [s.id for s in streams]
            if recording.processing not in ("completed", "failed"):
                # This closes capture/processing, not the remote process. Its
                # exclusive claim remains blocked until actual termination proof.
                recording.audio_closed_at = recording.processing_finished_at = now
                recording.processing = "failed"
                recording.processing_error = "audio_retention_expired"
                for stream in streams:
                    stream.scan_complete = True
                jobs = db.scalars(
                    select(AsrJob)
                    .where(
                        AsrJob.stream_id.in_(stream_ids),
                        AsrJob.status.in_(["pending", "processing"]),
                    )
                    .with_for_update()
                ).all()
                for job in jobs:
                    job.status, job.error, job.retry_at = "failed", "audio_retention_expired", None
                db.commit()  # Publish abandonment before any audio deletion.
                continue
            finished = recording.processing_finished_at
            if finished is None:
                recording.processing_finished_at = now
                db.commit()
                continue
            hours = (
                settings.audio_retention_hours
                if recording.processing == "completed"
                else settings.failed_audio_retention_hours
            )
            if not recording.audio_deleted_at and now >= finished + timedelta(hours=hours):
                recording.audio_closed_at = recording.audio_closed_at or now
                get_storage().delete_recording(recording.id)
                chunks = db.scalars(select(AudioChunk).where(AudioChunk.stream_id.in_(stream_ids)))
                for chunk in chunks:
                    chunk.deleted_at = now
                recording.audio_deleted_at = now
            if not recording.transcript_deleted_at and now >= finished + timedelta(
                days=settings.transcript_retention_days
            ):
                ids = select(AsrJob.id).where(AsrJob.stream_id.in_(stream_ids))
                db.execute(delete(TranscriptSegment).where(TranscriptSegment.id.in_(ids)))
                recording.transcript_deleted_at = now
            if (
                recording.metadata_deleted_at is None
                and recording.audio_deleted_at is not None
                and recording.transcript_deleted_at is not None
            ):
                remove_audio_metadata(db, recording, stream_ids, now)
            db.commit()
    calendar_retention(engine, now)
