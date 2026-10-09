"""Authenticated MIME/ICS intake and single occurrences; no provider URL fetches."""

import hashlib
import imaplib
import re
import ssl
from datetime import UTC, datetime
from email import policy
from email.parser import BytesParser
from urllib.parse import urlsplit

from icalendar import Calendar
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from wortlaut.controller import request_cancellation
from wortlaut.models import CalendarEntry, MailCursor, MailImport, Recording
from wortlaut.settings import get_settings
from wortlaut.validation import normalize_meeting_url

MAIL_LOCK = 749836125


class AmbiguousMeetingLink(ValueError):
    pass


def utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("timezone_required")
    return value.astimezone(UTC)


def sender(message):
    name = get_settings().trusted_sender_header
    if not name or len(message.get_all(name, [])) != 1:
        raise ValueError("authenticated_sender_missing")
    authenticated = str(message[name]).strip().lower()
    addresses = getattr(message.get("From"), "addresses", ())
    if len(addresses) != 1 or addresses[0].addr_spec.lower() != authenticated:
        raise ValueError("authenticated_sender_mismatch")
    if authenticated not in get_settings().organizer_permissions:
        raise ValueError("sender_not_allowed")
    return authenticated


def meeting_link(event, mail_text):
    fields = [
        str(event.get(key, ""))
        for key in ("URL", "LOCATION", "DESCRIPTION", "X-GOOGLE-CONFERENCE")
    ]
    # ICS is authoritative; the mail body is a fallback, not another event.
    for content in ("\n".join(fields), mail_text):
        candidates = set()
        for candidate in re.findall(r'https://[^\s<>"\']+', content):
            candidate = candidate.rstrip(".,;)")
            try:
                provider, target = normalize_meeting_url(candidate)
            except ValueError:
                continue
            path = urlsplit(target).path.lower()
            # Webex meeting URLs: personal rooms, modern MTID links and the
            # legacy meeting-center endpoint. Help/account links are not joins.
            if (
                provider == "google_meet"
                or path.startswith(("/meet/", "/m/", "/join/", "/wbxmjs/"))
                or re.match(r"^/webappng/sites/[^/]+/meeting/", path)
                or path.endswith("/j.php")
            ):
                candidates.add(target)
        if len(candidates) > 1:
            raise AmbiguousMeetingLink("meeting_link_ambiguous")
        if candidates:
            return candidates.pop()
    raise ValueError("meeting_link_missing")


def entry_json(entry, recording=None):
    provider = recording.provider if recording else None
    if provider is None and entry.original:
        try:
            event = Calendar.from_ical(entry.original).walk("VEVENT")[0]
            provider, _ = normalize_meeting_url(meeting_link(event, ""))
        except (ValueError, KeyError, IndexError, TypeError):
            pass  # A cancellation or an ambiguous invitation need not have a target.
    return {
        "id": str(entry.id),
        "uid": entry.uid,
        "organizer": entry.organizer,
        "recurrence_key": entry.recurrence_key,
        "sequence": entry.sequence,
        "dtstamp": entry.dtstamp.isoformat(),
        "status": entry.status,
        "reason": entry.reason,
        "recording_id": str(recording.id) if recording else None,
        "provider": provider,
    }


def import_event(db, calendar, event, authenticated, mail_text):
    settings = get_settings()
    uid = str(event.get("UID", ""))
    organizer = str(event.get("ORGANIZER", ""))
    if not organizer.lower().startswith("mailto:"):
        raise ValueError("organizer_invalid")
    organizer = organizer[7:].lower()
    if organizer not in settings.organizer_permissions[authenticated]:
        raise ValueError("organizer_not_allowed")
    if not uid or len(uid) > 512 or len(organizer) > 320:
        raise ValueError("calendar_identity_invalid")
    sequence = int(event.get("SEQUENCE", 0))
    if sequence < 0 or sequence > 2147483647:
        raise ValueError("sequence_invalid")
    stamp = utc(event.decoded("DTSTAMP"))
    method = str(calendar.get("METHOD", "")).upper()
    if method not in ("REQUEST", "CANCEL"):
        raise ValueError("method_unsupported")
    link_conflict = False
    if method == "REQUEST":
        starts, ends = utc(event.decoded("DTSTART")), utc(event.decoded("DTEND"))
        if ends <= starts:
            raise ValueError("calendar_end_invalid")
        # Include a validated body fallback in version equality too: otherwise
        # identical ICS with a changed body URL could silently replay old data.
        try:
            event["URL"] = meeting_link(event, mail_text)
        except AmbiguousMeetingLink:
            link_conflict = True
    recurrence = event.get("RECURRENCE-ID")
    recurrence_key = utc(recurrence.dt).isoformat() if recurrence else ""
    is_series = any(key in event for key in ("RRULE", "RDATE", "EXDATE"))
    single = Calendar()
    for key, value in calendar.items():
        single[key] = value
    for zone in calendar.walk("VTIMEZONE"):
        single.add_component(zone)
    single.add_component(event)
    original = single.to_ical().decode("utf-8")
    digest = hashlib.sha256(original.encode()).hexdigest()
    entry = db.scalar(
        select(CalendarEntry).where(
            CalendarEntry.mailbox == settings.mailbox_context,
            CalendarEntry.uid == uid,
            CalendarEntry.organizer == organizer,
            CalendarEntry.recurrence_key == recurrence_key,
        )
    )
    parent = entry
    if recurrence_key:
        parent = db.scalar(
            select(CalendarEntry).where(
                CalendarEntry.mailbox == settings.mailbox_context,
                CalendarEntry.uid == uid,
                CalendarEntry.organizer == organizer,
                CalendarEntry.recurrence_key == "",
            )
        )
        if parent and (sequence, stamp) < (parent.sequence, parent.dtstamp):
            return {**entry_json(parent), "import": "older_ignored"}
    recordings = (
        db.scalars(
            select(Recording)
            .where(
                Recording.calendar_entry_id == parent.id,
                *([Recording.recurrence_key == recurrence_key] if recurrence_key else []),
            )
            .with_for_update()
        ).all()
        if parent
        else []
    )
    recording = recordings[0] if recordings else None
    if entry:
        version, previous = (sequence, stamp), (entry.sequence, entry.dtstamp)
        if version < previous:
            return {**entry_json(entry, recording), "import": "older_ignored"}
        if version == previous:
            if digest != entry.digest:
                entry.status, entry.reason = "conflict", "same_version_conflict"
                entry.conflict_digest = digest
                for item in recordings:
                    if item.participation != "ended":
                        item.calendar_conflict = True
            return {**entry_json(entry, recording), "import": "replay"}
    else:
        entry = CalendarEntry(
            mailbox=settings.mailbox_context,
            uid=uid,
            organizer=organizer,
            recurrence_key=recurrence_key,
        )
        db.add(entry)
    # Preserve the original recurrence anchor across versions. Moving a master
    # requires remapping original occurrence identities, which is not supported.
    if entry.recurrence_anchor is None and entry.original and not recurrence_key:
        old_event = Calendar.from_ical(entry.original).walk("VEVENT")[0]
        if any(key in old_event for key in ("RRULE", "RDATE", "EXDATE")):
            entry.recurrence_anchor = recurrence_anchor(old_event)
    entry.sequence, entry.dtstamp, entry.digest, entry.original = sequence, stamp, digest, original
    entry.conflict_digest = entry.reason = None
    if recurrence and recurrence.params.get("RANGE"):
        entry.status, entry.reason = "unsupported", "thisandfuture_unsupported"
        if parent:
            for item in db.scalars(
                select(Recording)
                .where(Recording.calendar_entry_id == parent.id, Recording.participation != "ended")
                .with_for_update()
            ):
                item.calendar_conflict = True
            parent.status, parent.reason = "unsupported", "thisandfuture_unsupported"
        db.flush()
        return entry_json(entry, recording)
    if method == "CANCEL":
        entry.status = "cancelled"
        for item in recordings:
            request_cancellation(item, datetime.now(UTC))
        db.flush()
        return entry_json(entry, recording)
    if link_conflict:
        entry.status, entry.reason = "conflict", "meeting_link_ambiguous"
        for item in recordings:
            if item.participation != "ended":
                item.calendar_conflict = True
        db.flush()
        return entry_json(entry, recording)
    if (
        not recurrence_key
        and entry.recurrence_anchor is not None
        and (not is_series or entry.recurrence_anchor != recurrence_anchor(event))
    ):
        for item in recordings:
            if item.participation != "ended":
                item.calendar_conflict = True
        entry.status, entry.reason = "unsupported", "series_anchor_change_unsupported"
        db.flush()
        return entry_json(entry, recording)
    if recurrence or is_series:
        if is_series and not recurrence_key:
            entry.recurrence_anchor = recurrence_anchor(event)
        for item in recordings:
            if item.participation != "ended":
                item.calendar_conflict = True
        entry.status, entry.reason = "not_expanded", "recurrence_pending"
        db.flush()
        return entry_json(entry, recording)
    starts = utc(event.decoded("DTSTART"))
    ends = utc(event.decoded("DTEND"))
    if ends <= starts:
        raise ValueError("calendar_end_invalid")
    link = meeting_link(event, mail_text)
    provider, link = normalize_meeting_url(link)
    entry.status = "accepted"
    db.flush()
    if recording:
        if recording.participation == "ended":
            entry.reason = "historical_unchanged"
        elif recording.active_attempt_id and (
            recording.starts_at != starts
            or recording.meeting_url != link
            or recording.provider != provider
            or recording.ends_at != ends
        ):
            entry.status, entry.reason = "conflict", "active_change_conflict"
            recording.calendar_conflict = True
        else:
            recording.starts_at, recording.ends_at, recording.meeting_url = starts, ends, link
            recording.provider = provider
            recording.calendar_conflict = False
    else:
        recording = Recording(
            calendar_entry_id=entry.id,
            recurrence_key="",
            idempotency_key="calendar-" + entry.id.hex,
            request_digest=digest,
            meeting_url=link,
            provider=provider,
            starts_at=starts,
            ends_at=ends,
        )
        db.add(recording)
        db.flush()
    return entry_json(entry, recording)


def recurrence_anchor(event):
    start = event["DTSTART"]
    return start.to_ical().decode("ascii") + "|" + str(start.params.get("TZID", ""))


def import_mail(db, raw):
    if len(raw) > get_settings().max_mail_bytes:
        return [{"status": "rejected", "reason": "mail_too_large"}]
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
        if message.defects:
            raise ValueError("mime_invalid")
        authenticated = sender(message)
        parts = list(message.walk())
        mail_text = "\n".join(
            str(part.get_content())
            for part in parts
            if part.get_content_type() in ("text/plain", "text/html")
        )
        calendars = [
            Calendar.from_ical(part.get_payload(decode=True))
            for part in parts
            if part.get_content_type() == "text/calendar"
        ]
        if not calendars or not any(c.walk("VEVENT") for c in calendars):
            raise ValueError("calendar_missing")
        if sum(len(c.walk("VEVENT")) for c in calendars) > 128:
            raise ValueError("too_many_calendar_events")
    except (ValueError, KeyError, TypeError, UnicodeError):
        return [{"status": "rejected", "reason": "invalid_or_unauthorized_mail"}]
    results = []
    db.execute(text(f"SELECT pg_advisory_xact_lock({MAIL_LOCK})"))
    for calendar in calendars:
        for event in calendar.walk("VEVENT"):
            try:
                with db.begin_nested():
                    result = import_event(db, calendar, event, authenticated, mail_text)
                results.append(result)
            except (ValueError, KeyError, TypeError, UnicodeError):
                results.append({"status": "rejected", "reason": "invalid_or_unauthorized_event"})
    return results


def consume_imap_message(db, uidvalidity, uid, raw):
    mailbox = get_settings().mailbox_context
    db.execute(text(f"SELECT pg_advisory_xact_lock({MAIL_LOCK})"))
    cursor = db.get(MailCursor, mailbox)
    if cursor is None:
        cursor = MailCursor(mailbox=mailbox, uidvalidity=uidvalidity, last_uid=0)
        db.add(cursor)
    elif cursor.uidvalidity != uidvalidity:
        cursor.uidvalidity, cursor.last_uid = uidvalidity, 0
    existing = db.scalar(
        select(MailImport).where(
            MailImport.mailbox == mailbox,
            MailImport.uidvalidity == uidvalidity,
            MailImport.message_uid == uid,
        )
    )
    if existing:
        return existing.result
    result = import_mail(db, raw)
    db.add(MailImport(mailbox=mailbox, uidvalidity=uidvalidity, message_uid=uid, result=result))
    cursor.last_uid = max(cursor.last_uid, uid)
    db.flush()
    return result


def imap_pass(engine):
    settings = get_settings()
    if not settings.imap_host or not settings.imap_username or not settings.imap_password:
        raise ValueError("IMAP credentials missing")
    if not settings.trusted_sender_header or not settings.organizer_permissions:
        raise ValueError("Trusted gateway configuration missing")
    with imaplib.IMAP4_SSL(
        settings.imap_host,
        settings.imap_port,
        ssl_context=ssl.create_default_context(),
        timeout=15,
    ) as mailbox:
        mailbox.login(settings.imap_username, settings.imap_password.get_secret_value())
        if mailbox.select(settings.imap_folder, readonly=True)[0] != "OK":
            raise ValueError("IMAP folder unavailable")
        validity = int(mailbox.response("UIDVALIDITY")[1][0])
        with Session(engine) as db:
            cursor = db.get(MailCursor, settings.mailbox_context)
            last = cursor.last_uid if cursor and cursor.uidvalidity == validity else 0
        status, response = mailbox.uid("SEARCH", None, "UID", f"{last + 1}:*")
        if status != "OK":
            raise ValueError("IMAP search failed")
        for uid in sorted(int(n) for n in response[0].split() if int(n) > last)[:32]:
            status, items = mailbox.uid("FETCH", str(uid), "(RFC822.SIZE)")
            if status != "OK":
                raise ValueError("IMAP metadata fetch failed")
            size = re.search(
                rb"RFC822.SIZE (\d+)", b" ".join(i for i in items if isinstance(i, bytes))
            )
            if not size:
                raise ValueError("IMAP message size missing")
            if int(size[1]) > settings.max_mail_bytes:
                raw = b"x" * (settings.max_mail_bytes + 1)
            else:
                status, items = mailbox.uid("FETCH", str(uid), "(BODY.PEEK[])")
                if status != "OK":
                    raise ValueError("IMAP message fetch failed")
                raw = next((i[1] for i in items if isinstance(i, tuple)), None)
                if raw is None:
                    raise ValueError("IMAP message vanished; progress not advanced")
            with Session(engine) as db:
                consume_imap_message(db, validity, uid, raw)
                db.commit()
