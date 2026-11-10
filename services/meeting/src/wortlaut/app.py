import asyncio
import base64
import hashlib
import json
import logging
import secrets
import struct
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

import httpx
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import (
    AwareDatetime,
    BaseModel,
    Field,
    ValidationError,
    model_serializer,
    model_validator,
)
from sqlalchemy import and_, delete, func, or_, select, text, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from wortlaut.asr import finalize_processing, inference_pass
from wortlaut.calendar import entry_json, imap_pass, import_mail
from wortlaut.calendar_oauth import (
    CalendarOAuthProvider,
    calendar_oauth_pass,
    connection_json,
    exchange_calendar_oauth_code,
    sync_connection,
    synced_event_json,
    toggle_synced_event,
)
from wortlaut.controller import controller_pass, new_attempt, request_cancellation
from wortlaut.database import get_engine, session
from wortlaut.exports import (
    chat_reader_token,
    export_data,
    export_reader_token,
    extract_audio_snippet_wav,
    generate_protocol_summary,
    render_export,
    verify_recording_reader_token,
)
from wortlaut.ingest import accept_chunk, accept_control, capacity_reached, verify_owner
from wortlaut.mail import FAILURE_REASONS, delivery_json, smtp_pass
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    CalendarConnection,
    CalendarEntry,
    CalendarSyncedEvent,
    Delivery,
    Recording,
    TranscriptSegment,
)
from wortlaut.oidc import (
    Principal,
    can_access_recording,
    exchange_oidc_code,
    is_admin_email,
    user_recording_access_predicate,
    verify_dex_id_token,
    verify_user_session_token,
)
from wortlaut.processing import RATE, segmentation_pass, stream_quality
from wortlaut.recurrence import recurrence_pass
from wortlaut.retention import retention_pass
from wortlaut.settings import get_settings
from wortlaut.storage import get_storage
from wortlaut.telemetry import record_worker_status_telemetry
from wortlaut.ui import render_privacy, render_ui
from wortlaut.validation import Provider, normalize_meeting_url
from wortlaut.webex import WebexUnavailable, guest_token


async def processing_loop(stop: asyncio.Event, operation, interval=2):
    while not stop.is_set():
        try:
            worked = await run_in_threadpool(operation, get_engine())
            if worked is True:
                # Yield to shutdown/status tasks, then claim the next ready job without idle delay.
                await asyncio.sleep(0)
                continue
        except Exception as error:
            # Third-party exception messages may include URLs or credentials.
            logging.getLogger("wortlaut").error(
                "%s_failed type=%s", operation.__name__, type(error).__name__
            )
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()
    tasks = (
        [
            asyncio.create_task(processing_loop(stop, operation, interval))
            for operation, interval in (
                (segmentation_pass, 2),
                (inference_pass, 2),
                (finalize_processing, 2),
                (retention_pass, 60),
            )
        ]
        if get_settings().enable_processing
        else []
    )
    if get_settings().enable_controller:
        tasks.append(asyncio.create_task(processing_loop(stop, recurrence_pass, 60)))
        tasks.append(asyncio.create_task(processing_loop(stop, controller_pass, 5)))
        if get_settings().enable_calendar_oauth_sync:
            tasks.append(asyncio.create_task(processing_loop(stop, calendar_oauth_pass, 60)))
    if get_settings().enable_imap:
        tasks.append(asyncio.create_task(processing_loop(stop, imap_pass, 30)))
    if get_settings().enable_smtp:
        tasks.append(asyncio.create_task(processing_loop(stop, smtp_pass, 15)))
    try:
        yield
    finally:
        stop.set()
        await asyncio.gather(*tasks)


app = FastAPI(title="wortlaut", lifespan=lifespan)
if get_settings().sdk_directory.is_dir():
    app.mount("/sdk", StaticFiles(directory=get_settings().sdk_directory, html=True), name="sdk")
if get_settings().site_directory.is_dir():
    app.mount("/site", StaticFiles(directory=get_settings().site_directory, html=True), name="site")
Db = Annotated[Session, Depends(session)]


def bearer_value(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer credential required")
    return authorization[7:]


def api_auth(authorization: Annotated[str | None, Header()] = None):
    token = bearer_value(authorization)
    if not secrets.compare_digest(
        token.encode(), get_settings().api_token.get_secret_value().encode()
    ):
        raise HTTPException(401, "Invalid API credential")


def user_auth(authorization: Annotated[str | None, Header()] = None) -> Principal:
    token = bearer_value(authorization)
    if secrets.compare_digest(
        token.encode(), get_settings().api_token.get_secret_value().encode()
    ):
        return Principal(kind="operator", is_admin=True)
    session_principal = verify_user_session_token(token)
    if session_principal is not None:
        return session_principal
    if token.count(".") == 2 and not token.startswith("wortlaut-read-"):
        claims = verify_dex_id_token(token)
        email = claims["email"].strip().lower()
        return Principal(
            kind="user",
            sub=claims["sub"],
            email=email,
            name=claims.get("name") or email,
            is_admin=is_admin_email(email),
        )
    raise HTTPException(401, "Invalid API or OIDC credential")


AuthPrincipal = Annotated[Principal, Depends(user_auth)]


class OidcExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=2048)
    code_verifier: str = Field(min_length=43, max_length=256)
    redirect_uri: str = Field(min_length=1, max_length=1024)
    nonce: str | None = Field(default=None, max_length=256)


class CalendarOAuthExchangeRequest(BaseModel):
    provider: CalendarOAuthProvider
    code: str = Field(min_length=1, max_length=2048)
    code_verifier: str = Field(min_length=43, max_length=256)
    redirect_uri: str = Field(min_length=1, max_length=1024)


class CalendarEventToggleRequest(BaseModel):
    enabled: bool


class RecordingRequest(BaseModel):
    meeting_url: str = Field(max_length=2048)
    provider: Provider | None = None
    starts_at: datetime
    ends_at: datetime
    title: str | None = Field(default=None, max_length=200)
    guest_name: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def valid(self):
        provider, normalized = normalize_meeting_url(self.meeting_url)
        if self.provider is not None and self.provider != provider:
            raise ValueError("Provider does not match meeting URL")
        self.provider, self.meeting_url = provider, normalized
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None:
            raise ValueError("Explicit timezone required")
        if self.ends_at <= self.starts_at:
            raise ValueError("Meeting end must follow start")
        self.starts_at = self.starts_at.astimezone(UTC)
        self.ends_at = self.ends_at.astimezone(UTC)
        if self.title is not None:
            self.title = " ".join(self.title.split()) or None
        if self.guest_name is not None:
            self.guest_name = " ".join(self.guest_name.split()) or None
        return self


class ClaimRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)


class RtpSourceEvidence(BaseModel):
    source: int = Field(ge=0, le=2**32 - 1)
    timestamp: float = Field(ge=0, allow_inf_nan=False)
    rtp_timestamp: int = Field(ge=0, le=2**32 - 1)


class EncodedFrameEvidence(BaseModel):
    # Native frame/receive/capture clocks are evidence, not meeting sample time.
    timestamp: float = Field(allow_inf_nan=False)
    rtp_timestamp: int | None = Field(default=None, ge=0, le=2**32 - 1)
    synchronization_source: int | None = Field(default=None, ge=0, le=2**32 - 1)
    contributing_sources: list[Annotated[int, Field(ge=0, le=2**32 - 1)]] = Field(
        default_factory=list, max_length=64
    )
    payload_type: int | None = Field(default=None, ge=0, le=127)
    receive_time: float | None = Field(default=None, allow_inf_nan=False)
    capture_time: float | None = Field(default=None, allow_inf_nan=False)
    mime_type: str | None = Field(default=None, max_length=128)


class EncodedTransformEvidence(BaseModel):
    state: Literal[
        "unsupported", "failed", "waiting_frames", "observing", "metadata_unavailable",
        "provider_transform", "provider_reserved", "replaced", "stopped",
    ]
    frame_count: int = Field(ge=0)
    last_frame: EncodedFrameEvidence | None = None


class ReceiverEvidence(BaseModel):
    provider_source_id: str = Field(max_length=256)
    source_kind: Literal["speaker", "share_audio", "unknown"]
    capture_path: Literal["rtc_receiver", "sdk_stream"]
    track_id: str | None = Field(default=None, max_length=256)
    csi: int | None = Field(default=None, ge=0, le=2**32 - 1)
    signaled_participant_id: str | None = Field(default=None, max_length=256)
    participant_name: str | None = Field(default=None, max_length=200)
    source_state: str | None = Field(default=None, max_length=64)
    ssrc: list[RtpSourceEvidence] = Field(default_factory=list, max_length=64)
    csrc: list[RtpSourceEvidence] = Field(default_factory=list, max_length=64)
    encoded_transform: EncodedTransformEvidence | None = None

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("participant_name") is None:
            data.pop("participant_name", None)
        return data


class ParticipantSourceEvidence(BaseModel):
    participant_id: str = Field(min_length=1, max_length=256)
    participant_name: str | None = Field(default=None, max_length=200)
    audio_csis: list[Annotated[int, Field(ge=0, le=2**32 - 1)]] = Field(max_length=64)
    share_audio_csis: list[Annotated[int, Field(ge=0, le=2**32 - 1)]] = Field(max_length=64)

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("participant_name") is None:
            data.pop("participant_name", None)
        return data


class ParticipantEvidence(BaseModel):
    available: bool = False
    total: int = Field(default=0, ge=0)
    truncated: bool = False
    dom_participants: int | None = Field(default=None, ge=0)
    sources: list[ParticipantSourceEvidence] = Field(default_factory=list, max_length=256)

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("dom_participants") is None:
            data.pop("dom_participants", None)
        return data


class ClockInterruption(BaseModel):
    reason: Literal["suspended", "interrupted"]
    observed_start_utc: AwareDatetime
    observed_end_utc: AwareDatetime | None = None

    @model_validator(mode="after")
    def ordered(self):
        if self.observed_end_utc and self.observed_end_utc < self.observed_start_utc:
            raise ValueError("Interruption end precedes start")
        return self


class AudioClockEvidence(BaseModel):
    state: Literal["unknown", "running", "suspended", "interrupted", "closed"] = "unknown"
    total_interruptions: int = Field(default=0, ge=0)
    interruptions: list[ClockInterruption] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def consistent(self):
        if len(self.interruptions) > self.total_interruptions:
            raise ValueError("Interruption count contradicts intervals")
        return self


class DataChannelEvidence(BaseModel):
    label: str = Field(default="", max_length=128)
    ready_state: str = Field(default="unknown", max_length=32)
    text_frames: int = Field(default=0, ge=0)
    binary_frames: int = Field(default=0, ge=0)
    json_frames: int = Field(default=0, ge=0)
    json_keys: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        default_factory=list, max_length=32
    )
    wire_formats: list[Annotated[str, Field(min_length=1, max_length=32)]] = Field(
        default_factory=list, max_length=16
    )
    protobuf_fields: list[Annotated[str, Field(min_length=1, max_length=32)]] = Field(
        default_factory=list, max_length=32
    )


class SdpEvidence(BaseModel):
    descriptions: int = Field(default=0, ge=0)
    audio_sections: int = Field(default=0, ge=0)
    video_sections: int = Field(default=0, ge=0)
    ssrc_count: int = Field(default=0, ge=0)
    cname_count: int = Field(default=0, ge=0)
    msid_count: int = Field(default=0, ge=0)


class WorkerStatus(BaseModel):
    participation: Literal["joining", "waiting_admission", "capturing", "ended"]
    capability: Literal["unverified", "capability_unsupported", "verified"] = "unverified"
    reason: str = Field(default="", max_length=64, pattern=r"^[a-z0-9_]*$")
    streams: int = Field(default=0, ge=0, le=64)
    configured_speaker_slots: int | None = Field(default=None, ge=0, le=64)
    configured_share_slots: int | None = Field(default=None, ge=0, le=64)
    audio_samples: int = Field(default=0, ge=0)
    active_audio_samples: int = Field(default=0, ge=0)
    drained: bool | None = None
    receiver_sources: list[ReceiverEvidence] = Field(default_factory=list, max_length=64)
    participant_sources: ParticipantEvidence = Field(default_factory=ParticipantEvidence)
    data_channels: list[DataChannelEvidence] = Field(default_factory=list, max_length=32)
    sdp: SdpEvidence = Field(default_factory=SdpEvidence)
    audio_clock: AudioClockEvidence = Field(default_factory=AudioClockEvidence)


def recording_json(recording: Recording) -> dict:
    return {
        "id": str(recording.id),
        "provider": recording.provider,
        "title": recording.title,
        "guest_name": recording.guest_name,
        "owner_email": recording.owner_email,
        "starts_at": recording.starts_at,
        "ends_at": recording.ends_at,
        "participation": recording.participation,
        "processing": recording.processing,
        "processing_error": recording.processing_error,
        "participation_reason": recording.participation_reason,
        "cancelled_at": recording.cancelled_at,
        "audio_deleted_at": recording.audio_deleted_at,
        "transcript_deleted_at": recording.transcript_deleted_at,
        "metadata_deleted_at": recording.metadata_deleted_at,
        "active_attempt_id": str(recording.active_attempt_id)
        if recording.active_attempt_id
        else None,
        "calendar_entry_id": str(recording.calendar_entry_id)
        if recording.calendar_entry_id
        else None,
        "calendar_conflict": recording.calendar_conflict,
        "recurrence_key": recording.recurrence_key,
    }


@app.get("/", response_class=HTMLResponse)
@app.get("/ui", response_class=HTMLResponse)
@app.get("/auth/callback", response_class=HTMLResponse)
def web_ui():
    return HTMLResponse(render_ui(), headers={"Cache-Control": "no-store"})


@app.get("/privacy", response_class=HTMLResponse)
def privacy_page():
    return HTMLResponse(render_privacy(), headers={"Cache-Control": "no-store"})


@app.post("/v1/auth/oidc/exchange")
def oidc_exchange(body: OidcExchangeRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return exchange_oidc_code(
        code=body.code,
        code_verifier=body.code_verifier,
        redirect_uri=body.redirect_uri,
        nonce=body.nonce,
    )


@app.get("/v1/auth/me")
def auth_me(principal: AuthPrincipal):
    return {
        "kind": principal.kind,
        "sub": principal.sub,
        "email": principal.email,
        "name": principal.name,
        "is_admin": principal.is_admin,
    }


@app.get("/health/live")
def live():
    return {"status": "ok"}


@app.get("/health/ready")
def ready():
    with get_engine().connect() as connection:
        connection.execute(text("SELECT 1"))
    if get_settings().s3_access_key:
        storage = get_storage()
        storage.client.head_bucket(Bucket=storage.bucket)
    return {"status": "ready"}


@app.post("/v1/recordings")
def create_recording(
    body: RecordingRequest,
    db: Db,
    principal: AuthPrincipal,
    idempotency_key: Annotated[str, Header(min_length=1, max_length=200)],
):
    payload = body.model_dump(mode="json")
    # Webex requests retain their pre-provider digest, including old clients'
    # idempotency keys. Explicit and inferred providers have the same identity.
    if body.provider == "webex":
        payload.pop("provider")
    if body.title is None:
        payload.pop("title", None)
    if body.guest_name is None:
        payload.pop("guest_name", None)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    existing = db.scalar(select(Recording).where(Recording.idempotency_key == idempotency_key))
    if existing:
        if existing.request_digest != digest or not can_access_recording(db, principal, existing):
            raise HTTPException(409, "Idempotency key already has a different request")
        return recording_json(existing)
    if capacity_reached(db):
        raise HTTPException(503, "audio_capacity_limit")
    recording = Recording(
        idempotency_key=idempotency_key,
        request_digest=digest,
        owner_sub=principal.sub,
        owner_email=principal.email.lower() if principal.email else None,
        **body.model_dump(),
    )
    db.add(recording)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Recording).where(Recording.idempotency_key == idempotency_key))
        if (
            existing is None
            or existing.request_digest != digest
            or not can_access_recording(db, principal, existing)
        ):
            raise HTTPException(409, "Conflicting recording request") from None
        return recording_json(existing)
    return recording_json(recording)


@app.post("/v1/calendar/messages")
async def import_calendar_message(request: Request, db: Db, principal: AuthPrincipal):
    raw = bytearray()
    async for part in request.stream():
        raw.extend(part)
        if len(raw) > get_settings().max_mail_bytes:
            raise HTTPException(413, "Mail exceeds size limit")
    result = await run_in_threadpool(import_mail, db, bytes(raw))
    if principal.kind == "user" and principal.email:
        for item in result:
            rec_id = item.get("recording_id")
            if rec_id:
                rec = db.get(Recording, uuid.UUID(str(rec_id)))
                if rec and not rec.owner_email:
                    rec.owner_sub = principal.sub
                    rec.owner_email = principal.email.lower()
    db.commit()
    return {"events": result}


@app.get("/v1/calendar")
def calendar_status(db: Db, principal: AuthPrincipal):
    cal_query = select(CalendarEntry).order_by(CalendarEntry.dtstamp.desc())
    conn_query = select(CalendarConnection).order_by(CalendarConnection.created_at.desc())
    synced_query = select(CalendarSyncedEvent).order_by(CalendarSyncedEvent.starts_at.asc())
    if not principal.is_admin:
        user_email = (principal.email or "").lower()
        cal_query = cal_query.where(func.lower(CalendarEntry.organizer) == user_email)
        conn_query = conn_query.where(func.lower(CalendarConnection.owner_email) == user_email)
        synced_query = synced_query.where(
            func.lower(CalendarSyncedEvent.owner_email) == user_email
        )
    entries = db.scalars(cal_query.limit(128)).all()
    result = []
    for entry in entries:
        recordings = db.scalars(
            select(Recording).where(Recording.calendar_entry_id == entry.id)
        ).all()
        item = entry_json(entry, recordings[0] if len(recordings) == 1 else None)
        item["recording_ids"] = [str(r.id) for r in recordings]
        result.append(item)

    connections = [connection_json(c) for c in db.scalars(conn_query).all()]
    synced_rows = db.scalars(synced_query.limit(200)).all()
    rec_ids = [ev.recording_id for ev in synced_rows if ev.recording_id]
    rec_map = (
        {
            r.id: r
            for r in db.scalars(select(Recording).where(Recording.id.in_(rec_ids))).all()
        }
        if rec_ids
        else {}
    )
    synced_events = [
        synced_event_json(ev, rec_map.get(ev.recording_id) if ev.recording_id else None)
        for ev in synced_rows
    ]
    return {
        "events": result,
        "connections": connections,
        "synced_events": synced_events,
    }


@app.post("/v1/calendar/oauth/exchange")
def calendar_oauth_exchange(
    body: CalendarOAuthExchangeRequest,
    db: Db,
    response: Response,
    principal: AuthPrincipal,
):
    response.headers["Cache-Control"] = "no-store"
    return exchange_calendar_oauth_code(
        db=db,
        principal=principal,
        provider=body.provider,
        code=body.code,
        code_verifier=body.code_verifier,
        redirect_uri=body.redirect_uri,
    )


@app.post("/v1/calendar/oauth/connections/{connection_id}/sync")
def calendar_oauth_sync_now(
    connection_id: uuid.UUID, db: Db, principal: AuthPrincipal
):
    conn = db.scalar(
        select(CalendarConnection)
        .where(CalendarConnection.id == connection_id)
        .with_for_update()
    )
    if conn is None:
        raise HTTPException(404, "Calendar connection not found")
    user_email = (principal.email or "operator@local").lower()
    if not principal.is_admin and conn.owner_email.lower() != user_email:
        raise HTTPException(404, "Calendar connection not found")
    synced = sync_connection(db, conn)
    db.commit()
    return {
        "connection": connection_json(conn),
        "synced_events": [synced_event_json(ev) for ev in synced],
    }


@app.delete("/v1/calendar/oauth/connections/{connection_id}")
def calendar_oauth_disconnect(
    connection_id: uuid.UUID, db: Db, principal: AuthPrincipal
):
    conn = db.scalar(
        select(CalendarConnection)
        .where(CalendarConnection.id == connection_id)
        .with_for_update()
    )
    if conn is None:
        raise HTTPException(404, "Calendar connection not found")
    user_email = (principal.email or "operator@local").lower()
    if not principal.is_admin and conn.owner_email.lower() != user_email:
        raise HTTPException(404, "Calendar connection not found")
    now = datetime.now(UTC)
    linked_events = db.scalars(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.connection_id == conn.id)
        .with_for_update()
    ).all()
    for ev in linked_events:
        if ev.recording_id:
            rec = db.scalar(
                select(Recording)
                .where(Recording.id == ev.recording_id)
                .with_for_update()
            )
            if rec and rec.participation == "scheduled" and rec.cancelled_at is None:
                request_cancellation(rec, now)
    db.execute(
        delete(CalendarSyncedEvent).where(CalendarSyncedEvent.connection_id == conn.id)
    )
    db.delete(conn)
    db.commit()
    return {"deleted": True, "id": str(connection_id)}


@app.post("/v1/calendar/oauth/events/{event_id}/toggle")
def calendar_oauth_toggle_event(
    event_id: uuid.UUID,
    body: CalendarEventToggleRequest,
    db: Db,
    principal: AuthPrincipal,
):
    return toggle_synced_event(db, principal, event_id, body.enabled)


@app.get("/metrics", dependencies=[Depends(api_auth)])
def prometheus_metrics(db: Db):
    rec_rows = db.execute(
        select(
            Recording.provider,
            Recording.participation,
            Recording.processing,
            func.count(),
        ).group_by(Recording.provider, Recording.participation, Recording.processing)
    ).all()
    active_attempts = (
        db.scalar(select(func.count(Attempt.id)).where(Attempt.ended_at.is_(None))) or 0
    )
    asr_rows = db.execute(select(AsrJob.status, func.count()).group_by(AsrJob.status)).all()
    stored_samples, stored_bytes = db.execute(
        select(
            func.coalesce(func.sum(AudioChunk.sample_count), 0),
            func.coalesce(func.sum(AudioChunk.object_size), 0),
        ).where(AudioChunk.deleted_at.is_(None))
    ).one()
    lines = [
        "# HELP wortlaut_recordings_total Total recordings by provider and state.",
        "# TYPE wortlaut_recordings_total gauge",
    ]
    for prov, part, proc, count in rec_rows:
        lines.append(
            f'wortlaut_recordings_total{{provider="{prov}",participation="{part}",'
            f'processing="{proc}"}} {count}'
        )
    lines.extend(
        [
            "# HELP wortlaut_active_attempts Currently active worker attempts.",
            "# TYPE wortlaut_active_attempts gauge",
            f"wortlaut_active_attempts {active_attempts}",
            "# HELP wortlaut_asr_jobs_total Total ASR jobs by status.",
            "# TYPE wortlaut_asr_jobs_total gauge",
        ]
    )
    for status, count in asr_rows:
        lines.append(f'wortlaut_asr_jobs_total{{status="{status}"}} {count}')
    lines.extend(
        [
            "# HELP wortlaut_stored_audio_samples Active stored audio samples.",
            "# TYPE wortlaut_stored_audio_samples gauge",
            f"wortlaut_stored_audio_samples {stored_samples}",
            "# HELP wortlaut_stored_audio_bytes Active stored S3 audio bytes.",
            "# TYPE wortlaut_stored_audio_bytes gauge",
            f"wortlaut_stored_audio_bytes {stored_bytes}",
        ]
    )
    return Response(
        "\n".join(lines) + "\n",
        media_type="text/plain; version=0.0.4; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/v1/recordings")
def list_recordings(
    db: Db,
    principal: AuthPrincipal,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    provider: Provider | None = None,
    participation: Annotated[str | None, Query(max_length=128)] = None,
    processing: Annotated[str | None, Query(max_length=32)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    order: Literal["asc", "desc"] = "asc",
    starts_from: datetime | None = None,
    starts_before: datetime | None = None,
):
    for value in (starts_from, starts_before):
        if value is not None and value.tzinfo is None:
            raise HTTPException(422, "Explicit timezone required")
    if starts_from and starts_before and starts_from >= starts_before:
        raise HTTPException(422, "Invalid start-time interval")
    query = select(Recording, Delivery).outerjoin(Delivery)
    unstarted_cancelled_cal = and_(
        Recording.idempotency_key.like("cal-oauth-%"),
        Recording.participation == "ended",
        Recording.participation_reason == "cancelled",
        ~select(Attempt.id).where(Attempt.recording_id == Recording.id).exists(),
    )
    query = query.where(~unstarted_cancelled_cal)
    if not principal.is_admin:
        pred = user_recording_access_predicate(principal)
        if pred is False:
            return {"items": [], "next_cursor": None}
        query = query.where(pred)
    if provider:
        query = query.where(Recording.provider == provider)
    if participation:
        parts = [p.strip() for p in participation.split(",") if p.strip()]
        if len(parts) == 1:
            query = query.where(Recording.participation == parts[0])
        elif parts:
            query = query.where(Recording.participation.in_(parts))
    if processing:
        query = query.where(Recording.processing == processing)
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
        query = query.where(
            or_(
                Recording.title.ilike(needle),
                Recording.guest_name.ilike(needle),
                segment_match,
                stream_match,
                attempt_match,
            )
        )
    if starts_from:
        query = query.where(Recording.starts_at >= starts_from)
    if starts_before:
        query = query.where(Recording.starts_at < starts_before)
    if cursor:
        try:
            anchor = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
            moment, identifier = datetime.fromisoformat(anchor["start"]), uuid.UUID(anchor["id"])
            if moment.tzinfo is None:
                raise ValueError("Timezone missing")
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise HTTPException(400, "Invalid recording cursor") from None
        if order == "desc":
            query = query.where(
                tuple_(Recording.starts_at, Recording.id) < tuple_(moment, identifier)
            )
        else:
            query = query.where(
                tuple_(Recording.starts_at, Recording.id) > tuple_(moment, identifier)
            )
    sort_cols = (
        (Recording.starts_at.desc(), Recording.id.desc())
        if order == "desc"
        else (Recording.starts_at, Recording.id)
    )
    rows = db.execute(query.order_by(*sort_cols).limit(limit + 1)).all()
    page, identifiers = rows[:limit], [r.id for r, _ in rows[:limit]]
    # Read page-wide aggregates rather than full chunk/participant histories.
    audio = {
        row[0]: row[1:]
        for row in db.execute(
            select(
                Attempt.recording_id,
                func.coalesce(func.sum(AudioChunk.sample_count), 0),
                func.bool_or(AudioChunk.contract["attribution_unknown"].as_boolean()),
                func.bool_or(AudioChunk.processing_error.is_not(None)),
            )
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .join(AudioChunk, AudioChunk.stream_id == AudioStream.id)
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id)
        )
    }
    sources = dict(
        db.execute(
            select(Attempt.recording_id, func.bool_or(AudioStream.final_sample.is_(None)))
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id)
        ).all()
    )
    drains = dict(
        db.execute(
            select(
                Attempt.recording_id,
                func.bool_or(Attempt.diagnostics["drained"].as_boolean().is_(False)),
            )
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id)
        ).all()
    )
    clocks = dict(
        db.execute(
            select(
                Attempt.recording_id,
                func.bool_or(
                    Attempt.diagnostics["audio_clock"]["total_interruptions"].as_integer() > 0
                ),
            )
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id)
        ).all()
    )
    failures = dict(
        db.execute(
            select(Attempt.recording_id, func.count())
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .join(AsrJob, AsrJob.stream_id == AudioStream.id)
            .where(Attempt.recording_id.in_(identifiers), AsrJob.status == "failed")
            .group_by(Attempt.recording_id)
        ).all()
    )
    bound_stream_control = (
        select(AudioControl.id)
        .where(
            AudioControl.stream_id == AudioStream.id,
            AudioControl.kind == "bind",
            AudioControl.contract["attribution_unknown"].as_boolean().is_(False),
        )
        .exists()
    )
    seg_attribution = {
        row[0]: (row[1], bool(row[2]))
        for row in db.execute(
            select(
                Attempt.recording_id,
                func.count(TranscriptSegment.id),
                func.bool_or(
                    TranscriptSegment.result["attribution_unknown"].as_boolean().is_(True)
                    & AudioStream.contract["attribution_unknown"].as_boolean().is_(True)
                    & ~bound_stream_control
                ),
            )
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .join(AsrJob, AsrJob.stream_id == AudioStream.id)
            .join(TranscriptSegment, TranscriptSegment.id == AsrJob.id)
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id)
        )
    }
    gaps = dict(
        db.execute(
            select(Attempt.recording_id, func.count())
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .join(AudioControl, AudioControl.stream_id == AudioStream.id)
            .outerjoin(
                AudioChunk,
                (AudioChunk.stream_id == AudioStream.id)
                & (AudioChunk.sequence == AudioControl.sequence),
            )
            .where(
                Attempt.recording_id.in_(identifiers),
                AudioControl.kind == "gap",
                AudioControl.contract["final"].as_boolean().is_(True),
                AudioChunk.id.is_(None),
            )
            .group_by(Attempt.recording_id)
        ).all()
    )
    items = []
    for recording, delivery in page:
        samples, raw_unknown, unreadable = audio.get(recording.id, (0, False, False))
        seg_count, seg_unknown = seg_attribution.get(recording.id, (0, False))
        unknown = seg_unknown if seg_count > 0 else raw_unknown
        incomplete_drain = drains.get(recording.id, False)
        failed = bool(failures.get(recording.id) or unreadable or recording.processing == "failed")
        status = (
            "pending"
            if recording.processing not in ("completed", "failed")
            else "no_audio_received"
            if not samples
            else "incomplete"
            if unknown
            or failed
            or incomplete_drain
            or gaps.get(recording.id)
            or clocks.get(recording.id)
            else "unverified"
        )
        items.append(
            {
                **recording_json(recording),
                "delivery": delivery_json(delivery),
                "quality": {
                    "status": status,
                    "no_audio_received": not samples,
                    "durable_sample_count": samples,
                    "attribution_unknown": bool(unknown),
                    "capture_end_unknown": sources.get(recording.id, True),
                    "incomplete_drain": bool(incomplete_drain),
                    "audio_clock_interrupted": bool(clocks.get(recording.id)),
                    "processing_failed": failed,
                    "finalized_gap_count": gaps.get(recording.id, 0),
                    "source_coverage": "unknown",
                },
            }
        )
    next_cursor = None
    if len(rows) > limit:
        last = page[-1][0]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps({"start": last.starts_at.isoformat(), "id": str(last.id)}).encode()
        ).decode()
    return {"items": items, "next_cursor": next_cursor}


def _authenticate_recording_access(
    db: Session,
    recording_id: uuid.UUID,
    authorization: str | None,
) -> tuple[Recording, Principal]:
    token = bearer_value(authorization)
    recording = db.get(Recording, recording_id)
    is_operator = secrets.compare_digest(
        token.encode(), get_settings().api_token.get_secret_value().encode()
    )
    if is_operator:
        principal = Principal(kind="operator", is_admin=True)
    elif verify_recording_reader_token(recording, token):
        principal = Principal(kind="reader", recording_id=recording.id if recording else None)
    else:
        principal = verify_user_session_token(token)
        if principal is None and token.count(".") == 2 and not token.startswith("wortlaut-read-"):
            claims = verify_dex_id_token(token)
            email = claims["email"].strip().lower()
            principal = Principal(
                kind="user",
                sub=claims["sub"],
                email=email,
                name=claims.get("name") or email,
                is_admin=is_admin_email(email),
            )
        if principal is None:
            raise HTTPException(401, "Invalid API credential")
    if not recording or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    return recording, principal


@app.get("/v1/recordings/{recording_id}")
def get_recording(
    recording_id: uuid.UUID,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    recording, principal = _authenticate_recording_access(db, recording_id, authorization)
    is_full_view = principal.kind in ("operator", "user")
    result = recording_json(recording)
    raw_delivery = delivery_json(db.get(Delivery, recording.id))
    if not is_full_view and isinstance(raw_delivery, dict):
        raw_delivery = {
            k: v
            for k, v in raw_delivery.items()
            if k not in ("accepted_recipients", "message_id")
        }
    result["delivery"] = raw_delivery
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    result["attempts"] = [
        {
            "id": str(a.id),
            "last_heartbeat_at": a.last_heartbeat_at,
            "ended_at": a.ended_at,
            "end_reason": a.end_reason,
            **(
                {
                    "diagnostics": a.diagnostics,
                    "job_name": a.job_name,
                    "job_uid": a.job_uid,
                    "pod_uids": a.pod_uids,
                    "process_ended_at": a.process_ended_at,
                }
                if is_full_view
                else {}
            ),
        }
        for a in attempts
    ]
    streams = db.scalars(
        select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
    ).all()
    result["audio"] = [
        {
            "stream_id": str(s.stream_id),
            "epoch": str(s.epoch),
            "segmented_until_sample": s.scan_sample,
            "segmentation_complete": s.scan_complete,
            **stream_quality(db, s),
        }
        for s in streams
    ]
    jobs = db.execute(
        select(
            AsrJob.status,
            func.count(),
            func.min(AsrJob.created_at),
            func.sum(AsrJob.end_sample - AsrJob.start_sample),
        )
        .where(AsrJob.stream_id.in_([s.id for s in streams]))
        .group_by(AsrJob.status)
    ).all()
    samples, chunks, last_audio, unsegmented = db.execute(
        select(
            func.coalesce(func.sum(AudioChunk.sample_count), 0),
            func.count(AudioChunk.id),
            func.max(AudioChunk.accepted_at),
            func.coalesce(
                func.sum(
                    func.greatest(
                        0,
                        AudioChunk.start_sample
                        + AudioChunk.sample_count
                        - func.greatest(AudioChunk.start_sample, AudioStream.scan_sample),
                    )
                ).filter(AudioStream.scan_complete.is_(False)),
                0,
            ),
        )
        .join(AudioStream)
        .where(AudioChunk.stream_id.in_([s.id for s in streams]))
    ).one()
    result["ingest"] = {
        "durable_sample_count": samples,
        "durable_chunk_count": chunks,
        "last_audio_activity": last_audio,
    }
    counts = {status: count for status, count, _, _ in jobs}
    ages = [created for status, _, created, _ in jobs if status in ("pending", "processing")]
    result["asr"] = {
        "pending": counts.get("pending", 0) + counts.get("processing", 0),
        "failed": counts.get("failed", 0),
        "completed": counts.get("completed", 0),
        "pending_source_seconds": (
            unsegmented
            + sum(
                duration for status, _, _, duration in jobs if status in ("pending", "processing")
            )
        )
        / RATE,
        "oldest_pending_seconds": max(0, (datetime.now(UTC) - min(ages)).total_seconds())
        if ages
        else None,
    }
    latest_attempt = attempts[-1] if attempts else None
    diag = latest_attempt.diagnostics if latest_attempt and latest_attempt.diagnostics else {}
    receivers = diag.get("receiver_sources", [])
    part_sources = diag.get("participant_sources", {})
    result["live_status"] = {
        "is_active": recording.participation
        in ("starting", "joining", "waiting_admission", "capturing")
        or recording.processing not in ("completed", "failed"),
        "participation": recording.participation,
        "processing": recording.processing,
        "active_streams": diag.get("streams", 0),
        "audio_seconds": round(samples / RATE, 1),
        "active_audio_seconds": round(diag.get("active_audio_samples", 0) / RATE, 1),
        "bound_receivers": sum(1 for r in receivers if r.get("signaled_participant_id")),
        "bound_named_receivers": sum(
            1 for r in receivers if r.get("signaled_participant_id") and r.get("participant_name")
        ),
        "total_receivers": len(receivers),
        "dom_or_signaled_participants": part_sources.get("total", 0),
        "named_participants": sum(
            1 for p in part_sources.get("sources", []) if p.get("participant_name")
        ),
        "dom_participants": part_sources.get("dom_participants") or 0,
        "data_channel_count": len(diag.get("data_channels", [])),
        "sdp_descriptions": diag.get("sdp", {}).get("descriptions", 0),
        "last_heartbeat_at": latest_attempt.last_heartbeat_at if latest_attempt else None,
        "last_audio_activity": last_audio,
    }
    return result


@app.post("/v1/recordings/{recording_id}/delivery/retry")
def retry_delivery(recording_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is not None and not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording is not None and recording.transcript_deleted_at is not None:
        raise HTTPException(410, "Transcript retention expired")
    delivery = db.scalar(
        select(Delivery).where(Delivery.recording_id == recording_id).with_for_update()
    )
    if delivery is None:
        raise HTTPException(404, "No delivery exists")
    if delivery.status not in ("failed", "delivery_unknown"):
        raise HTTPException(409, "Delivery is not awaiting a manual retry")
    delivery.status, delivery.error, delivery.retry_at, delivery.attempts = "pending", None, None, 0
    db.commit()
    return delivery_json(delivery)


@app.post("/v1/recordings/{recording_id}/reader-token")
def issue_reader_token(
    recording_id: uuid.UUID, db: Db, response: Response, principal: AuthPrincipal
):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at is not None:
        raise HTTPException(410, "Transcript retention expired")
    if recording.processing_finished_at is None:
        credential = chat_reader_token(recording)
    else:
        recording.export_reader_nonce = recording.export_reader_nonce or uuid.uuid4()
        db.commit()
        credential = export_reader_token(recording)
    if not credential:
        raise HTTPException(410, "Transcript retention expired")
    sig = credential.removeprefix("wortlaut-read-")
    response.headers["Cache-Control"] = "no-store"
    return {
        "recording_id": str(recording.id),
        "reader_token": credential,
        "ui_token": f"wortlaut-read-{recording.id}.{sig}",
    }


class ClaimRecordingAccessRequest(BaseModel):
    reader_token: str = Field(min_length=10, max_length=256)


@app.post("/v1/recordings/{recording_id}/claim-access")
def claim_recording_access(
    recording_id: uuid.UUID,
    body: ClaimRecordingAccessRequest,
    db: Db,
    principal: AuthPrincipal,
):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not verify_recording_reader_token(recording, body.reader_token):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at is not None or recording.metadata_deleted_at is not None:
        raise HTTPException(410, "Recording retention expired")
    user_email = (principal.email or "").strip().lower()
    if user_email and "@" in user_email:
        meta = dict(recording.protocol_meta or {})
        existing = {
            str(e).strip().lower()
            for e in (meta.get("attendee_emails") or [])
            if e and "@" in str(e)
        }
        if user_email not in existing:
            meta["attendee_emails"] = sorted(existing | {user_email})
            recording.protocol_meta = meta
            db.commit()
    return {"claimed": True, "recording_id": str(recording.id)}


@app.post("/v1/recordings/{recording_id}/attempts", dependencies=[Depends(api_auth)])
def prepare_attempt(recording_id: uuid.UUID, db: Db, response: Response):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if not recording:
        raise HTTPException(404, "Recording not found")
    if (
        recording.participation == "ended"
        or recording.ends_at <= datetime.now(UTC)
        or recording.cancelled_at
        or recording.audio_closed_at
        or recording.calendar_conflict
    ):
        raise HTTPException(409, "Recording has ended")
    if recording.active_attempt_id:
        raise HTTPException(409, "An attempt already owns this occurrence")
    attempt, token = new_attempt(db, recording, datetime.now(UTC))
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"attempt_id": str(attempt.id), "bootstrap_credential": token}


@app.post("/v1/recordings/{recording_id}/cancel")
def cancel_recording(recording_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    request_cancellation(recording, datetime.now(UTC))
    synced_for_rec = db.scalars(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.recording_id == recording.id)
        .with_for_update()
    ).all()
    for sev in synced_for_rec:
        sev.recording_id = None
        sev.user_override = False
        sev.auto_record = False
    db.commit()
    return recording_json(recording)


@app.delete("/v1/recordings/{recording_id}")
def delete_recording(recording_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.participation in ("starting", "joining", "waiting_admission", "capturing"):
        raise HTTPException(409, "Stop active recording before deleting")
    if get_settings().s3_access_key or recording.audio_deleted_at is None:
        try:
            get_storage().delete_recording(recording.id)
        except Exception:
            pass
    attempt_ids = db.scalars(select(Attempt.id).where(Attempt.recording_id == recording.id)).all()
    if attempt_ids:
        stream_ids = db.scalars(
            select(AudioStream.id).where(AudioStream.attempt_id.in_(attempt_ids))
        ).all()
        if stream_ids:
            job_ids = select(AsrJob.id).where(AsrJob.stream_id.in_(stream_ids))
            db.execute(delete(TranscriptSegment).where(TranscriptSegment.id.in_(job_ids)))
            db.execute(delete(AsrJob).where(AsrJob.stream_id.in_(stream_ids)))
            db.execute(delete(AudioControl).where(AudioControl.stream_id.in_(stream_ids)))
            db.execute(delete(AudioChunk).where(AudioChunk.stream_id.in_(stream_ids)))
            db.execute(delete(AudioStream).where(AudioStream.id.in_(stream_ids)))
        db.execute(delete(Attempt).where(Attempt.id.in_(attempt_ids)))
    db.execute(delete(Delivery).where(Delivery.recording_id == recording.id))
    synced_for_rec = db.scalars(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.recording_id == recording.id)
        .with_for_update()
    ).all()
    for sev in synced_for_rec:
        sev.recording_id = None
        sev.user_override = False
        sev.auto_record = False
    cal_id = recording.calendar_entry_id
    db.delete(recording)
    db.flush()
    if cal_id is not None:
        entry = db.get(CalendarEntry, cal_id)
        if entry is not None and not entry.recurrence_anchor:
            other = db.scalar(
                select(Recording.id).where(Recording.calendar_entry_id == cal_id).limit(1)
            )
            if other is None:
                entry.status = "cancelled"
    db.commit()
    return {"deleted": True, "id": str(recording_id)}


@app.post("/v1/recordings/{recording_id}/rejoin")
def rejoin_recording(recording_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.metadata_deleted_at or recording.transcript_deleted_at:
        raise HTTPException(410, "Recording retention expired")
    if recording.participation != "ended":
        raise HTTPException(409, "Recording is still active")
    if recording.active_attempt_id is not None:
        active = db.get(Attempt, recording.active_attempt_id)
        if active and active.ended_at is None:
            raise HTTPException(409, "Active attempt has not terminated yet")
    if capacity_reached(db):
        raise HTTPException(503, "audio_capacity_limit")
    now = datetime.now(UTC)
    if recording.ends_at <= now + timedelta(minutes=5):
        recording.ends_at = now + timedelta(minutes=60)
    recording.active_attempt_id = None
    recording.cancelled_at = None
    recording.audio_closed_at = None
    recording.participation = "scheduled"
    recording.participation_reason = None
    recording.processing = "pending"
    recording.processing_error = None
    recording.processing_finished_at = None
    existing_delivery = db.get(Delivery, recording.id)
    if existing_delivery is not None:
        db.delete(existing_delivery)
    db.commit()
    return recording_json(recording)


@app.get("/v1/recordings/{recording_id}/transcript")
def get_transcript(
    recording_id: uuid.UUID,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    recording, _ = _authenticate_recording_access(db, recording_id, authorization)
    if recording.transcript_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    return export_data(db, recording)


class ProtocolUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=20000)
    speaker_overrides: dict[str, str] | None = None
    term_replacements: dict[str, str] | None = None
    segment_edits: dict[str, str] | None = None


@app.patch("/v1/recordings/{recording_id}")
def update_recording_protocol(
    recording_id: uuid.UUID,
    body: ProtocolUpdateRequest,
    db: Db,
    principal: AuthPrincipal,
):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.metadata_deleted_at or recording.transcript_deleted_at:
        raise HTTPException(410, "Recording retention expired")
    if body.title is not None:
        cleaned_title = body.title.strip()
        recording.title = cleaned_title or None
    meta = dict(recording.protocol_meta or {})
    if body.notes is not None:
        meta["notes"] = body.notes[:20000]
    if body.speaker_overrides is not None:
        cur_speakers = dict(meta.get("speaker_overrides") or {})
        for k, v in body.speaker_overrides.items():
            key = str(k).strip()[:200]
            if not key:
                continue
            val = str(v).strip()[:120]
            if val:
                cur_speakers[key] = val
            else:
                cur_speakers.pop(key, None)
        meta["speaker_overrides"] = cur_speakers
    if body.term_replacements is not None:
        cur_terms = dict(meta.get("term_replacements") or {})
        for k, v in body.term_replacements.items():
            key = str(k).strip()[:120]
            if not key:
                continue
            val = str(v).strip()[:120]
            if val and val != key:
                cur_terms[key] = val
            else:
                cur_terms.pop(key, None)
        meta["term_replacements"] = cur_terms
    if body.segment_edits is not None:
        cur_edits = dict(meta.get("segment_edits") or {})
        for k, v in body.segment_edits.items():
            key = str(k).strip()[:120]
            if not key:
                continue
            val = str(v).strip()[:10000]
            if val:
                cur_edits[key] = val
            else:
                cur_edits.pop(key, None)
        meta["segment_edits"] = cur_edits
    recording.protocol_meta = meta
    db.commit()
    return export_data(db, recording)


@app.post("/v1/recordings/{recording_id}/summary")
def create_recording_summary(
    recording_id: uuid.UUID,
    db: Db,
    principal: AuthPrincipal,
):
    if not get_settings().enable_llm_summary:
        raise HTTPException(
            503, "KI-Zusammenfassung ist deaktiviert (WORTLAUT_ENABLE_LLM_SUMMARY=false)"
        )
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    try:
        summary = generate_protocol_summary(db, recording)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    except Exception as exc:
        raise HTTPException(502, f"KI-Zusammenfassung fehlgeschlagen: {exc}") from None
    return {"summary": summary}


@app.get("/v1/recordings/{recording_id}/audio-snippet")
def get_audio_snippet(
    recording_id: uuid.UUID,
    db: Db,
    start: Annotated[float, Query(ge=0.0)] = 0.0,
    end: Annotated[float, Query(ge=0.1)] = 5.0,
    stream_id: Annotated[str | None, Query(max_length=120)] = None,
    authorization: Annotated[str | None, Header()] = None,
):
    recording, _ = _authenticate_recording_access(db, recording_id, authorization)
    try:
        wav_bytes = extract_audio_snippet_wav(db, recording, stream_id, start, end)
    except LookupError as exc:
        raise HTTPException(404, f"Audio-Ausschnitt nicht verfügbar ({exc})") from None
    return Response(
        wav_bytes,
        media_type="audio/wav",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.get("/v1/recordings/{recording_id}/exports/{format}")
def get_export(
    recording_id: uuid.UUID,
    format: Literal["txt", "vtt", "json", "md"],
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    recording, _ = _authenticate_recording_access(db, recording_id, authorization)
    if recording.processing not in ("completed", "failed"):
        raise HTTPException(409, "Processing is still pending")
    if recording.transcript_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    content, media_type = render_export(export_data(db, recording), format)
    return Response(
        content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="wortlaut-{recording.id}.{format}"',
            "Cache-Control": "private, no-store",
        },
    )


def authenticated_attempt(
    attempt_id: uuid.UUID, db: Session, authorization: str | None, *, allow_ended: bool = False
) -> Attempt:
    token = bearer_value(authorization)
    attempt = db.get(Attempt, attempt_id)
    digest = hashlib.sha256(token.encode()).hexdigest()
    if (
        attempt is None
        or not secrets.compare_digest(attempt.credential_hash, digest)
        or attempt.credential_expires_at <= datetime.now(UTC)
        or (attempt.ended_at is not None and not allow_ended)
    ):
        raise HTTPException(401, "Invalid or expired attempt credential")
    return attempt


@app.post("/v1/attempts/{attempt_id}/claim")
def claim(
    attempt_id: uuid.UUID,
    body: ClaimRequest,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    attempt = authenticated_attempt(attempt_id, db, authorization)
    recording = db.scalar(
        select(Recording).where(Recording.id == attempt.recording_id).with_for_update()
    )
    db.refresh(attempt)
    if (
        recording.active_attempt_id != attempt.id
        or recording.participation in ("unknown", "ended")
        or recording.audio_closed_at is not None
        or recording.cancelled_at is not None
        or (recording.calendar_conflict and attempt.worker_id is None)
        or attempt.ended_at is not None
        or (attempt.worker_id is not None and attempt.worker_id != body.worker_id)
    ):
        raise HTTPException(409, "Occurrence is unavailable or owned by another worker")
    if attempt.worker_id is None:
        attempt.worker_id = body.worker_id
        recording.participation = "joining"
    db.commit()
    return {"claimed": True}


def _recording_inviter(db: Session, recording: Recording) -> str | None:
    if recording.owner_email:
        return recording.owner_email
    if recording.calendar_entry_id:
        entry = db.get(CalendarEntry, recording.calendar_entry_id)
        if entry and entry.organizer:
            return entry.organizer
    return None


def build_chat_intro(
    display_name: str,
    inviter: str | None,
    recording: Recording,
    settings,
) -> str | None:
    if not settings.enable_chat_intro:
        return None
    base_url = settings.api_url.rstrip("/")
    cred = chat_reader_token(recording)
    token_param = (
        f"&token=wortlaut-read-{recording.id}.{cred.removeprefix('wortlaut-read-')}"
        if cred
        else ""
    )
    recording_url = f"{base_url}/ui#view=meetings&id={recording.id}{token_param}"
    privacy_url = settings.privacy_url or f"{base_url}/privacy"
    bot_label = display_name.strip() or "wortlaut"
    who = inviter.strip() if inviter and inviter.strip() else "einem Teilnehmenden"
    return (
        f"Hallo! Ich bin {bot_label} und wurde von {who} eingeladen, "
        f"dieses Meeting zu protokollieren. "
        f"Protokoll: {recording_url} | Datenschutz-Info: {privacy_url}"
    )


@app.get("/v1/attempts/{attempt_id}/bootstrap")
def bootstrap(
    attempt_id: uuid.UUID,
    db: Db,
    response: Response,
    x_worker_id: Annotated[str, Header()],
    authorization: Annotated[str | None, Header()] = None,
):
    attempt = authenticated_attempt(attempt_id, db, authorization)
    recording = db.get(Recording, attempt.recording_id)
    if (
        recording.active_attempt_id != attempt.id
        or recording.participation in ("unknown", "ended")
        or recording.audio_closed_at is not None
        or recording.cancelled_at is not None
        or attempt.worker_id != x_worker_id
    ):
        raise HTTPException(409, "Claim this occurrence before bootstrap")
    settings = get_settings()
    response.headers["Cache-Control"] = "no-store"
    display_name = recording.guest_name or settings.assistant_name
    inviter = _recording_inviter(db, recording)
    chat_intro = build_chat_intro(display_name, inviter, recording, settings)
    common = {
        "provider": recording.provider,
        "meeting_id": str(recording.id),
        "attempt_id": str(attempt.id),
        "meeting_url": recording.meeting_url,
        "deadline": min(recording.ends_at, attempt.credential_expires_at - timedelta(seconds=30)),
        "lobby_timeout_seconds": settings.lobby_timeout_seconds,
        "empty_room_timeout_seconds": settings.empty_room_timeout_seconds,
        "invited_by": inviter,
        "chat_intro": chat_intro,
    }
    if recording.provider == "google_meet":
        if not settings.enable_google_meet:
            raise HTTPException(503, "google_meet_not_configured")
        return {
            **common,
            "meet": {
                "display_name": display_name,
                "locale": settings.meet_locale,
                "auth_mode": "account" if settings.meet_storage_state_secret else "guest",
            },
        }
    if recording.provider == "teams":
        if not settings.enable_teams:
            raise HTTPException(503, "teams_not_configured")
        return {**common, "teams": {
            "display_name": display_name, "locale": settings.teams_locale,
        }}
    if recording.provider == "zoom":
        if not settings.enable_zoom:
            raise HTTPException(503, "zoom_not_configured")
        return {
            **common,
            "zoom": {
                "display_name": display_name,
                "locale": settings.zoom_locale,
                "auth_mode": "account" if settings.zoom_storage_state_secret else "guest",
            },
        }
    if settings.enable_webex_browser:
        return {**common, "webex_browser": {"display_name": display_name}}
    issued_request_started = datetime.now(UTC)
    try:
        guest = guest_token(
            settings.webex_service_token.get_secret_value()
            if settings.webex_service_token
            else None,
            f"wortlaut:{recording.id}",
            display_name,
        )
        guest_deadline = issued_request_started + timedelta(seconds=guest["expires_in"] - 30)
        if guest_deadline <= datetime.now(UTC):
            raise WebexUnavailable("Webex guest lifetime is too short for safe participation")
    except (WebexUnavailable, httpx.HTTPError) as error:
        detail = str(error) if isinstance(error, WebexUnavailable) else "Webex request unavailable"
        raise HTTPException(503, detail) from None
    return {
        **common,
        "sdk_page_url": settings.sdk_page_url,
        "guest_expires_at": issued_request_started + timedelta(seconds=guest["expires_in"]),
        "guest": guest,
    }


@app.post("/v1/attempts/{attempt_id}/status")
def worker_status(
    attempt_id: uuid.UUID,
    body: WorkerStatus,
    db: Db,
    x_worker_id: Annotated[str, Header()],
    authorization: Annotated[str | None, Header()] = None,
):
    attempt = authenticated_attempt(attempt_id, db, authorization, allow_ended=True)
    recording = db.scalar(
        select(Recording).where(Recording.id == attempt.recording_id).with_for_update()
    )
    db.refresh(attempt)
    if recording.active_attempt_id != attempt.id or attempt.worker_id != x_worker_id:
        raise HTTPException(409, "Worker does not own this occurrence")
    if recording.participation == "ended" or attempt.ended_at is not None:
        if (
            body.participation == "ended"
            and attempt.ended_at is not None
            and attempt.end_reason == (body.reason or "normal")
            # Workers already running across an upgrade can replay a final report
            # stored before the drain/clock fields existed.
            and {
                "drained": None,
                "audio_clock": AudioClockEvidence().model_dump(),
                "data_channels": [],
                "active_audio_samples": 0,
                "sdp": SdpEvidence().model_dump(),
                **attempt.diagnostics,
            }
            == body.model_dump(mode="json", exclude={"participation"})
        ):
            return {"accepted": True}
        raise HTTPException(409, "Attempt has already ended")
    attempt.last_heartbeat_at = datetime.now(UTC)
    # Status is evidence about the current worker, not a provider acceptance test.
    attempt.diagnostics = body.model_dump(mode="json", exclude={"participation"})
    recording.participation = body.participation
    if body.participation == "ended":
        attempt.ended_at = datetime.now(UTC)
        attempt.end_reason = body.reason or "normal"
        recording.participation_reason = attempt.end_reason
        if (
            attempt.end_reason in FAILURE_REASONS
            and body.audio_samples == 0
            and recording.processing == "pending"
            and not db.scalar(
                select(AudioStream.id).where(AudioStream.attempt_id == attempt.id).limit(1)
            )
        ):
            recording.processing = "completed"
            recording.processing_finished_at = attempt.ended_at
    elif not recording.cancelled_at:
        recording.participation_reason = body.reason or None
    db.commit()
    record_worker_status_telemetry(recording, attempt, body)
    return {
        "accepted": True,
        "stop_requested": recording.cancelled_at is not None
        or recording.audio_closed_at is not None,
        "stop_reason": "cancelled" if recording.cancelled_at else "audio_retention_expired",
    }


def ingest_message(attempt_id, credential, worker_id, connection_id, frame):
    with Session(get_engine()) as db:
        attempt, recording = verify_owner(db, attempt_id, credential, worker_id, connection_id)
        if isinstance(frame, bytes):
            if not 4 <= len(frame) <= 168_196:
                raise HTTPException(400, "Invalid audio frame size")
            size = struct.unpack(">I", frame[:4])[0]
            if size > 8192 or size + 4 > len(frame):
                raise HTTPException(400, "Invalid audio metadata size")
            metadata = json.loads(frame[4 : 4 + size])
            return accept_chunk(db, attempt, recording, metadata, frame[4 + size :])
        if len(frame.encode()) > 8192:
            raise HTTPException(400, "Control message is too large")
        return accept_control(db, attempt, recording, json.loads(frame))


@app.websocket("/v1/attempts/{attempt_id}/audio")
async def audio_socket(socket: WebSocket, attempt_id: uuid.UUID):
    await socket.accept()
    try:
        first = await asyncio.wait_for(socket.receive_text(), timeout=10)
        if len(first) > 4096:
            await socket.close(1008)
            return
        authentication = json.loads(first)
        if not isinstance(authentication, dict):
            raise HTTPException(400, "Authentication object required")
        credential, worker_id = authentication["credential"], authentication["worker_id"]
        if (
            authentication.get("type") != "auth"
            or not isinstance(credential, str)
            or not isinstance(worker_id, str)
            or len(worker_id) > 128
        ):
            await socket.close(1008)
            return

        connection_id = uuid.uuid4()

        def check_owner():
            with Session(get_engine()) as db:
                attempt, _ = verify_owner(db, attempt_id, credential, worker_id)
                attempt.audio_connection_id = connection_id
                db.commit()

        await run_in_threadpool(check_owner)
        await socket.send_json({"type": "ready"})
        while True:
            message = await socket.receive()
            if message["type"] == "websocket.disconnect":
                return
            frame = message.get("bytes") if message.get("bytes") is not None else message["text"]
            identifier = await run_in_threadpool(
                ingest_message, attempt_id, credential, worker_id, connection_id, frame
            )
            await socket.send_json({"type": "ack", "id": identifier})
    except WebSocketDisconnect:
        return
    except (TimeoutError, HTTPException, ValidationError, ValueError, KeyError, TypeError) as error:
        reason = (
            error.detail
            if isinstance(error, HTTPException)
            and error.detail
            in {"audio_capacity_limit", "audio_ingest_rate_limit", "audio_metadata_capacity_limit"}
            else "ingest_rejected"
        )
        await socket.send_json({"type": "error", "reason": reason})
        await socket.close(1008)
    except Exception:
        # Temporary DB/storage failures do not ACK. Worker retains immutable frames
        # and reconnects, including after an object write without a DB commit.
        await socket.close(1011)
