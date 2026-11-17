"""OAuth2 Calendar Integration for Google Calendar & Microsoft Graph."""

import base64
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from html import escape
from typing import Literal
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from wortlaut.controller import request_cancellation
from wortlaut.exports import chat_reader_token
from wortlaut.ingest import capacity_reached
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioStream,
    CalendarConnection,
    CalendarSyncedEvent,
    Recording,
    TranscriptSegment,
)
from wortlaut.oidc import Principal
from wortlaut.settings import derive_subkey, get_settings
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
MICROSOFT_EVENTS_URL = "https://graph.microsoft.com/v1.0/me/events"
MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me"


def _fernet() -> MultiFernet:
    settings = get_settings()
    primary = Fernet(
        base64.urlsafe_b64encode(
            derive_subkey(b"calendar-oauth-fernet-v1", use_encryption_secret=True)
        )
    )
    fernets = [primary]
    if settings.encryption_key is not None:
        fernets.append(
            Fernet(
                base64.urlsafe_b64encode(
                    derive_subkey(b"calendar-oauth-fernet-v1", use_encryption_secret=False)
                )
            )
        )
    api_secret = settings.api_token.get_secret_value().encode("utf-8")
    legacy_digest = hashlib.sha256(b"wortlaut-cal-oauth-v1:" + api_secret).digest()
    fernets.append(Fernet(base64.urlsafe_b64encode(legacy_digest)))
    return MultiFernet(fernets)


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("stored_oauth_token_invalid") from exc


def extract_conference_target(texts: list[str]) -> tuple[str, str] | None:
    """Find the first valid Google Meet, Microsoft Teams, Cisco Webex, or Zoom join link."""
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
                provider in ("google_meet", "teams", "zoom")
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


def build_protocol_reader_url(recording: Recording | None) -> str | None:
    if (
        recording is None
        or recording.cancelled_at is not None
        or recording.metadata_deleted_at is not None
        or recording.transcript_deleted_at is not None
        or recording.processing != "completed"
    ):
        return None
    cred = chat_reader_token(recording)
    if not cred:
        return None
    sig = cred.removeprefix("wortlaut-read-")
    base_url = get_settings().public_base_url()
    return (
        f"{base_url}/ui#view=meetings&id={recording.id}"
        f"&token=wortlaut-read-{recording.id}.{sig}"
    )


def synced_event_json(
    ev: CalendarSyncedEvent, recording: Recording | None = None
) -> dict:
    protocol_url: str | None = None
    calendar_link_synced_at: str | None = None
    calendar_link_error: str | None = None
    if recording is not None:
        rec_active = (
            recording.cancelled_at is None and recording.metadata_deleted_at is None
        )
        rec_id = str(recording.id) if rec_active else None
        rec_part = recording.participation if rec_active else None
        rec_proc = recording.processing if rec_active else None
        if rec_active:
            protocol_url = build_protocol_reader_url(recording)
            meta = recording.protocol_meta if isinstance(recording.protocol_meta, dict) else {}
            calendar_link_synced_at = meta.get("calendar_link_synced_at")
            calendar_link_error = meta.get("calendar_link_error")
    else:
        rec_id = str(ev.recording_id) if ev.recording_id else None
        rec_part = "scheduled" if ev.recording_id else None
        rec_proc = None
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
        "recording_processing": rec_proc,
        "protocol_url": protocol_url,
        "calendar_link_synced_at": calendar_link_synced_at,
        "calendar_link_error": calendar_link_error,
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
        if not settings.microsoft_calendar_client_id:
            raise HTTPException(503, "microsoft_calendar_oauth_not_configured")
        token_url = _microsoft_token_url(settings.microsoft_calendar_tenant_id)
        form = {
            "grant_type": "authorization_code",
            "client_id": settings.microsoft_calendar_client_id,
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
        if settings.microsoft_calendar_client_secret:
            form["client_secret"] = (
                settings.microsoft_calendar_client_secret.get_secret_value()
            )
    else:
        raise HTTPException(400, "Unsupported calendar OAuth provider")

    req_headers = {"Accept": "application/json"}
    if provider == "microsoft" and not settings.microsoft_calendar_client_secret:
        origin = f"{urlsplit(redirect_uri).scheme}://{urlsplit(redirect_uri).netloc}"
        req_headers["Origin"] = origin

    try:
        resp = httpx.post(
            token_url,
            data=form,
            headers=req_headers,
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            502, f"Calendar OAuth token endpoint unreachable: {type(exc).__name__}"
        ) from None

    if resp.status_code != 200:
        err_msg = "Calendar OAuth code exchange rejected"
        try:
            err_body = resp.json()
            desc = err_body.get("error_description") or err_body.get("error")
            if isinstance(desc, str) and desc.strip():
                err_msg = f"{err_msg}: {desc.strip()[:240]}"
        except Exception:
            pass
        raise HTTPException(401, err_msg)

    token_data = resp.json()
    access_token = token_data.get("access_token")
    raw_refresh = token_data.get("refresh_token")
    new_refresh = (
        raw_refresh.strip() if isinstance(raw_refresh, str) and raw_refresh.strip() else None
    )
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
        .with_for_update(key_share=True)
    )
    if conn is None:
        if not new_refresh:
            raise HTTPException(
                400,
                "Calendar OAuth response missing refresh_token; please grant offline access.",
            )
        conn = CalendarConnection(
            owner_sub=principal.sub,
            owner_email=owner_email,
            provider=provider,
            account_email=account_email,
            encrypted_refresh_token=encrypt_secret(new_refresh),
            encrypted_access_token=encrypt_secret(access_token),
            token_expires_at=now + timedelta(seconds=max(60, expires_in - 60)),
        )
        db.add(conn)
        db.flush()
    else:
        conn.owner_sub = principal.sub or conn.owner_sub
        if new_refresh:
            conn.encrypted_refresh_token = encrypt_secret(new_refresh)
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


@dataclass
class ConnectionSnapshot:
    id: uuid.UUID
    provider: str
    owner_email: str
    account_email: str
    encrypted_access_token: str | None
    encrypted_refresh_token: str
    token_expires_at: datetime | None


def snapshot_connection(conn: CalendarConnection) -> ConnectionSnapshot:
    return ConnectionSnapshot(
        id=conn.id,
        provider=conn.provider,
        owner_email=conn.owner_email,
        account_email=conn.account_email,
        encrypted_access_token=conn.encrypted_access_token,
        encrypted_refresh_token=conn.encrypted_refresh_token,
        token_expires_at=conn.token_expires_at,
    )


def _ensure_access_token(
    conn: CalendarConnection | ConnectionSnapshot, now: datetime
) -> str:
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
        if not settings.microsoft_calendar_client_id:
            raise ValueError("microsoft_calendar_oauth_not_configured")
        token_url = _microsoft_token_url(settings.microsoft_calendar_tenant_id)
        form = {
            "grant_type": "refresh_token",
            "client_id": settings.microsoft_calendar_client_id,
            "refresh_token": refresh_token,
        }
        if settings.microsoft_calendar_client_secret:
            form["client_secret"] = (
                settings.microsoft_calendar_client_secret.get_secret_value()
            )

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


_MAX_CALENDAR_SYNC_PAGES = 20


class _EventPageList(list):
    """List of parsed calendar events carrying whether upstream pagination hit the page cap."""

    def __init__(self, iterable=(), *, truncated: bool = False):
        super().__init__(iterable)
        self.truncated = truncated


def _fetch_provider_events(
    conn: CalendarConnection | ConnectionSnapshot,
    access_token: str,
    window_start: datetime,
    window_end: datetime,
) -> list[dict]:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    if conn.provider == "google":
        all_items: list[dict] = []
        page_token: str | None = None
        truncated = False
        for page_idx in range(_MAX_CALENDAR_SYNC_PAGES):
            params: dict[str, str] = {
                "singleEvents": "true",
                "orderBy": "startTime",
                "timeMin": window_start.isoformat(),
                "timeMax": window_end.isoformat(),
                "maxResults": "250",
            }
            if page_token:
                params["pageToken"] = page_token
            resp = httpx.get(
                GOOGLE_CALENDAR_EVENTS_URL,
                params=params,
                headers=headers,
                timeout=12.0,
            )
            if resp.status_code != 200:
                raise ValueError(f"google_calendar_http_{resp.status_code}")
            body = resp.json()
            all_items.extend(body.get("items") or [])
            next_tok = body.get("nextPageToken")
            if not isinstance(next_tok, str) or not next_tok.strip():
                break
            page_token = next_tok.strip()
            if page_idx == _MAX_CALENDAR_SYNC_PAGES - 1:
                truncated = True
        out = _EventPageList(_parse_google_items(conn, all_items))
        out.truncated = truncated
        return out

    all_ms_items: list[dict] = []
    next_url: str | None = MICROSOFT_CALENDAR_VIEW_URL
    ms_params: dict[str, str] | None = {
        "startDateTime": window_start.isoformat(),
        "endDateTime": window_end.isoformat(),
        "$top": "250",
    }
    truncated = False
    for page_idx in range(_MAX_CALENDAR_SYNC_PAGES):
        resp = httpx.get(
            next_url,
            params=ms_params,
            headers={**headers, "Prefer": 'outlook.timezone="UTC"'},
            timeout=12.0,
        )
        if resp.status_code != 200:
            raise ValueError(f"microsoft_calendar_http_{resp.status_code}")
        body = resp.json()
        all_ms_items.extend(body.get("value") or [])
        raw_next = body.get("@odata.nextLink")
        if not isinstance(raw_next, str) or not raw_next.strip():
            break
        parsed_next = urlsplit(raw_next.strip())
        if parsed_next.scheme != "https" or parsed_next.hostname != "graph.microsoft.com":
            break
        next_url = raw_next.strip()
        ms_params = None
        if page_idx == _MAX_CALENDAR_SYNC_PAGES - 1:
            truncated = True
    out = _EventPageList(_parse_microsoft_items(conn, all_ms_items))
    out.truncated = truncated
    return out


_NOTETAKER_BOT_RE = re.compile(
    r"\b("
    r"fireflies(\.ai)?|otter(\.ai)?|read\.ai|fathom(\.video)?|tl;dv|tldv(\.io)?|"
    r"meetgeek(\.ai)?|fellow(\.app)?|avoma(\.com)?|sembly(\.ai)?|supernormal(\.com)?|"
    r"grain(\.com)?|krisp(\.ai)?|tactiq(\.io)?|airgram(\.io)?|notta(\.ai)?|nyota(\.ai)?|"
    r"circleback(\.ai)?|sonnet(\.ai)?|bluedot(\.hq)?|granola(\.ai)?|wortlaut(\.cloud)?|"
    r"notetaker|note[\s_-]*taker|meeting[\s_-]*bot|ai[\s_-]*notetaker"
    r")\b",
    re.IGNORECASE,
)


def is_notetaker_bot(email: str | None = None, display_name: str | None = None) -> bool:
    for val in (email, display_name):
        if val and _NOTETAKER_BOT_RE.search(val):
            return True
    return False


def _parse_google_items(
    conn: CalendarConnection | ConnectionSnapshot, items: list[dict]
) -> list[dict]:
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
        is_self = (org_email in self_emails) if org_email else bool(org.get("self"))
        raw_attendees = item.get("attendees") or []
        other_attendees = [
            a
            for a in raw_attendees
            if isinstance(a, dict)
            and not a.get("resource")
            and (
                str(a.get("email") or "").strip().lower() not in self_emails
                if a.get("email")
                else not a.get("self")
            )
            and not is_notetaker_bot(
                str(a.get("email") or ""), str(a.get("displayName") or "")
            )
        ]
        if is_self and not other_attendees:
            continue
        has_confirmed_attendee = any(
            str(a.get("responseStatus") or "") in ("accepted", "tentative")
            for a in other_attendees
        )
        attendee_emails = sorted(
            {
                *(e for e in self_emails if "@" in e),
                *([org_email] if org_email and "@" in org_email else []),
                *(
                    str(a.get("email") or "").strip().lower()
                    for a in other_attendees
                    if "@" in str(a.get("email") or "")
                ),
            }
        )
        title = " ".join(str(item.get("summary") or "").split())[:200] or None
        parsed.append(
            {
                "external_event_id": ext_id[:512],
                "ical_uid": str(item.get("iCalUID") or "")[:512] or None,
                "title": title,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "organizer_email": org_email,
                "attendee_emails": attendee_emails,
                "is_self_organized": is_self,
                "default_auto_record": is_self and has_confirmed_attendee,
                "meeting_provider": meeting_provider,
                "meeting_url": meeting_url,
                "status": status,
            }
        )
    return parsed


def _parse_microsoft_items(
    conn: CalendarConnection | ConnectionSnapshot, items: list[dict]
) -> list[dict]:
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
        is_self = (org_email in self_emails) if org_email else bool(item.get("isOrganizer"))
        raw_attendees = item.get("attendees") or []
        other_attendees = [
            a
            for a in raw_attendees
            if isinstance(a, dict)
            and str(a.get("type") or "").lower() != "resource"
            and str(((a.get("emailAddress") or {}).get("address")) or "").strip().lower()
            not in self_emails
            and not is_notetaker_bot(
                str(((a.get("emailAddress") or {}).get("address")) or ""),
                str(((a.get("emailAddress") or {}).get("name")) or ""),
            )
        ]
        if is_self and not other_attendees:
            continue
        has_confirmed_attendee = any(
            str(((a.get("status") or {}).get("response")) or "")
            in ("accepted", "tentativelyAccepted")
            for a in other_attendees
        )
        attendee_emails = sorted(
            {
                *(e for e in self_emails if "@" in e),
                *([org_email] if org_email and "@" in org_email else []),
                *(
                    str(((a.get("emailAddress") or {}).get("address")) or "").strip().lower()
                    for a in other_attendees
                    if "@" in str(((a.get("emailAddress") or {}).get("address")) or "")
                ),
            }
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
                "attendee_emails": attendee_emails,
                "is_self_organized": is_self,
                "default_auto_record": is_self and has_confirmed_attendee,
                "meeting_provider": meeting_provider,
                "meeting_url": meeting_url,
                "status": status,
            }
        )
    return parsed


def _merge_recording_attendees(recording: Recording, emails: list[str] | set[str]) -> None:
    clean = {str(e).strip().lower() for e in emails if e and "@" in str(e)}
    if not clean:
        return
    meta = dict(recording.protocol_meta or {})
    existing = {
        str(e).strip().lower()
        for e in (meta.get("attendee_emails") or [])
        if e and "@" in str(e)
    }
    merged = sorted(existing | clean)
    if merged != meta.get("attendee_emails"):
        meta["attendee_emails"] = merged
        recording.protocol_meta = meta


def _find_canonical_meeting_recording(
    db: Session, ev: CalendarSyncedEvent
) -> Recording | None:
    if not ev.meeting_provider or not ev.meeting_url:
        return None
    return db.scalar(
        select(Recording)
        .where(
            Recording.provider == ev.meeting_provider,
            Recording.meeting_url == ev.meeting_url,
            Recording.metadata_deleted_at.is_(None),
            Recording.cancelled_at.is_(None),
            Recording.participation != "ended",
            Recording.starts_at < ev.ends_at,
            Recording.ends_at > ev.starts_at,
        )
        .order_by(
            Recording.active_attempt_id.is_not(None).desc(),
            Recording.starts_at.asc(),
            Recording.id.asc(),
        )
        .limit(1)
        .with_for_update(key_share=True)
    )


def _reconcile_synced_event_recording(
    db: Session,
    ev: CalendarSyncedEvent,
    now: datetime,
    attendee_emails: list[str] | None = None,
) -> Recording | None:
    recording = db.get(Recording, ev.recording_id) if ev.recording_id else None
    if recording is not None and recording.metadata_deleted_at is not None:
        recording = None
        ev.recording_id = None

    all_emails = set(attendee_emails or [])
    if ev.owner_email:
        all_emails.add(ev.owner_email.strip().lower())
    if ev.organizer_email:
        all_emails.add(ev.organizer_email.strip().lower())

    should_record = ev.status == "confirmed" and ev.auto_record
    if not should_record:
        if recording is not None and recording.participation != "ended":
            other_active = db.scalar(
                select(CalendarSyncedEvent.id)
                .where(
                    CalendarSyncedEvent.recording_id == recording.id,
                    CalendarSyncedEvent.id != ev.id,
                    CalendarSyncedEvent.status == "confirmed",
                    CalendarSyncedEvent.auto_record.is_(True),
                )
                .limit(1)
            )
            if other_active is None:
                request_cancellation(recording, now)
        ev.recording_id = None
        return None

    if ev.ends_at <= now:
        if recording is not None:
            _merge_recording_attendees(recording, all_emails)
        return recording

    canonical = _find_canonical_meeting_recording(db, ev)
    if (
        recording is not None
        and canonical is not None
        and canonical.id != recording.id
        and recording.participation == "scheduled"
        and recording.active_attempt_id is None
        and recording.cancelled_at is None
    ):
        prev_emails = list((recording.protocol_meta or {}).get("attendee_emails") or [])
        _merge_recording_attendees(canonical, prev_emails)
        ev.recording_id = canonical.id
        other_refs = db.scalar(
            select(CalendarSyncedEvent.id)
            .where(
                CalendarSyncedEvent.recording_id == recording.id,
                CalendarSyncedEvent.id != ev.id,
                CalendarSyncedEvent.status == "confirmed",
                CalendarSyncedEvent.auto_record.is_(True),
            )
            .limit(1)
        )
        if other_refs is None:
            request_cancellation(recording, now)
            recording.metadata_deleted_at = now
        recording = canonical

    if recording is None:
        if canonical is not None:
            recording = canonical
        else:
            idemp_hash = hashlib.sha256(
                f"cal-oauth:{ev.connection_id}:{ev.external_event_id}".encode()
            ).hexdigest()
            idemp_key = f"cal-oauth-{idemp_hash[:48]}"
            recording = db.scalar(
                select(Recording)
                .where(Recording.idempotency_key == idemp_key)
                .with_for_update(key_share=True)
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
                    protocol_meta={"attendee_emails": sorted(all_emails)} if all_emails else {},
                )
                db.add(recording)
                db.flush()
        ev.recording_id = recording.id

    _merge_recording_attendees(recording, all_emails)

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


def fetch_connection_events_unlocked(
    snap: ConnectionSnapshot, now: datetime
) -> tuple[list[dict] | None, ConnectionSnapshot, str | None]:
    settings = get_settings()
    window_start = now - timedelta(minutes=15)
    window_end = now + timedelta(days=settings.calendar_horizon_days)
    try:
        access_token = _ensure_access_token(snap, now)
        raw_events = _fetch_provider_events(snap, access_token, window_start, window_end)
        return raw_events, snap, None
    except Exception as exc:
        err = str(exc)[:128] or type(exc).__name__
        return None, snap, err


def apply_synced_events(
    db: Session,
    conn: CalendarConnection,
    raw_events: list[dict] | None,
    updated_snap: ConnectionSnapshot,
    sync_error: str | None,
    now: datetime,
) -> list[CalendarSyncedEvent]:
    if updated_snap.encrypted_access_token != conn.encrypted_access_token:
        conn.encrypted_access_token = updated_snap.encrypted_access_token
    if updated_snap.encrypted_refresh_token != conn.encrypted_refresh_token:
        conn.encrypted_refresh_token = updated_snap.encrypted_refresh_token
    if updated_snap.token_expires_at != conn.token_expires_at:
        conn.token_expires_at = updated_snap.token_expires_at

    if sync_error is not None or raw_events is None:
        conn.sync_error = sync_error or "calendar_sync_failed"
        conn.last_synced_at = now
        return []

    settings = get_settings()
    window_start = now - timedelta(minutes=15)
    window_end = now + timedelta(days=settings.calendar_horizon_days)

    seen_ext_ids: set[str] = set()
    synced: list[CalendarSyncedEvent] = []
    for item in sorted(raw_ext_list(raw_events), key=lambda x: x["external_event_id"]):
        ext_id = item["external_event_id"]
        seen_ext_ids.add(ext_id)
        ev = db.scalar(
            select(CalendarSyncedEvent)
            .where(
                CalendarSyncedEvent.connection_id == conn.id,
                CalendarSyncedEvent.external_event_id == ext_id,
            )
            .with_for_update(key_share=True)
        )
        is_self = bool(item["is_self_organized"])
        default_auto = bool(item.get("default_auto_record", is_self))
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
                auto_record=default_auto,
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
                bool(ev.user_override) if ev.user_override is not None else default_auto
            )
            ev.updated_at = now
        event_attendees = item.get("attendee_emails") or []
        _reconcile_synced_event_recording(db, ev, now, attendee_emails=event_attendees)
        if event_attendees:
            matching_recs = db.scalars(
                select(Recording)
                .where(
                    Recording.meeting_url == ev.meeting_url,
                    Recording.metadata_deleted_at.is_(None),
                    Recording.starts_at <= ev.ends_at + timedelta(hours=1),
                    Recording.ends_at >= ev.starts_at - timedelta(hours=1),
                )
                .order_by(Recording.id.asc())
                .with_for_update(key_share=True)
            ).all()
            for mrec in matching_recs:
                _merge_recording_attendees(mrec, event_attendees)
        synced.append(ev)

    # Mark previously synced future events in this window that disappeared as cancelled
    # (skip when upstream pagination hit the safety page cap so valid events are never truncated).
    if not getattr(raw_events, "truncated", False):
        missing = db.scalars(
            select(CalendarSyncedEvent)
            .where(
                CalendarSyncedEvent.connection_id == conn.id,
                CalendarSyncedEvent.starts_at >= window_start,
                CalendarSyncedEvent.starts_at <= window_end,
            )
            .order_by(CalendarSyncedEvent.id.asc())
            .with_for_update(key_share=True)
        ).all()
        for ev in missing:
            if ev.external_event_id not in seen_ext_ids and ev.status != "cancelled":
                ev.status = "cancelled"
                ev.updated_at = now
                _reconcile_synced_event_recording(db, ev, now)

    conn.last_synced_at = now
    conn.sync_error = None
    synced.sort(
        key=lambda e: (
            e.ends_at < now,
            e.starts_at.timestamp() if e.ends_at >= now else -e.starts_at.timestamp(),
        )
    )
    return synced


def sync_connection(
    db: Session, conn: CalendarConnection, now: datetime | None = None
) -> list[CalendarSyncedEvent]:
    now = now or datetime.now(UTC)
    snap = snapshot_connection(conn)
    raw_events, updated_snap, sync_error = fetch_connection_events_unlocked(snap, now)
    return apply_synced_events(db, conn, raw_events, updated_snap, sync_error, now)


def raw_ext_list(items: list[dict]) -> list[dict]:
    dedup: dict[str, dict] = {}
    for item in items:
        dedup[item["external_event_id"]] = item
    return list(dedup.values())


def toggle_synced_event(
    db: Session, principal: Principal, event_id: uuid.UUID, enabled: bool
) -> dict:
    ev_peek = db.get(CalendarSyncedEvent, event_id)
    if ev_peek is None:
        raise HTTPException(404, "Synced calendar event not found")
    owner_email = _effective_owner_email(principal)
    if not principal.is_admin and ev_peek.owner_email.lower() != owner_email:
        raise HTTPException(404, "Synced calendar event not found")
    conn_id = ev_peek.connection_id
    # Lock parent CalendarConnection before child CalendarSyncedEvent (FOR NO KEY UPDATE)
    # so concurrent sync_connection / calendar_oauth_pass never invert lock order.
    conn = db.scalar(
        select(CalendarConnection)
        .where(CalendarConnection.id == conn_id)
        .with_for_update(key_share=True)
    )
    if conn is None:
        raise HTTPException(404, "Synced calendar event not found")
    ev = db.scalar(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.id == event_id)
        .with_for_update(key_share=True)
    )
    if ev is None:
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
        snapshots = [
            snapshot_connection(c)
            for c in db.scalars(
                select(CalendarConnection).order_by(CalendarConnection.id.asc())
            ).all()
        ]
    if not snapshots:
        return False
    for snap in snapshots:
        raw_events, updated_snap, sync_error = fetch_connection_events_unlocked(snap, now)
        with Session(engine) as db:
            conn = db.scalar(
                select(CalendarConnection)
                .where(CalendarConnection.id == snap.id)
                .with_for_update(key_share=True, skip_locked=True)
            )
            if conn is None:
                continue
            apply_synced_events(db, conn, raw_events, updated_snap, sync_error, now)
            db.commit()
    return False


PROTOCOL_MARKER_START = "--- wortlaut Wortprotokoll ---"
PROTOCOL_MARKER_END = "--- Ende wortlaut Wortprotokoll ---"
HTML_MARKER_START = "<!-- wortlaut-protocol-start -->"
HTML_MARKER_END = "<!-- wortlaut-protocol-end -->"


def _inject_protocol_block_plain(
    existing: str, protocol_url: str, summary_text: str | None = None
) -> str:
    lines = [
        PROTOCOL_MARKER_START,
        "📝 wortlaut Wortprotokoll",
        f"Protokoll & Audio-Prüfung: {protocol_url}",
    ]
    if summary_text and summary_text.strip():
        lines.append(f"Zusammenfassung: {' '.join(summary_text.split())}")
    lines.append(PROTOCOL_MARKER_END)
    block = "\n".join(lines)

    raw = existing or ""
    if HTML_MARKER_START in raw and HTML_MARKER_END in raw:
        pattern = re.compile(
            re.escape(HTML_MARKER_START) + r".*?" + re.escape(HTML_MARKER_END),
            re.DOTALL,
        )
        raw = pattern.sub("", raw).rstrip()
    if PROTOCOL_MARKER_START in raw and PROTOCOL_MARKER_END in raw:
        pattern = re.compile(
            re.escape(PROTOCOL_MARKER_START) + r".*?" + re.escape(PROTOCOL_MARKER_END),
            re.DOTALL,
        )
        return pattern.sub(lambda _: block, raw)
    base = raw.rstrip()
    if not base:
        return block
    return f"{base}\n\n{block}"


def _inject_protocol_block_html(
    existing: str, protocol_url: str, summary_text: str | None = None
) -> str:
    safe_url = escape(protocol_url, quote=True)
    summary_html = ""
    if summary_text and summary_text.strip():
        safe_sum = escape(" ".join(summary_text.split()))
        summary_html = f"<br><span><strong>Zusammenfassung:</strong> {safe_sum}</span>"
    block = (
        f"{HTML_MARKER_START}"
        f"<hr>"
        f"<p><strong>📝 wortlaut Wortprotokoll</strong><br>"
        f'Protokoll &amp; Audio-Prüfung: <a href="{safe_url}">{safe_url}</a>'
        f"{summary_html}<br>"
        f"<small>{PROTOCOL_MARKER_END}</small></p>"
        f"{HTML_MARKER_END}"
    )

    raw = existing or ""
    if PROTOCOL_MARKER_START in raw and PROTOCOL_MARKER_END in raw:
        pattern = re.compile(
            re.escape(PROTOCOL_MARKER_START) + r".*?" + re.escape(PROTOCOL_MARKER_END),
            re.DOTALL,
        )
        raw = pattern.sub("", raw).rstrip()
    if HTML_MARKER_START in raw and HTML_MARKER_END in raw:
        pattern = re.compile(
            re.escape(HTML_MARKER_START) + r".*?" + re.escape(HTML_MARKER_END),
            re.DOTALL,
        )
        return pattern.sub(lambda _: block, raw)
    sanitized_html_pattern = re.compile(
        r"(?:<hr\s*/?>\s*)?<p[^>]*>\s*<strong>📝 wortlaut Wortprotokoll</strong>.*?"
        + re.escape(PROTOCOL_MARKER_END)
        + r"\s*</small>\s*</p>",
        re.DOTALL | re.IGNORECASE,
    )
    if sanitized_html_pattern.search(raw):
        return sanitized_html_pattern.sub(lambda _: block, raw)
    body_close = re.search(r"</body\s*>", raw, re.IGNORECASE)
    if body_close:
        idx = body_close.start()
        return f"{raw[:idx]}{block}{raw[idx:]}"
    base = raw.rstrip()
    if not base:
        return block
    return f"{base}\n{block}"


def _patch_provider_event_protocol_link(
    conn: CalendarConnection | ConnectionSnapshot,
    ev: CalendarSyncedEvent,
    protocol_url: str,
    summary_text: str | None,
    now: datetime,
) -> None:
    access_token = _ensure_access_token(conn, now)
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    encoded_id = quote(ev.external_event_id, safe="")

    try:
        if conn.provider == "google":
            event_url = f"{GOOGLE_CALENDAR_EVENTS_URL}/{encoded_id}"
            get_resp = httpx.get(event_url, headers=headers, timeout=10.0)
            if get_resp.status_code == 403:
                raise ValueError("insufficient_calendar_write_scope")
            if get_resp.status_code != 200:
                raise ValueError(f"google_event_get_http_{get_resp.status_code}")
            current_desc = str(get_resp.json().get("description") or "")
            looks_html = bool(
                re.search(r"<(a|br|p|div|hr|ul|li)\b", current_desc, re.IGNORECASE)
                or HTML_MARKER_START in current_desc
            )
            updated_desc = (
                _inject_protocol_block_html(current_desc, protocol_url, summary_text)
                if looks_html
                else _inject_protocol_block_plain(current_desc, protocol_url, summary_text)
            )
            send_updates = "all" if ev.is_self_organized else "none"
            patch_resp = httpx.patch(
                event_url,
                params={"sendUpdates": send_updates},
                json={"description": updated_desc},
                headers=headers,
                timeout=10.0,
            )
            if patch_resp.status_code == 403:
                raise ValueError("insufficient_calendar_write_scope")
            if patch_resp.status_code not in (200, 201):
                raise ValueError(f"google_event_patch_http_{patch_resp.status_code}")
            return

        event_url = f"{MICROSOFT_EVENTS_URL}/{encoded_id}"
        get_resp = httpx.get(
            event_url,
            params={"$select": "id,body,isOrganizer"},
            headers=headers,
            timeout=10.0,
        )
        if get_resp.status_code == 403:
            raise ValueError("insufficient_calendar_write_scope")
        if get_resp.status_code != 200:
            raise ValueError(f"microsoft_event_get_http_{get_resp.status_code}")
        body_obj = get_resp.json().get("body") or {}
        ctype = str(body_obj.get("contentType") or "HTML")
        current_content = str(body_obj.get("content") or "")
        if ctype.lower() == "html":
            updated_content = _inject_protocol_block_html(
                current_content, protocol_url, summary_text
            )
            patch_ctype = "HTML"
        else:
            updated_content = _inject_protocol_block_plain(
                current_content, protocol_url, summary_text
            )
            patch_ctype = "Text"
        patch_resp = httpx.patch(
            event_url,
            json={"body": {"contentType": patch_ctype, "content": updated_content}},
            headers=headers,
            timeout=10.0,
        )
        if patch_resp.status_code == 403:
            raise ValueError("insufficient_calendar_write_scope")
        if patch_resp.status_code not in (200, 201, 204):
            raise ValueError(f"microsoft_event_patch_http_{patch_resp.status_code}")
    except httpx.HTTPError as exc:
        raise ValueError(f"calendar_network_{type(exc).__name__}") from None


def publish_protocol_link_to_calendar_events(
    db: Session,
    recording: Recording,
    *,
    force_empty_audio: bool = False,
) -> dict:
    protocol_url = build_protocol_reader_url(recording)
    if not protocol_url:
        return {"updated_events": 0, "status": "not_ready", "protocol_url": None}

    meta = dict(recording.protocol_meta or {})
    summary_obj = meta.get("summary")
    summary_text = (
        str(summary_obj.get("summary") or "").strip()
        if isinstance(summary_obj, dict)
        else None
    )

    if not force_empty_audio:
        has_content = bool(summary_text) or bool(
            db.scalar(
                select(TranscriptSegment.id)
                .join(AsrJob, AsrJob.id == TranscriptSegment.id)
                .join(AudioStream, AudioStream.id == AsrJob.stream_id)
                .join(Attempt, Attempt.id == AudioStream.attempt_id)
                .where(Attempt.recording_id == recording.id)
                .limit(1)
            )
        )
        if not has_content:
            return {"updated_events": 0, "status": "no_audio_content", "protocol_url": protocol_url}

    now = datetime.now(UTC)
    events = db.scalars(
        select(CalendarSyncedEvent)
        .where(
            CalendarSyncedEvent.status == "confirmed",
            or_(
                CalendarSyncedEvent.recording_id == recording.id,
                (
                    (CalendarSyncedEvent.meeting_url == recording.meeting_url)
                    & (CalendarSyncedEvent.starts_at <= recording.ends_at + timedelta(hours=1))
                    & (CalendarSyncedEvent.ends_at >= recording.starts_at - timedelta(hours=1))
                ),
            ),
        )
        .order_by(
            CalendarSyncedEvent.is_self_organized.desc(),
            CalendarSyncedEvent.id.asc(),
        )
    ).all()

    if not events:
        return {
            "updated_events": 0,
            "status": "no_matching_calendar_event",
            "protocol_url": protocol_url,
        }

    # Prepare connection snapshots before releasing DB locks during external HTTP PATCH calls.
    conn_snaps: dict[uuid.UUID, ConnectionSnapshot] = {}
    for ev in events:
        if ev.connection_id not in conn_snaps:
            conn_row = db.get(CalendarConnection, ev.connection_id)
            if conn_row is not None:
                conn_snaps[ev.connection_id] = snapshot_connection(conn_row)

    rec_id = recording.id
    updated_count = 0
    organizer_patched = False
    last_error: str | None = None
    event_ids_to_link = [ev.id for ev in events if ev.recording_id is None]

    for ev in events:
        if organizer_patched and not ev.is_self_organized:
            continue
        snap = conn_snaps.get(ev.connection_id)
        if snap is None:
            continue
        try:
            _patch_provider_event_protocol_link(
                snap, ev, protocol_url, summary_text, now
            )
            updated_count += 1
            if ev.is_self_organized:
                organizer_patched = True
        except Exception as exc:
            err_code = str(exc)[:120] if isinstance(exc, ValueError) else type(exc).__name__
            last_error = err_code
            logging.getLogger("wortlaut").warning(
                "calendar_protocol_link_failed recording=%s event=%s error=%s",
                rec_id,
                ev.id,
                err_code,
            )

    # Lock in canonical order: CalendarConnection -> CalendarSyncedEvent -> Recording
    for cid in sorted(conn_snaps):
        snap = conn_snaps[cid]
        conn_locked = db.scalar(
            select(CalendarConnection)
            .where(CalendarConnection.id == cid)
            .with_for_update(key_share=True)
        )
        if conn_locked is not None:
            if snap.encrypted_access_token != conn_locked.encrypted_access_token:
                conn_locked.encrypted_access_token = snap.encrypted_access_token
            if snap.encrypted_refresh_token != conn_locked.encrypted_refresh_token:
                conn_locked.encrypted_refresh_token = snap.encrypted_refresh_token
            if snap.token_expires_at != conn_locked.token_expires_at:
                conn_locked.token_expires_at = snap.token_expires_at

    if event_ids_to_link:
        locked_events = db.scalars(
            select(CalendarSyncedEvent)
            .where(CalendarSyncedEvent.id.in_(event_ids_to_link))
            .order_by(CalendarSyncedEvent.id.asc())
            .with_for_update()
        ).all()
        for lev in locked_events:
            if lev.recording_id is None:
                lev.recording_id = rec_id

    locked_rec = db.scalar(
        select(Recording).where(Recording.id == rec_id).with_for_update()
    )
    target_rec = locked_rec or recording
    fresh_meta = dict(target_rec.protocol_meta or {})
    if updated_count > 0:
        fresh_meta["calendar_link_synced_at"] = now.isoformat()
        fresh_meta.pop("calendar_link_error", None)
        target_rec.protocol_meta = fresh_meta
        return {
            "updated_events": updated_count,
            "status": "linked",
            "protocol_url": protocol_url,
            "calendar_link_synced_at": fresh_meta["calendar_link_synced_at"],
        }

    if last_error:
        fresh_meta["calendar_link_error"] = last_error
        target_rec.protocol_meta = fresh_meta
    return {
        "updated_events": 0,
        "status": "error",
        "error": last_error or "calendar_update_failed",
        "protocol_url": protocol_url,
    }
