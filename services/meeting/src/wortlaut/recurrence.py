"""Bounded iCalendar materialization through recurring-ical-events."""

import hashlib
from datetime import UTC, datetime, timedelta
from itertools import islice, takewhile

import recurring_ical_events
from icalendar import Calendar
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from wortlaut.calendar import MAIL_LOCK, meeting_link, utc
from wortlaut.controller import request_cancellation
from wortlaut.models import CalendarEntry, Recording
from wortlaut.settings import get_settings
from wortlaut.validation import normalize_meeting_url


def expand_series(db, entry, now):
    if not entry.original:
        return  # Retained calendar identity, with expired invitation contents.
    settings = get_settings()
    if entry.reason == "series_anchor_change_unsupported":
        return
    source = Calendar.from_ical(entry.original)
    master = source.walk("VEVENT")[0]
    if not any(key in master for key in ("RRULE", "RDATE", "EXDATE")):
        return
    overrides = db.scalars(
        select(CalendarEntry).where(
            CalendarEntry.mailbox == entry.mailbox,
            CalendarEntry.organizer == entry.organizer,
            CalendarEntry.uid == entry.uid,
            CalendarEntry.recurrence_key != "",
        )
    ).all()
    overrides = [
        override
        for override in overrides
        if (override.sequence, override.dtstamp) >= (entry.sequence, entry.dtstamp)
    ]
    recordings = db.scalars(
        select(Recording)
        .where(
            Recording.calendar_entry_id == entry.id,
        )
        .with_for_update()
    ).all()
    rule = master.get("RRULE", {})
    if rule and (
        str(rule.get("FREQ", [""])[0]) not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY")
        or any(len(rule.get(key, [])) > 1 for key in ("BYHOUR", "BYMINUTE", "BYSECOND"))
    ):
        entry.status, entry.reason = "unsupported", "high_frequency_unsupported"
        for recording in recordings:
            if recording.participation != "ended":
                recording.calendar_conflict = True
        return
    if entry.status == "cancelled":
        for recording in recordings:
            request_cancellation(recording, now)
        return
    if entry.status == "conflict":
        return
    cancelled, conflicted = set(), set()
    for override in overrides:
        event = Calendar.from_ical(override.original).walk("VEVENT")[0]
        recurrence = event.get("RECURRENCE-ID")
        if recurrence and recurrence.params.get("RANGE"):
            entry.status, entry.reason = "unsupported", "thisandfuture_unsupported"
            for recording in recordings:
                if recording.participation != "ended":
                    recording.calendar_conflict = True
            return
        if override.status == "cancelled":
            cancelled.add(override.recurrence_key)
        elif override.status == "conflict":
            conflicted.add(override.recurrence_key)
        else:
            source.add_component(event)
    limit = settings.max_occurrences_per_series
    cutoff = now + timedelta(days=settings.calendar_horizon_days)
    # The library produces the original RECURRENCE-ID even after an override
    # moves DTSTART. Use its generator so malicious secondly rules are bounded.
    query = recurring_ical_events.of(source)
    events = list(
        islice(
            takewhile(lambda event: utc(event.decoded("DTSTART")) < cutoff, query.after(now)),
            limit + 1,
        )
    )
    if len(events) > limit:
        entry.status, entry.reason = "unsupported", "occurrence_limit"
        for recording in recordings:
            if recording.participation != "ended":
                recording.calendar_conflict = True
        return
    desired = {}
    for event in events:
        key = utc(event.decoded("RECURRENCE-ID")).isoformat()
        if key not in cancelled:
            desired[key] = event
    existing = {r.recurrence_key: r for r in recordings}
    for override in overrides:
        if (
            override.recurrence_key in existing
            and override.recurrence_key not in cancelled | conflicted
        ):
            desired[override.recurrence_key] = Calendar.from_ical(override.original).walk("VEVENT")[
                0
            ]
    entry.status, entry.reason = "expanded", None
    for key, event in desired.items():
        starts, ends = utc(event.decoded("DTSTART")), utc(event.decoded("DTEND"))
        provider, link = normalize_meeting_url(meeting_link(event, ""))
        title = " ".join(str(event.get("SUMMARY", "")).split())[:200] or None
        recording = existing.get(key)
        if key in conflicted:
            if recording:
                recording.calendar_conflict = True
            entry.reason = "occurrence_conflict"
            continue
        if recording is None:
            identifier = hashlib.sha256((entry.id.hex + "/" + key).encode()).hexdigest()
            db.add(
                Recording(
                    calendar_entry_id=entry.id,
                    recurrence_key=key,
                    idempotency_key="occurrence-" + identifier,
                    request_digest=identifier,
                    meeting_url=link,
                    provider=provider,
                    title=title,
                    starts_at=starts,
                    ends_at=ends,
                )
            )
        elif recording.participation == "ended" and recording.cancelled_at is None:
            continue
        elif recording.active_attempt_id:
            if recording.participation != "ended" and (
                recording.starts_at != starts
                or recording.ends_at != ends
                or recording.meeting_url != link
                or recording.provider != provider
            ):
                recording.calendar_conflict = True
                entry.reason = "active_occurrence_conflict"
            elif recording.participation != "ended":
                recording.calendar_conflict = False
        else:
            # No historical worker attempt exists: an explicitly restored
            # future occurrence can reuse its original row safely.
            recording.starts_at, recording.ends_at, recording.meeting_url = starts, ends, link
            recording.provider = provider
            recording.title = title
            recording.calendar_conflict = False
            if recording.cancelled_at and ends > now:
                recording.cancelled_at = recording.audio_closed_at = None
                recording.processing_finished_at = None
                recording.processing_error = recording.participation_reason = None
                recording.participation, recording.processing = "scheduled", "pending"
    for key, recording in existing.items():
        if key not in desired and now <= recording.starts_at < cutoff:
            request_cancellation(recording, now)
    db.flush()


def recurrence_pass(engine, now=None):
    now = now or datetime.now(UTC)
    with Session(engine) as db:
        if not db.scalar(text(f"SELECT pg_try_advisory_xact_lock({MAIL_LOCK})")):
            return
        entries = db.scalars(select(CalendarEntry).where(CalendarEntry.recurrence_key == "")).all()
        for entry in entries:
            try:
                with db.begin_nested():
                    expand_series(db, entry, now)
            except (ValueError, TypeError, KeyError, OverflowError):
                entry.status, entry.reason = "unsupported", "recurrence_invalid"
                for recording in db.scalars(
                    select(Recording)
                    .where(
                        Recording.calendar_entry_id == entry.id,
                        Recording.participation != "ended",
                    )
                    .with_for_update()
                ):
                    recording.calendar_conflict = True
        db.commit()
