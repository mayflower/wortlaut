"""OAuth2 Read-Only Calendar Integration for Google Calendar & Microsoft Graph."""

import base64
import hashlib
import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from wortlaut.controller import request_cancellation
from wortlaut.ingest import capacity_reached
from wortlaut.models import CalendarConnection, CalendarSyncedEvent, Recording
from wortlaut.oidc import Principal
from wortlaut.settings import get_settings
from wortlaut.validation import normalize_meeting_url

CalendarOAuthProvider = Literal["google", "microsoft"]

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CALENDAR_EVENTS_URL = (
    "https://www.googleapis.com/calendar/v3/calendars/primary/events"
)
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _microsoft_token_url(tenant_id: str) -> str:
    tenant = (tenant_id or "common").strip()
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"


MICROSOFT_CALENDAR_VIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView"
MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me"


def _fernet() -> Fernet:
    secret = get_settings().api_token.get_secret_value().encode("utf-8")
    digest = hashlib.sha256(b"wortlaut-cal-oauth-v1:" + secret).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("stored_oauth_token_invalid") from exc


def extract_conference_target(texts: list[str]) -> tuple[str, str] | None:
    """Find the first valid Google Meet, Microsoft Teams, or Cisco Webex join link."""
    for content in texts:
        if not content:
            continue
        for candidate in re.findall(r'https://[^\s<>"\']+', content):
            candidate = candidate.rstrip(".,;)>]")
            try:
                provider, target = normalize_meeting_url(candidate)
            except ValueError:
                continue
            path = urlsplit(target).path.lower()
            if (
                provider in ("google_meet", "teams")
                or path.startswith(("/meet/", "/m/", "/join/", "/wbxmjs/"))
                or re.match(r"^/webappng/sites/[^/]+/meeting/", path)
                or path.endswith("/j.php")
            ):
                return provider, target
    return None


def _parse_iso_datetime(value: str | None, default_tz: str | None = None) -> datetime | None:
    if not value or "T" not in value:
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        tz = UTC
        if default_tz and default_tz.upper() != "UTC":
            try:
                tz = ZoneInfo(default_tz)
            except (ZoneInfoNotFoundError, ValueError):
                tz = UTC
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(UTC)


def _decode_jwt_email(id_token: str | None) -> str | None:
    if not id_token or id_token.count(".") != 2:
        return None
    try:
        payload_b64 = id_token.split(".")[1]
        pad = "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64 + pad).decode("utf-8"))
        for key in ("email", "preferred_username", "upn"):
            val = claims.get(key)
            if isinstance(val, str) and "@" in val:
                return val.strip().lower()
    except Exception:
        return None
    return None


def _effective_owner_email(principal: Principal) -> str:
    if principal.email:
        return principal.email.strip().lower()
    return "operator@local"


def connection_json(conn: CalendarConnection) -> dict:
    return {
        "id": str(conn.id),
        "provider": conn.provider,
        "account_email": conn.account_email,
        "owner_email": conn.owner_email,
        "last_synced_at": conn.last_synced_at.isoformat() if conn.last_synced_at else None,
        "sync_error": conn.sync_error,
        "created_at": conn.created_at.isoformat() if conn.created_at else None,
    }


def synced_event_json(
    ev: CalendarSyncedEvent, recording: Recording | None = None
) -> dict:
    if recording is not None:
        rec_active = (
            recording.cancelled_at is None and recording.metadata_deleted_at is None
        )
        rec_id = str(recording.id) if rec_active else None
        rec_part = recording.participation if rec_active else None
    else:
        rec_id = str(ev.recording_id) if ev.recording_id else None
        rec_part = "scheduled" if ev.recording_id else None
    return {
        "id": str(ev.id),
        "connection_id": str(ev.connection_id),
        "calendar_provider": ev.calendar_provider,
        "external_event_id": ev.external_event_id,
        "title": ev.title,
        "starts_at": ev.starts_at.isoformat(),
        "ends_at": ev.ends_at.isoformat(),
        "organizer_email": ev.organizer_email,
        "is_self_organized": ev.is_self_organized,
        "meeting_provider": ev.meeting_provider,
        "meeting_url": ev.meeting_url,
        "status": ev.status,
        "auto_record": ev.auto_record,
        "user_override": ev.user_override,
        "recording_id": rec_id,
        "recording_participation": rec_part,
    }


def exchange_calendar_oauth_code(
    db: Session,
    principal: Principal,
    provider: CalendarOAuthProvider,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> dict:
    settings = get_settings()
    if provider == "google":
        if not settings.google_calendar_client_id or not settings.google_calendar_client_secret:
            raise HTTPException(503, "google_calendar_oauth_not_configured")
        token_url = GOOGLE_TOKEN_URL
        form = {
            "grant_type": "authorization_code",
            "client_id": settings.google_calendar_client_id,
            "client_secret": settings.google_calendar_client_secret.get_secret_value(),
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
    elif provider == "microsoft":
        if (
            not settings.microsoft_calendar_client_id
            or not settings.microsoft_calendar_client_secret
        ):
            raise HTTPException(503, "microsoft_calendar_oauth_not_configured")
        token_url = _microsoft_token_url(settings.microsoft_calendar_tenant_id)
        form = {
            "grant_type": "authorization_code",
            "client_id": settings.microsoft_calendar_client_id,
            "client_secret": settings.microsoft_calendar_client_secret.get_secret_value(),
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
    else:
        raise HTTPException(400, "Unsupported calendar OAuth provider")

    try:
        resp = httpx.post(
            token_url,
            data=form,
            headers={"Accept": "application/json"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            502, f"Calendar OAuth token endpoint unreachable: {type(exc).__name__}"
        ) from None

    if resp.status_code != 200:
        raise HTTPException(401, "Calendar OAuth code exchange rejected")

    token_data = resp.json()
    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token") or access_token
    if not access_token or not isinstance(access_token, str):
        raise HTTPException(401, "Calendar OAuth response missing access_token")

    expires_in = int(token_data.get("expires_in", 3600))
    account_email = _decode_jwt_email(token_data.get("id_token"))

    if not account_email:
        account_email = _fetch_account_email(provider, access_token)
    if not account_email:
        account_email = _effective_owner_email(principal)

    owner_email = _effective_owner_email(principal)
    now = datetime.now(UTC)
    conn = db.scalar(
        select(CalendarConnection)
        .where(
            CalendarConnection.owner_email == owner_email,
            CalendarConnection.provider == provider,
            CalendarConnection.account_email == account_email,
        )
        .with_for_update()
    )
    if conn is None:
        conn = CalendarConnection(
            owner_sub=principal.sub,
            owner_email=owner_email,
            provider=provider,
            account_email=account_email,
            encrypted_refresh_token=encrypt_secret(refresh_token),
            encrypted_access_token=encrypt_secret(access_token),
            token_expires_at=now + timedelta(seconds=max(60, expires_in - 60)),
        )
        db.add(conn)
        db.flush()
    else:
        conn.owner_sub = principal.sub or conn.owner_sub
        if token_data.get("refresh_token"):
            conn.encrypted_refresh_token = encrypt_secret(refresh_token)
        conn.encrypted_access_token = encrypt_secret(access_token)
        conn.token_expires_at = now + timedelta(seconds=max(60, expires_in - 60))
        conn.sync_error = None
        db.flush()

    synced_events = sync_connection(db, conn, now=now)
    db.commit()
    return {
        "connection": connection_json(conn),
        "synced_events": [synced_event_json(ev) for ev in synced_events],
    }


def _fetch_account_email(provider: CalendarOAuthProvider, access_token: str) -> str | None:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    try:
        if provider == "google":
            r = httpx.get(GOOGLE_USERINFO_URL, headers=headers, timeout=8.0)
            if r.status_code == 200:
                email = r.json().get("email")
                if isinstance(email, str) and "@" in email:
                    return email.strip().lower()
        else:
            r = httpx.get(
                f"{MICROSOFT_ME_URL}?$select=mail,userPrincipalName",
                headers=headers,
                timeout=8.0,
            )
            if r.status_code == 200:
                body = r.json()
                for key in ("mail", "userPrincipalName"):
                    val = body.get(key)
                    if isinstance(val, str) and "@" in val:
                        return val.strip().lower()
    except httpx.HTTPError:
        pass
    return None


def _ensure_access_token(conn: CalendarConnection, now: datetime) -> str:
    if (
        conn.encrypted_access_token
        and conn.token_expires_at
        and conn.token_expires_at > now + timedelta(seconds=30)
    ):
        return decrypt_secret(conn.encrypted_access_token)

    settings = get_settings()
    refresh_token = decrypt_secret(conn.encrypted_refresh_token)
    if conn.provider == "google":
        if not settings.google_calendar_client_id or not settings.google_calendar_client_secret:
            raise ValueError("google_calendar_oauth_not_configured")
        token_url = GOOGLE_TOKEN_URL
        form = {
            "grant_type": "refresh_token",
            "client_id": settings.google_calendar_client_id,
            "client_secret": settings.google_calendar_client_secret.get_secret_value(),
            "refresh_token": refresh_token,
        }
    else:
        if (
            not settings.microsoft_calendar_client_id
            or not settings.microsoft_calendar_client_secret
        ):
            raise ValueError("microsoft_calendar_oauth_not_configured")
        token_url = _microsoft_token_url(settings.microsoft_calendar_tenant_id)
        form = {
            "grant_type": "refresh_token",
            "client_id": settings.microsoft_calendar_client_id,
            "client_secret": settings.microsoft_calendar_client_secret.get_secret_value(),
            "refresh_token": refresh_token,
        }

    resp = httpx.post(
        token_url,
        data=form,
        headers={"Accept": "application/json"},
        timeout=10.0,
    )
    if resp.status_code != 200:
        raise ValueError("oauth_token_refresh_failed")
    body = resp.json()
    access_token = body.get("access_token")
    if not access_token:
        raise ValueError("oauth_token_refresh_missing_access_token")
    expires_in = int(body.get("expires_in", 3600))
    conn.encrypted_access_token = encrypt_secret(access_token)
    if body.get("refresh_token"):
        conn.encrypted_refresh_token = encrypt_secret(body["refresh_token"])
    conn.token_expires_at = now + timedelta(seconds=max(60, expires_in - 60))
    return access_token


def _fetch_provider_events(
    conn: CalendarConnection, access_token: str, window_start: datetime, window_end: datetime
) -> list[dict]:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    if conn.provider == "google":
        resp = httpx.get(
            GOOGLE_CALENDAR_EVENTS_URL,
            params={
                "singleEvents": "true",
                "orderBy": "startTime",
                "timeMin": window_start.isoformat(),
                "timeMax": window_end.isoformat(),
                "maxResults": "250",
            },
            headers=headers,
            timeout=12.0,
        )
        if resp.status_code != 200:
            raise ValueError(f"google_calendar_http_{resp.status_code}")
        items = resp.json().get("items") or []
        return _parse_google_items(conn, items)

    resp = httpx.get(
        MICROSOFT_CALENDAR_VIEW_URL,
        params={
            "startDateTime": window_start.isoformat(),
            "endDateTime": window_end.isoformat(),
            "$top": "250",
        },
        headers={**headers, "Prefer": 'outlook.timezone="UTC"'},
        timeout=12.0,
    )
    if resp.status_code != 200:
        raise ValueError(f"microsoft_calendar_http_{resp.status_code}")
    items = resp.json().get("value") or []
    return _parse_microsoft_items(conn, items)


def _parse_google_items(conn: CalendarConnection, items: list[dict]) -> list[dict]:
    parsed = []
    self_emails = {conn.owner_email.lower(), conn.account_email.lower()}
    for item in items:
        ext_id = str(item.get("id") or "").strip()
        if not ext_id:
            continue
        status = "cancelled" if item.get("status") == "cancelled" else "confirmed"
        start_obj = item.get("start") or {}
        end_obj = item.get("end") or {}
        starts_at = _parse_iso_datetime(start_obj.get("dateTime"), start_obj.get("timeZone"))
        ends_at = _parse_iso_datetime(end_obj.get("dateTime"), end_obj.get("timeZone"))
        if (
            not starts_at
            or not ends_at
            or ends_at <= starts_at
            or (ends_at - starts_at) > timedelta(hours=8)
        ):
            continue
        candidates: list[str] = []
        if isinstance(item.get("hangoutLink"), str):
            candidates.append(item["hangoutLink"])
        conf_data = item.get("conferenceData") or {}
        for ep in conf_data.get("entryPoints") or []:
            if isinstance(ep, dict) and isinstance(ep.get("uri"), str):
                candidates.append(ep["uri"])
        for field in ("location", "description"):
            if isinstance(item.get(field), str):
                candidates.append(item[field])
        target = extract_conference_target(candidates)
        if not target:
            continue
        meeting_provider, meeting_url = target
        org = item.get("organizer") or {}
        org_email = str(org.get("email") or "").strip().lower() or None
        is_self = bool(org.get("self")) or (org_email in self_emails if org_email else False)
        title = " ".join(str(item.get("summary") or "").split())[:200] or None
        parsed.append(
            {
                "external_event_id": ext_id[:512],
                "ical_uid": str(item.get("iCalUID") or "")[:512] or None,
                "title": title,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "organizer_email": org_email,
                "is_self_organized": is_self,
                "meeting_provider": meeting_provider,
                "meeting_url": meeting_url,
                "status": status,
            }
        )
    return parsed


def _parse_microsoft_items(conn: CalendarConnection, items: list[dict]) -> list[dict]:
    parsed = []
    self_emails = {conn.owner_email.lower(), conn.account_email.lower()}
    for item in items:
        ext_id = str(item.get("id") or "").strip()
        if not ext_id:
            continue
        status = "cancelled" if item.get("isCancelled") else "confirmed"
        start_obj = item.get("start") or {}
        end_obj = item.get("end") or {}
        starts_at = _parse_iso_datetime(start_obj.get("dateTime"), start_obj.get("timeZone"))
        ends_at = _parse_iso_datetime(end_obj.get("dateTime"), end_obj.get("timeZone"))
        if (
            not starts_at
            or not ends_at
            or ends_at <= starts_at
            or (ends_at - starts_at) > timedelta(hours=8)
        ):
            continue
        candidates: list[str] = []
        online = item.get("onlineMeeting") or {}
        if isinstance(online.get("joinUrl"), str):
            candidates.append(online["joinUrl"])
        if isinstance(item.get("onlineMeetingUrl"), str):
            candidates.append(item["onlineMeetingUrl"])
        loc = item.get("location") or {}
        if isinstance(loc.get("displayName"), str):
            candidates.append(loc["displayName"])
        body = item.get("body") or {}
        if isinstance(body.get("content"), str):
            candidates.append(body["content"])
        if isinstance(item.get("bodyPreview"), str):
            candidates.append(item["bodyPreview"])
        target = extract_conference_target(candidates)
        if not target:
            continue
        meeting_provider, meeting_url = target
        org = (item.get("organizer") or {}).get("emailAddress") or {}
        org_email = str(org.get("address") or "").strip().lower() or None
        is_self = bool(item.get("isOrganizer")) or (
            org_email in self_emails if org_email else False
        )
        title = " ".join(str(item.get("subject") or "").split())[:200] or None
        parsed.append(
            {
                "external_event_id": ext_id[:512],
                "ical_uid": str(item.get("iCalUId") or "")[:512] or None,
                "title": title,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "organizer_email": org_email,
                "is_self_organized": is_self,
                "meeting_provider": meeting_provider,
                "meeting_url": meeting_url,
                "status": status,
            }
        )
    return parsed


def _reconcile_synced_event_recording(
    db: Session, ev: CalendarSyncedEvent, now: datetime
) -> Recording | None:
    recording = db.get(Recording, ev.recording_id) if ev.recording_id else None
    if recording is not None and recording.metadata_deleted_at is not None:
        recording = None
        ev.recording_id = None

    should_record = ev.status == "confirmed" and ev.auto_record
    if not should_record:
        if recording is not None and recording.participation != "ended":
            request_cancellation(recording, now)
        ev.recording_id = None
        return None

    if ev.ends_at <= now:
        return recording

    if recording is None:
        idemp_hash = hashlib.sha256(
            f"cal-oauth:{ev.connection_id}:{ev.external_event_id}".encode()
        ).hexdigest()
        idemp_key = f"cal-oauth-{idemp_hash[:48]}"
        recording = db.scalar(
            select(Recording).where(Recording.idempotency_key == idemp_key).with_for_update()
        )
        if recording is None:
            if capacity_reached(db):
                return None
            recording = Recording(
                idempotency_key=idemp_key,
                request_digest=idemp_hash,
                owner_sub=ev.owner_sub,
                owner_email=ev.owner_email,
                provider=ev.meeting_provider,
                meeting_url=ev.meeting_url,
                title=ev.title,
                starts_at=ev.starts_at,
                ends_at=ev.ends_at,
            )
            db.add(recording)
            db.flush()
        ev.recording_id = recording.id

    if (
        (
            recording.participation != "ended"
            or (recording.cancelled_at is not None and ev.user_override is True)
        )
        and recording.active_attempt_id is None
    ):
        recording.starts_at = ev.starts_at
        recording.ends_at = ev.ends_at
        recording.title = ev.title
        recording.provider = ev.meeting_provider
        recording.meeting_url = ev.meeting_url
        if recording.cancelled_at is not None and ev.user_override is True:
            recording.cancelled_at = None
            recording.audio_closed_at = None
            recording.processing_finished_at = None
            recording.processing_error = None
            recording.participation_reason = None
            recording.participation = "scheduled"
            recording.processing = "pending"
    return recording


def sync_connection(
    db: Session, conn: CalendarConnection, now: datetime | None = None
) -> list[CalendarSyncedEvent]:
    now = now or datetime.now(UTC)
    settings = get_settings()
    window_start = now - timedelta(minutes=15)
    window_end = now + timedelta(days=settings.calendar_horizon_days)
    try:
        access_token = _ensure_access_token(conn, now)
        raw_events = _fetch_provider_events(conn, access_token, window_start, window_end)
    except Exception as exc:
        conn.sync_error = str(exc)[:128] or type(exc).__name__
        conn.last_synced_at = now
        return []

    seen_ext_ids: set[str] = set()
    synced: list[CalendarSyncedEvent] = []
    for item in raw_ext_list(raw_events):
        ext_id = item["external_event_id"]
        seen_ext_ids.add(ext_id)
        ev = db.scalar(
            select(CalendarSyncedEvent)
            .where(
                CalendarSyncedEvent.connection_id == conn.id,
                CalendarSyncedEvent.external_event_id == ext_id,
            )
            .with_for_update()
        )
        is_self = bool(item["is_self_organized"])
        if ev is None:
            ev = CalendarSyncedEvent(
                connection_id=conn.id,
                owner_sub=conn.owner_sub,
                owner_email=conn.owner_email,
                calendar_provider=conn.provider,
                external_event_id=ext_id,
                ical_uid=item["ical_uid"],
                title=item["title"],
                starts_at=item["starts_at"],
                ends_at=item["ends_at"],
                organizer_email=item["organizer_email"],
                is_self_organized=is_self,
                meeting_provider=item["meeting_provider"],
                meeting_url=item["meeting_url"],
                status=item["status"],
                user_override=None,
                auto_record=is_self,
                updated_at=now,
            )
            db.add(ev)
            db.flush()
        else:
            ev.ical_uid = item["ical_uid"]
            ev.title = item["title"]
            ev.starts_at = item["starts_at"]
            ev.ends_at = item["ends_at"]
            ev.organizer_email = item["organizer_email"]
            ev.is_self_organized = is_self
            ev.meeting_provider = item["meeting_provider"]
            ev.meeting_url = item["meeting_url"]
            ev.status = item["status"]
            ev.auto_record = (
                bool(ev.user_override) if ev.user_override is not None else is_self
            )
            ev.updated_at = now
        _reconcile_synced_event_recording(db, ev, now)
        synced.append(ev)

    # Mark previously synced future events in this window that disappeared as cancelled
    missing = db.scalars(
        select(CalendarSyncedEvent)
        .where(
            CalendarSyncedEvent.connection_id == conn.id,
            CalendarSyncedEvent.starts_at >= window_start,
            CalendarSyncedEvent.starts_at <= window_end,
        )
        .with_for_update()
    ).all()
    for ev in missing:
        if ev.external_event_id not in seen_ext_ids and ev.status != "cancelled":
            ev.status = "cancelled"
            ev.updated_at = now
            _reconcile_synced_event_recording(db, ev, now)

    conn.last_synced_at = now
    conn.sync_error = None
    return synced


def raw_ext_list(items: list[dict]) -> list[dict]:
    dedup: dict[str, dict] = {}
    for item in items:
        dedup[item["external_event_id"]] = item
    return list(dedup.values())


def toggle_synced_event(
    db: Session, principal: Principal, event_id: uuid.UUID, enabled: bool
) -> dict:
    ev = db.scalar(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.id == event_id)
        .with_for_update()
    )
    if ev is None:
        raise HTTPException(404, "Synced calendar event not found")
    owner_email = _effective_owner_email(principal)
    if not principal.is_admin and ev.owner_email.lower() != owner_email:
        raise HTTPException(404, "Synced calendar event not found")
    now = datetime.now(UTC)
    ev.user_override = enabled
    ev.auto_record = enabled
    ev.updated_at = now
    recording = _reconcile_synced_event_recording(db, ev, now)
    db.commit()
    return synced_event_json(ev, recording)


def calendar_oauth_pass(engine) -> bool:
    if not get_settings().enable_calendar_oauth_sync:
        return False
    now = datetime.now(UTC)
    with Session(engine) as db:
        conn_ids = db.scalars(select(CalendarConnection.id)).all()
    if not conn_ids:
        return False
    for conn_id in conn_ids:
        with Session(engine) as db:
            conn = db.scalar(
                select(CalendarConnection)
                .where(CalendarConnection.id == conn_id)
                .with_for_update(skip_locked=True)
            )
            if conn is None:
                continue
            sync_connection(db, conn, now=now)
            db.commit()
    return False
