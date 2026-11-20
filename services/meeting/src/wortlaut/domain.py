"""Shared domain service functions used by both the REST API (app.py) and MCP server."""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from wortlaut.calendar import entry_json
from wortlaut.calendar_oauth import connection_json, synced_event_json
from wortlaut.controller import request_cancellation
from wortlaut.languages import normalize_asr_language
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioControl,
    AudioStream,
    CalendarConnection,
    CalendarEntry,
    CalendarSyncedEvent,
    Recording,
    TranscriptSegment,
)
from wortlaut.oidc import Principal, can_access_recording, user_recording_access_predicate


def apply_recordings_search_filters(
    stmt: Any,
    *,
    principal: Principal,
    provider: str | None = None,
    participation: str | None = None,
    processing: str | None = None,
    q: str | None = None,
    include_attempt_diagnostics: bool = False,
) -> tuple[Any, bool]:
    """Apply shared RBAC, provider, state, and full-text/speaker filters to a Recording SELECT."""
    unstarted_cancelled_cal = and_(
        Recording.idempotency_key.like("cal-oauth-%"),
        Recording.participation == "ended",
        Recording.participation_reason == "cancelled",
        ~select(Attempt.id).where(Attempt.recording_id == Recording.id).exists(),
    )
    stmt = stmt.where(~unstarted_cancelled_cal)
    if not principal.is_admin:
        pred = user_recording_access_predicate(principal)
        if pred is False:
            return stmt, True
        stmt = stmt.where(pred)
    if provider:
        stmt = stmt.where(Recording.provider == str(provider))
    if participation:
        parts = [p.strip() for p in participation.split(",") if p.strip()]
        if len(parts) == 1:
            stmt = stmt.where(Recording.participation == parts[0])
        elif parts:
            stmt = stmt.where(Recording.participation.in_(parts))
    if processing:
        stmt = stmt.where(Recording.processing == processing)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        segment_match = (
            select(TranscriptSegment.id)
            .join(AsrJob, AsrJob.id == TranscriptSegment.id)
            .join(AudioStream, AudioStream.id == AsrJob.stream_id)
            .join(Attempt, Attempt.id == AudioStream.attempt_id)
            .where(
                Attempt.recording_id == Recording.id,
                or_(
                    TranscriptSegment.result["text"].astext.ilike(needle),
                    TranscriptSegment.result["participant_name"].astext.ilike(needle),
                    TranscriptSegment.result["speaker_id"].astext.ilike(needle),
                ),
            )
            .exists()
        )
        stream_match = (
            select(AudioStream.id)
            .join(Attempt, Attempt.id == AudioStream.attempt_id)
            .outerjoin(AudioControl, AudioControl.stream_id == AudioStream.id)
            .where(
                Attempt.recording_id == Recording.id,
                or_(
                    AudioStream.contract["participant_name"].astext.ilike(needle),
                    AudioStream.contract["speaker_id"].astext.ilike(needle),
                    AudioControl.contract["participant_name"].astext.ilike(needle),
                ),
            )
            .exists()
        )
        text_clauses = [
            Recording.title.ilike(needle),
            Recording.guest_name.ilike(needle),
            segment_match,
            stream_match,
        ]
        if include_attempt_diagnostics:
            attempt_match = (
                select(Attempt.id)
                .where(
                    Attempt.recording_id == Recording.id,
                    or_(
                        Attempt.diagnostics["receiver_sources"].astext.ilike(needle),
                        Attempt.diagnostics["participant_sources"].astext.ilike(needle),
                    ),
                )
                .exists()
            )
            text_clauses.append(attempt_match)
        stmt = stmt.where(or_(*text_clauses))
    return stmt, False


def cancel_recording_and_unlink_calendar(
    db: Session,
    recording_id: uuid.UUID,
    now: datetime,
) -> Recording | None:
    """Cancel a recording while locking CalendarSyncedEvent BEFORE Recording (canonical order)."""
    synced_for_rec = db.scalars(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.recording_id == recording_id)
        .order_by(CalendarSyncedEvent.id.asc())
        .with_for_update()
    ).all()
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None:
        return None
    request_cancellation(recording, now)
    for sev in synced_for_rec:
        sev.recording_id = None
        sev.user_override = False
        sev.auto_record = False
    return recording


def apply_protocol_metadata_fields(
    recording: Recording,
    meta: dict[str, Any],
    *,
    title: str | None = None,
    has_title: bool = False,
    language: str | None = None,
    has_language: bool = False,
    notes: str | None = None,
    has_notes: bool = False,
    speaker_overrides: dict[str, str] | None = None,
    term_replacements: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Apply shared title, ASR language, notes, speaker_overrides, and term_replacements edits."""
    if has_title and title is not None:
        recording.title = " ".join(str(title).split())[:200] or None
    if has_language and language is not None:
        raw_lang = str(language).strip()
        if not raw_lang:
            meta.pop("asr_language", None)
        else:
            norm_lang = normalize_asr_language(raw_lang)
            if norm_lang:
                meta["asr_language"] = norm_lang
            else:
                meta.pop("asr_language", None)
    if has_notes and notes is not None:
        meta["notes"] = str(notes)[:20000]
    if speaker_overrides is not None:
        cur_speakers = dict(meta.get("speaker_overrides") or {})
        for k, v in speaker_overrides.items():
            key = str(k).strip()[:200]
            if not key:
                continue
            val = str(v).strip()[:120]
            if val:
                cur_speakers[key] = val
            else:
                cur_speakers.pop(key, None)
        meta["speaker_overrides"] = cur_speakers
    if term_replacements is not None:
        cur_terms = dict(meta.get("term_replacements") or {})
        for k, v in term_replacements.items():
            key = str(k).strip()[:120]
            if not key:
                continue
            val = str(v).strip()[:120]
            if val and val != key:
                cur_terms[key] = val
            else:
                cur_terms.pop(key, None)
        meta["term_replacements"] = cur_terms
    return meta


def query_calendar_overview(
    db: Session,
    principal: Principal,
    now: datetime,
    *,
    include_past: bool = True,
    synced_upcoming_limit: int = 200,
    synced_past_limit: int = 50,
    ics_limit: int = 128,
    match_unlinked_urls: bool = True,
) -> dict[str, list[dict[str, Any]]]:
    """Batch-load calendar connections, synced OAuth events, and .ics entries."""
    cal_query = select(CalendarEntry).order_by(CalendarEntry.dtstamp.desc())
    conn_query = select(CalendarConnection).order_by(CalendarConnection.created_at.desc())
    synced_base = select(CalendarSyncedEvent)
    user_email = (principal.email or "").lower()
    if principal.kind != "operator":
        conn_query = conn_query.where(func.lower(CalendarConnection.owner_email) == user_email)
        synced_base = synced_base.where(func.lower(CalendarSyncedEvent.owner_email) == user_email)
    if not principal.is_admin:
        cal_query = cal_query.where(func.lower(CalendarEntry.organizer) == user_email)

    entries = db.scalars(cal_query.limit(ics_limit)).all()
    entry_ids = [e.id for e in entries]
    recs_by_entry: dict[uuid.UUID, list[Recording]] = {}
    if entry_ids:
        for r in db.scalars(
            select(Recording).where(Recording.calendar_entry_id.in_(entry_ids))
        ).all():
            if r.calendar_entry_id is not None:
                recs_by_entry.setdefault(r.calendar_entry_id, []).append(r)

    ics_items: list[dict[str, Any]] = []
    for entry in entries:
        recordings = recs_by_entry.get(entry.id, [])
        item = entry_json(entry, recordings[0] if len(recordings) == 1 else None)
        item["recording_ids"] = [str(r.id) for r in recordings]
        if not include_past and item.get("ends_at"):
            try:
                if datetime.fromisoformat(item["ends_at"]) < now:
                    continue
            except ValueError:
                pass
        ics_items.append(item)

    def _ics_sort_key(item: dict[str, Any]) -> tuple[int, float]:
        if item["starts_at"] is None or item["ends_at"] is None:
            return (2, -datetime.fromisoformat(item["dtstamp"]).timestamp())
        starts_dt = datetime.fromisoformat(item["starts_at"])
        ends_dt = datetime.fromisoformat(item["ends_at"])
        if ends_dt < now:
            return (1, -starts_dt.timestamp())
        return (0, starts_dt.timestamp())

    ics_items.sort(key=_ics_sort_key)

    connections = [connection_json(c) for c in db.scalars(conn_query).all()]
    if include_past and synced_past_limit > 0:
        upcoming_rows = db.scalars(
            synced_base.where(CalendarSyncedEvent.ends_at >= now)
            .order_by(CalendarSyncedEvent.starts_at.asc())
            .limit(synced_upcoming_limit)
        ).all()
        past_rows = db.scalars(
            synced_base.where(
                CalendarSyncedEvent.ends_at >= now - timedelta(days=7),
                CalendarSyncedEvent.ends_at < now,
            )
            .order_by(CalendarSyncedEvent.starts_at.desc())
            .limit(synced_past_limit)
        ).all()
        synced_rows = [*upcoming_rows, *past_rows]
    else:
        cutoff = now - timedelta(days=7) if include_past else now
        synced_rows = db.scalars(
            synced_base.where(CalendarSyncedEvent.ends_at >= cutoff)
            .order_by(CalendarSyncedEvent.starts_at.asc())
            .limit(synced_upcoming_limit)
        ).all()

    rec_ids = [ev.recording_id for ev in synced_rows if ev.recording_id]
    rec_map = (
        {r.id: r for r in db.scalars(select(Recording).where(Recording.id.in_(rec_ids))).all()}
        if rec_ids
        else {}
    )
    url_candidates: dict[str, list[Recording]] = {}
    if match_unlinked_urls:
        unlinked_urls = {
            ev.meeting_url
            for ev in synced_rows
            if (not ev.recording_id or ev.recording_id not in rec_map) and ev.meeting_url
        }
        if unlinked_urls:
            for cand in db.scalars(
                select(Recording)
                .where(
                    Recording.meeting_url.in_(unlinked_urls),
                    Recording.metadata_deleted_at.is_(None),
                    Recording.cancelled_at.is_(None),
                )
                .order_by(Recording.starts_at.desc())
            ).all():
                url_candidates.setdefault(cand.meeting_url, []).append(cand)

    synced_events: list[dict[str, Any]] = []
    for ev in synced_rows:
        rec = rec_map.get(ev.recording_id) if ev.recording_id else None
        if rec is None and match_unlinked_urls and ev.meeting_url:
            for cand in url_candidates.get(ev.meeting_url, ()):
                if (
                    cand.starts_at <= ev.ends_at + timedelta(hours=1)
                    and cand.ends_at >= ev.starts_at - timedelta(hours=1)
                    and can_access_recording(db, principal, cand)
                ):
                    rec = cand
                    break
        synced_events.append(synced_event_json(ev, rec))

    return {
        "events": ics_items,
        "connections": connections,
        "synced_events": synced_events,
    }


_BERLIN_TZ = ZoneInfo("Europe/Berlin")


def parse_date_bound(raw: Any, field_name: str, *, is_upper: bool) -> datetime | None:
    """Parse YYYY-MM-DD (Europe/Berlin day boundary) or ISO-8601 datetime into UTC."""
    if raw is None:
        return None
    val = str(raw).strip()
    if not val:
        return None
    if len(val) == 10 and val[4] == "-" and val[7] == "-":
        try:
            d = date.fromisoformat(val)
        except ValueError:
            raise ValueError(
                f"{field_name} must be YYYY-MM-DD or ISO-8601 datetime (got {val!r})."
            ) from None
        local_dt = datetime.combine(
            d,
            time(23, 59, 59, 999999) if is_upper else time(0, 0, 0),
            tzinfo=_BERLIN_TZ,
        )
        return local_dt.astimezone(UTC)
    try:
        dt = datetime.fromisoformat(val)
    except ValueError:
        raise ValueError(
            f"{field_name} must be YYYY-MM-DD or ISO-8601 datetime (got {val!r})."
        ) from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_BERLIN_TZ)
    return dt.astimezone(UTC)
