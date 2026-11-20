import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import struct
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import parse_qs

import httpx
from botocore.exceptions import BotoCoreError, ClientError
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
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import (
    AwareDatetime,
    BaseModel,
    Field,
    ValidationError,
    model_serializer,
    model_validator,
)
from sqlalchemy import delete, func, select, text, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from wortlaut.asr import finalize_processing, inference_pass, keyframe_context_pass
from wortlaut.calendar import imap_pass, import_mail
from wortlaut.calendar_oauth import (
    CalendarOAuthProvider,
    apply_synced_events,
    calendar_oauth_pass,
    connection_json,
    exchange_calendar_oauth_code,
    fetch_connection_events_unlocked,
    publish_protocol_link_to_calendar_events,
    snapshot_connection,
    synced_event_json,
    toggle_synced_event,
)
from wortlaut.controller import controller_pass, new_attempt, request_cancellation
from wortlaut.database import get_engine, session
from wortlaut.domain import (
    apply_protocol_metadata_fields,
    apply_recordings_search_filters,
    cancel_recording_and_unlink_calendar,
    query_calendar_overview,
)
from wortlaut.exports import (
    chat_reader_token,
    export_data,
    export_reader_token,
    extract_audio_snippet_wav,
    generate_protocol_summary,
    render_export,
    resolve_citation_timestamp,
    verify_recording_reader_token,
)
from wortlaut.glossary import (
    GlossaryScopeInput,
    delete_glossary_entry,
    get_glossary_overview,
    upsert_glossary_entries,
)
from wortlaut.ingest import (
    MAX_KEYFRAME_BYTES,
    KeyframeIngestMetadata,
    accept_chunk,
    accept_control,
    capacity_reached,
    ingest_keyframe,
    verify_owner,
)
from wortlaut.languages import (
    effective_recording_language,
    normalize_asr_language,
)
from wortlaut.mail import FAILURE_REASONS, delivery_json, smtp_pass
from wortlaut.mcp_oauth import (
    authorization_server_metadata,
    cors_oauth_headers,
    exchange_oauth_token,
    handle_mcp_oidc_callback,
    is_mcp_oidc_callback,
    list_user_mcp_grants,
    oauth_error_json,
    protected_resource_metadata,
    public_origin,
    register_oauth_client,
    revoke_oauth_token,
    revoke_user_mcp_grant,
    start_oauth_authorization,
    submit_oauth_consent,
    verify_mcp_access_token_principal,
)
from wortlaut.mcp_server import (
    handle_mcp_delete,
    handle_mcp_get,
    handle_mcp_post,
    mcp_cors_headers,
    validate_mcp_origin,
)
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
    RecordingKeyframe,
    TranscriptSegment,
)
from wortlaut.oidc import (
    Principal,
    can_access_recording,
    exchange_oidc_code,
    get_oidc_authorization_endpoint,
    is_admin_email,
    verify_dex_id_token,
    verify_user_session_token,
)
from wortlaut.processing import (
    RATE,
    is_keyframe_opted_out,
    purge_opted_out_keyframes,
    purge_opted_out_transcript_segments,
    segmentation_pass,
    stream_quality,
)
from wortlaut.rag import (
    invalidate_recording_rag_index,
    purge_recording_rag_chunks,
    rag_index_pass,
)
from wortlaut.recurrence import recurrence_pass
from wortlaut.retention import retention_pass
from wortlaut.settings import get_settings
from wortlaut.storage import ObjectConflict, get_storage
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
                (keyframe_context_pass, 5),
                (finalize_processing, 2),
                (rag_index_pass, 5),
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


app = FastAPI(
    title="wortlaut",
    version="0.1.0",
    description=(
        "Self-hosted, pre-mix WebRTC speaker-isolated meeting transcription and protocol API "
        "for Google Meet, Microsoft Teams, Cisco Webex, and Zoom — including OAuth2 calendar "
        "sync & writeback, settled screen-share keyframes, live in-call chat controls "
        "(`no` / `opt out`, `#pause` / `#resume`), and an authenticated OAuth 2.1 "
        "Model Context Protocol (MCP) Streamable HTTP server at `/mcp`."
    ),
    lifespan=lifespan,
)
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


class GlossaryUpsertRequest(BaseModel):
    scope: GlossaryScopeInput = "auto"
    term: str | None = Field(default=None, max_length=200)
    aliases: (
        Annotated[list[Annotated[str, Field(max_length=120)]], Field(max_length=64)]
        | Annotated[str, Field(max_length=2048)]
        | None
    ) = None
    raw_text: str | None = Field(default=None, max_length=16384)
    replace_aliases: bool = False
    previous_term_key: str | None = Field(default=None, max_length=120)


class RecordingRequest(BaseModel):
    meeting_url: str = Field(max_length=2048)
    provider: Provider | None = None
    starts_at: datetime
    ends_at: datetime
    title: str | None = Field(default=None, max_length=200)
    guest_name: str | None = Field(default=None, max_length=120)
    language: str | None = Field(default=None, max_length=200)

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
        if self.language is not None:
            self.language = normalize_asr_language(self.language)
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


class InboundAudioStatsEvidence(BaseModel):
    """Cumulative WebRTC receive counters of one audio receiver (getStats)."""

    packets_received: int = Field(default=0, ge=0)
    bytes_received: int = Field(default=0, ge=0)
    packets_lost: int = Field(default=0, ge=0)
    jitter_buffer_emitted_count: int = Field(default=0, ge=0)
    total_samples_received: int = Field(default=0, ge=0)
    concealed_samples: int = Field(default=0, ge=0)
    silent_concealed_samples: int = Field(default=0, ge=0)
    total_audio_energy: float = Field(default=0.0, ge=0.0)
    audio_level: float | None = Field(default=None, ge=0.0, le=1.0)
    last_packet_ms_ago: int | None = Field(default=None, ge=0)
    codec: str | None = Field(default=None, max_length=64)


class PeerConnectionEvidence(BaseModel):
    connection_state: str = Field(default="unknown", max_length=32)
    ice_connection_state: str = Field(default="unknown", max_length=32)
    dtls_state: str | None = Field(default=None, max_length=32)
    selected_pair_state: str | None = Field(default=None, max_length=32)
    selected_pair_bytes_received: int | None = Field(default=None, ge=0)
    in_frame: bool = False
    audio_receivers: int = Field(default=0, ge=0)
    inbound_audio_packets: int = Field(default=0, ge=0)


class AudioElementEvidence(BaseModel):
    meet_total: int = Field(default=0, ge=0)
    meet_playing: int = Field(default=0, ge=0)
    meet_muted: int = Field(default=0, ge=0)
    # Live audio tracks Meet plays that no captured peer connection receives.
    meet_foreign_tracks: int = Field(default=0, ge=0)
    keepalive_total: int = Field(default=0, ge=0)
    keepalive_playing: int = Field(default=0, ge=0)


class MediaEvidence(BaseModel):
    """Last pre-stop snapshot of the worker's WebRTC and playout state."""

    peer_connections: list[PeerConnectionEvidence] = Field(default_factory=list, max_length=16)
    audio_elements: AudioElementEvidence = Field(default_factory=AudioElementEvidence)
    frames: int = Field(default=0, ge=0)
    stats_age_ms: int | None = Field(default=None, ge=0)


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
    rtp_stats: InboundAudioStatsEvidence | None = None

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("participant_name") is None:
            data.pop("participant_name", None)
        if data.get("rtp_stats") is None:
            data.pop("rtp_stats", None)
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


class PauseWindowEvidence(BaseModel):
    started_at: AwareDatetime
    ended_at: AwareDatetime | None = None
    by: str | None = Field(default=None, max_length=200)

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("by") is None:
            data.pop("by", None)
        return data


class ParticipantEvidence(BaseModel):
    available: bool = False
    total: int = Field(default=0, ge=0)
    truncated: bool = False
    dom_participants: int | None = Field(default=None, ge=0)
    sources: list[ParticipantSourceEvidence] = Field(default_factory=list, max_length=256)
    opted_out: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=64
    )
    paused: bool = False
    pause_windows: list[PauseWindowEvidence] = Field(default_factory=list, max_length=64)

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("dom_participants") is None:
            data.pop("dom_participants", None)
        if not data.get("opted_out"):
            data.pop("opted_out", None)
        if not data.get("paused"):
            data.pop("paused", None)
        if not data.get("pause_windows"):
            data.pop("pause_windows", None)
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


class KeyframeAttemptTelemetry(BaseModel):
    capability: Literal["disabled", "unsupported", "unverified", "active"] = "unverified"
    active_share: bool = False
    evaluated_ticks: int = Field(default=0, ge=0)
    emitted: int = Field(default=0, ge=0)
    uploaded: int = Field(default=0, ge=0)
    dropped_unverified: int = Field(default=0, ge=0)
    dropped_opted_out: int = Field(default=0, ge=0)
    dropped_queue_full: int = Field(default=0, ge=0)


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
    keyframes: KeyframeAttemptTelemetry | None = None
    media: MediaEvidence | None = None

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        if data.get("media") is None:
            data.pop("media", None)
        return data


def recording_json(recording: Recording) -> dict:
    return {
        "id": str(recording.id),
        "provider": recording.provider,
        "title": recording.title,
        "guest_name": recording.guest_name,
        "language": effective_recording_language(recording, get_settings()),
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
def web_ui():
    return HTMLResponse(render_ui(), headers={"Cache-Control": "no-store"})


@app.get("/auth/callback")
def auth_callback_page(request: Request):
    if is_mcp_oidc_callback(request):
        with Session(get_engine()) as db:
            return handle_mcp_oidc_callback(request, db)
    return HTMLResponse(render_ui(), headers={"Cache-Control": "no-store"})


async def _read_oauth_params(request: Request) -> dict[str, list[str]]:
    raw = await request.body()
    if len(raw) > 65536:
        raise ValueError("Request body exceeds maximum size")
    if not raw:
        return {}
    ctype = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if ctype == "application/json":
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("Expected JSON object")
        out: dict[str, list[str]] = {}
        for k, v in parsed.items():
            if v is None:
                continue
            if isinstance(v, list):
                out[str(k)] = [str(item) for item in v if item is not None]
            else:
                out[str(k)] = [str(v)]
        return out
    return parse_qs(raw.decode("utf-8"), keep_blank_values=True)


@app.options("/.well-known/oauth-protected-resource")
@app.options("/.well-known/oauth-protected-resource/mcp")
@app.options("/.well-known/oauth-authorization-server")
@app.options("/.well-known/openid-configuration")
@app.options("/oauth/register")
@app.options("/oauth/token")
@app.options("/oauth/revoke")
def oauth_cors_preflight():
    return Response(status_code=204, headers=cors_oauth_headers())


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/mcp")
def oauth_protected_resource_endpoint(request: Request):
    return JSONResponse(protected_resource_metadata(request), headers=cors_oauth_headers())


@app.get("/.well-known/oauth-authorization-server")
@app.get("/.well-known/openid-configuration")
def oauth_authorization_server_endpoint(request: Request):
    return JSONResponse(authorization_server_metadata(request), headers=cors_oauth_headers())


@app.post("/oauth/register")
async def oauth_register_endpoint(request: Request, db: Db):
    raw = await request.body()
    if len(raw) > 65536:
        return oauth_error_json("invalid_client_metadata", "Payload too large")
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        return oauth_error_json("invalid_client_metadata", "Invalid JSON body")
    if not isinstance(payload, dict):
        return oauth_error_json("invalid_client_metadata", "JSON object required")
    client_ip = request.client.host if request.client else None
    status_code, data = await run_in_threadpool(
        register_oauth_client, db, payload, client_ip=client_ip
    )
    return JSONResponse(data, status_code=status_code, headers=cors_oauth_headers())


@app.get("/oauth/authorize")
def oauth_authorize_endpoint(
    request: Request,
    db: Db,
    response_type: str | None = None,
    client_id: str | None = None,
    redirect_uri: str | None = None,
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
    state: str | None = None,
    scope: str | None = None,
    resource: str | None = None,
):
    return start_oauth_authorization(
        request,
        db,
        response_type=response_type,
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        state=state,
        scope=scope,
        resource=resource,
    )


@app.post("/oauth/consent")
async def oauth_consent_endpoint(request: Request, db: Db):
    try:
        multi = await _read_oauth_params(request)
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from None
    auth_id_raw = (multi.get("auth_id") or [""])[0]
    csrf_token = (multi.get("csrf_token") or [""])[0]
    decision = (multi.get("decision") or ["deny"])[0]
    scopes = multi.get("scopes") or []
    operator_token = (multi.get("operator_token") or [None])[0]
    return await run_in_threadpool(
        submit_oauth_consent,
        request,
        db,
        auth_id_raw=auth_id_raw,
        csrf_token=csrf_token,
        decision=decision,
        selected_scopes=scopes,
        operator_token=operator_token,
    )


@app.post("/oauth/token")
async def oauth_token_endpoint(request: Request, db: Db):
    try:
        multi = await _read_oauth_params(request)
    except (UnicodeDecodeError, ValueError) as exc:
        return oauth_error_json("invalid_request", str(exc))
    flat = {k: vals[0] for k, vals in multi.items() if vals}
    return await run_in_threadpool(exchange_oauth_token, request, db, flat)


@app.post("/oauth/revoke")
async def oauth_revoke_endpoint(request: Request, db: Db):
    try:
        multi = await _read_oauth_params(request)
    except (UnicodeDecodeError, ValueError):
        return oauth_error_json("invalid_request", "Malformed revocation payload")
    flat = {k: vals[0] for k, vals in multi.items() if vals}
    return await run_in_threadpool(revoke_oauth_token, request, db, flat)


@app.options("/mcp")
def mcp_options_endpoint(request: Request):
    validate_mcp_origin(request)
    return Response(status_code=204, headers=mcp_cors_headers(request))


@app.post("/mcp")
async def mcp_post_endpoint(
    request: Request,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    raw_body = await request.body()
    if len(raw_body) > 1_048_576:
        raise HTTPException(413, "MCP request payload exceeds 1 MiB")
    return await run_in_threadpool(handle_mcp_post, request, db, raw_body, authorization)


@app.get("/mcp")
def mcp_get_endpoint(
    request: Request,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    return handle_mcp_get(request, db, authorization)


@app.delete("/mcp")
def mcp_delete_endpoint(
    request: Request,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    return handle_mcp_delete(request, db, authorization)


@app.get("/v1/mcp/grants")
def list_mcp_grants_endpoint(request: Request, db: Db, principal: AuthPrincipal):
    origin = public_origin(request)
    return {
        "endpoint": f"{origin}/mcp",
        "grants": list_user_mcp_grants(db, principal),
    }


@app.delete("/v1/mcp/grants/{grant_id}")
def revoke_mcp_grant_endpoint(grant_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    if not revoke_user_mcp_grant(db, principal, grant_id):
        raise HTTPException(404, "MCP grant not found")
    return {"revoked": True, "id": str(grant_id)}


@app.get("/privacy", response_class=HTMLResponse)
def privacy_page(lang: str | None = None):
    return HTMLResponse(render_privacy(lang=lang), headers={"Cache-Control": "no-store"})


@app.get("/v1/auth/oidc/config")
def oidc_config_endpoint(response: Response):
    s = get_settings()
    response.headers["Cache-Control"] = "no-store"
    if not s.oidc_issuer:
        return {"enabled": False, "authorization_endpoint": "", "client_id": ""}
    return {
        "enabled": True,
        "issuer": s.oidc_issuer,
        "authorization_endpoint": get_oidc_authorization_endpoint(),
        "client_id": s.oidc_client_id,
    }


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


@app.get("/v1/glossary")
def get_glossary_endpoint(db: Db, response: Response, principal: AuthPrincipal):
    response.headers["Cache-Control"] = "no-store"
    return get_glossary_overview(db, principal)


@app.post("/v1/glossary/entries")
def upsert_glossary_endpoint(
    body: GlossaryUpsertRequest,
    db: Db,
    response: Response,
    principal: AuthPrincipal,
):
    response.headers["Cache-Control"] = "no-store"
    return upsert_glossary_entries(
        db,
        principal,
        scope=body.scope,
        term=body.term,
        aliases=body.aliases,
        raw_text=body.raw_text,
        replace_aliases=body.replace_aliases,
        previous_term_key=body.previous_term_key,
    )


@app.delete("/v1/glossary/entries")
def delete_glossary_endpoint(
    db: Db,
    response: Response,
    principal: AuthPrincipal,
    term_key: Annotated[str, Query(min_length=1, max_length=120)],
    scope: GlossaryScopeInput = "auto",
):
    response.headers["Cache-Control"] = "no-store"
    return delete_glossary_entry(db, principal, term_key=term_key, scope=scope)


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
    if body.language is None:
        payload.pop("language", None)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    existing = db.scalar(select(Recording).where(Recording.idempotency_key == idempotency_key))
    if existing:
        if existing.request_digest != digest or not can_access_recording(db, principal, existing):
            raise HTTPException(409, "Idempotency key already has a different request")
        return recording_json(existing)
    if capacity_reached(db):
        raise HTTPException(503, "audio_capacity_limit")
    meta: dict = {}
    if principal.name and principal.name.strip():
        meta["owner_name"] = " ".join(principal.name.split())[:120]
    if body.language is not None:
        meta["asr_language"] = body.language
    recording = Recording(
        idempotency_key=idempotency_key,
        request_digest=digest,
        owner_sub=principal.sub,
        owner_email=principal.email.lower() if principal.email else None,
        protocol_meta=meta,
        **body.model_dump(exclude={"language"}),
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
                    if principal.name and principal.name.strip():
                        meta = dict(rec.protocol_meta or {})
                        meta.setdefault("owner_name", " ".join(principal.name.split())[:120])
                        rec.protocol_meta = meta
    db.commit()
    return {"events": result}


@app.get("/v1/calendar")
def calendar_status(db: Db, principal: AuthPrincipal):
    return query_calendar_overview(db, principal, datetime.now(UTC))


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
    conn_peek = db.get(CalendarConnection, connection_id)
    if conn_peek is None:
        raise HTTPException(404, "Calendar connection not found")
    user_email = (principal.email or "operator@local").lower()
    if not principal.is_admin and conn_peek.owner_email.lower() != user_email:
        raise HTTPException(404, "Calendar connection not found")
    snap = snapshot_connection(conn_peek)
    db.rollback()
    now = datetime.now(UTC)
    raw_events, updated_snap, sync_error = fetch_connection_events_unlocked(snap, now)
    conn = db.scalar(
        select(CalendarConnection)
        .where(CalendarConnection.id == connection_id)
        .with_for_update(key_share=True)
    )
    if conn is None:
        raise HTTPException(404, "Calendar connection not found")
    synced = apply_synced_events(db, conn, raw_events, updated_snap, sync_error, now)
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
        .order_by(CalendarSyncedEvent.id.asc())
        .with_for_update()
    ).all()
    for ev in linked_events:
        if ev.recording_id:
            rec = db.scalar(
                select(Recording)
                .where(Recording.id == ev.recording_id)
                .with_for_update(key_share=True)
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
    stored_keyframes, stored_keyframe_bytes = db.execute(
        select(
            func.count(RecordingKeyframe.id),
            func.coalesce(func.sum(RecordingKeyframe.byte_size), 0),
        ).where(RecordingKeyframe.deleted_at.is_(None))
    ).one()
    def _prom_label(val: object) -> str:
        return str(val).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')

    lines = [
        "# HELP wortlaut_recordings_total Total recordings by provider and state.",
        "# TYPE wortlaut_recordings_total gauge",
    ]
    for prov, part, proc, count in rec_rows:
        lines.append(
            f'wortlaut_recordings_total{{provider="{_prom_label(prov)}",'
            f'participation="{_prom_label(part)}",'
            f'processing="{_prom_label(proc)}"}} {count}'
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
        lines.append(f'wortlaut_asr_jobs_total{{status="{_prom_label(status)}"}} {count}')
    lines.extend(
        [
            "# HELP wortlaut_stored_audio_samples Active stored audio samples.",
            "# TYPE wortlaut_stored_audio_samples gauge",
            f"wortlaut_stored_audio_samples {stored_samples}",
            "# HELP wortlaut_stored_audio_bytes Active stored S3 audio bytes.",
            "# TYPE wortlaut_stored_audio_bytes gauge",
            f"wortlaut_stored_audio_bytes {stored_bytes}",
            "# HELP wortlaut_stored_keyframes Active stored screen-share keyframes.",
            "# TYPE wortlaut_stored_keyframes gauge",
            f"wortlaut_stored_keyframes {stored_keyframes}",
            "# HELP wortlaut_stored_keyframe_bytes Active stored S3 keyframe bytes.",
            "# TYPE wortlaut_stored_keyframe_bytes gauge",
            f"wortlaut_stored_keyframe_bytes {stored_keyframe_bytes}",
        ]
    )
    return Response(
        "\n".join(lines) + "\n",
        media_type="text/plain; version=0.0.4; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


def _recording_audio_duration_seconds(
    stream_rows: list[tuple[dict | None, int | None, int]],
) -> float:
    """Compute wall-clock audio span in seconds across isolated streams (never summing tracks)."""
    origins: list[datetime] = []
    ends: list[datetime] = []
    fallback_max_sec = 0.0
    for contract_raw, final_sample, last_chunk_end in stream_rows:
        end_sample = final_sample if final_sample is not None else int(last_chunk_end or 0)
        if end_sample <= 0:
            continue
        dur_sec = end_sample / RATE
        if dur_sec > fallback_max_sec:
            fallback_max_sec = dur_sec
        contract = contract_raw if isinstance(contract_raw, dict) else {}
        origin_raw = contract.get("session_utc_origin")
        if isinstance(origin_raw, str) and origin_raw:
            try:
                origin_dt = datetime.fromisoformat(origin_raw)
            except ValueError:
                continue
            mono_origin = contract.get("monotonic_origin_ms")
            sess_mono = contract.get("session_monotonic_origin_ms")
            offset_sec = (
                (float(mono_origin) - float(sess_mono)) / 1000.0
                if isinstance(mono_origin, (int, float))
                and isinstance(sess_mono, (int, float))
                else 0.0
            )
            origins.append(origin_dt)
            ends.append(origin_dt + timedelta(seconds=max(0.0, offset_sec) + dur_sec))
    if origins and ends:
        return round(max(0.0, (max(ends) - min(origins)).total_seconds()), 1)
    return round(fallback_max_sec, 1)


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
    query, empty_for_principal = apply_recordings_search_filters(
        select(Recording, Delivery).outerjoin(Delivery),
        principal=principal,
        provider=provider,
        participation=participation,
        processing=processing,
        q=q,
        include_attempt_diagnostics=True,
    )
    if empty_for_principal:
        return {"items": [], "next_cursor": None}
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
    stream_spans_by_rec: dict[uuid.UUID, list[tuple[dict | None, int | None, int]]] = {}
    if identifiers:
        for rec_id_row, contract_row, final_sample_row, last_end_row in db.execute(
            select(
                Attempt.recording_id,
                AudioStream.contract,
                AudioStream.final_sample,
                func.coalesce(func.max(AudioChunk.start_sample + AudioChunk.sample_count), 0),
            )
            .join(AudioStream, AudioStream.attempt_id == Attempt.id)
            .outerjoin(AudioChunk, AudioChunk.stream_id == AudioStream.id)
            .where(Attempt.recording_id.in_(identifiers))
            .group_by(Attempt.recording_id, AudioStream.id)
        ):
            stream_spans_by_rec.setdefault(rec_id_row, []).append(
                (contract_row, final_sample_row, int(last_end_row or 0))
            )
    duration_by_rec = {
        rid: _recording_audio_duration_seconds(rows_for_rec)
        for rid, rows_for_rec in stream_spans_by_rec.items()
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
                    "duration_seconds": duration_by_rec.get(recording.id, 0.0),
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
        principal = verify_mcp_access_token_principal(db, token, required_scope="mcp:read")
        if principal is None:
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
    duration_seconds = _recording_audio_duration_seconds(
        [
            (s.contract, s.final_sample, int(a_info.get("last_durable_sample") or 0))
            for s, a_info in zip(streams, result["audio"], strict=True)
        ]
    )
    result["ingest"] = {
        "durable_sample_count": samples,
        "durable_chunk_count": chunks,
        "duration_seconds": duration_seconds,
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
    is_paused = bool(part_sources.get("paused"))
    max_audio_level = 0.0
    active_speakers: list[str] = []
    for r in receivers:
        lvl = (r.get("rtp_stats") or {}).get("audio_level")
        if isinstance(lvl, (int, float)) and lvl > max_audio_level:
            max_audio_level = float(lvl)
        if (
            not is_paused
            and isinstance(lvl, (int, float))
            and lvl >= 0.01
            and r.get("participant_name")
        ):
            spk = str(r["participant_name"]).strip()
            if spk and spk not in active_speakers:
                active_speakers.append(spk)
    speech_active = (
        recording.participation == "capturing"
        and not is_paused
        and (max_audio_level >= 0.01 or bool(diag.get("speech_active")))
    )
    result["live_status"] = {
        "is_active": recording.participation
        in ("starting", "joining", "waiting_admission", "capturing")
        or recording.processing not in ("completed", "failed"),
        "participation": recording.participation,
        "processing": recording.processing,
        "paused": is_paused,
        "speech_active": speech_active,
        "max_audio_level": round(max_audio_level, 3),
        "active_speakers": active_speakers[:4],
        "active_streams": diag.get("streams", 0),
        "audio_seconds": duration_seconds,
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
    rec_peek = db.get(Recording, recording_id)
    if rec_peek is None or not can_access_recording(db, principal, rec_peek):
        raise HTTPException(404, "Recording not found")
    recording = cancel_recording_and_unlink_calendar(db, recording_id, datetime.now(UTC))
    if recording is None:
        raise HTTPException(404, "Recording not found")
    db.commit()
    return recording_json(recording)


@app.delete("/v1/recordings/{recording_id}")
def delete_recording(recording_id: uuid.UUID, db: Db, principal: AuthPrincipal):
    rec_peek = db.get(Recording, recording_id)
    if rec_peek is None or not can_access_recording(db, principal, rec_peek):
        raise HTTPException(404, "Recording not found")
    synced_for_rec = db.scalars(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.recording_id == recording_id)
        .order_by(CalendarSyncedEvent.id.asc())
        .with_for_update()
    ).all()
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None:
        raise HTTPException(404, "Recording not found")
    if recording.participation in ("starting", "joining", "waiting_admission", "capturing"):
        raise HTTPException(409, "Stop active recording before deleting")
    if get_settings().s3_access_key or recording.audio_deleted_at is None:
        try:
            get_storage().delete_recording(recording.id)
        except Exception:
            pass
        try:
            get_storage().delete_recording_keyframes(recording.id)
        except Exception:
            pass
    db.execute(delete(RecordingKeyframe).where(RecordingKeyframe.recording_id == recording.id))
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
    if isinstance(recording.protocol_meta, dict):
        meta = dict(recording.protocol_meta)
        changed_meta = False
        for key in ("summary", "summary_claim_until", "scheduled_ends_at", "rag_indexed_model"):
            if key in meta:
                meta.pop(key, None)
                changed_meta = True
        if changed_meta:
            recording.protocol_meta = meta
    purge_recording_rag_chunks(db, recording.id)
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


class ProtocolDecisionInput(BaseModel):
    text: str = Field(default="", max_length=1500)
    timestamp: str | None = Field(default=None, max_length=32)
    offset_seconds: float | None = Field(default=None, ge=0.0, le=86400.0 * 3)


class ProtocolTopicInput(BaseModel):
    title: str = Field(default="", max_length=300)
    details: str = Field(default="", max_length=2000)
    timestamp: str | None = Field(default=None, max_length=32)
    offset_seconds: float | None = Field(default=None, ge=0.0, le=86400.0 * 3)


class ProtocolActionItemInput(BaseModel):
    owner: str = Field(default="Team", max_length=200)
    task: str = Field(default="", max_length=1000)
    due: str | None = Field(default=None, max_length=200)
    timestamp: str | None = Field(default=None, max_length=32)
    offset_seconds: float | None = Field(default=None, ge=0.0, le=86400.0 * 3)


class ProtocolSummaryInput(BaseModel):
    summary: str = Field(default="", max_length=10000)
    decisions: list[ProtocolDecisionInput] = Field(default_factory=list, max_length=64)
    topics: list[ProtocolTopicInput] = Field(default_factory=list, max_length=64)
    action_items: list[ProtocolActionItemInput] = Field(default_factory=list, max_length=128)


class ProtocolUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    language: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=20000)
    summary: ProtocolSummaryInput | None = None
    speaker_overrides: dict[str, str] | None = None
    term_replacements: dict[str, str] | None = None
    segment_edits: dict[str, str] | None = None
    opted_out_speakers: list[str] | None = None


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
    meta = dict(recording.protocol_meta or {})
    try:
        meta = apply_protocol_metadata_fields(
            recording,
            meta,
            title=body.title,
            has_title=body.title is not None,
            language=body.language,
            has_language=body.language is not None,
            notes=body.notes,
            has_notes=body.notes is not None,
            speaker_overrides=body.speaker_overrides,
            term_replacements=body.term_replacements,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if body.summary is not None:
        current_export = export_data(db, recording)
        origin_utc = current_export.get("time_origin_utc")
        cur_segments = current_export.get("segments") or []
        cur_keyframes = current_export.get("keyframes") or []
        cleaned_summary_text = body.summary.summary.strip()

        cleaned_decisions: list[dict] = []
        for d in body.summary.decisions:
            d_txt = " ".join(d.text.split())
            if not d_txt:
                continue
            d_item: dict = {"text": d_txt}
            d_ts, d_off = resolve_citation_timestamp(
                d.timestamp,
                d.offset_seconds if not (d.timestamp or "").strip() else None,
                origin_utc=origin_utc,
                segments=cur_segments,
                keyframes=cur_keyframes,
            )
            if d_ts and d_off is not None:
                d_item["timestamp"] = d_ts
                d_item["offset_seconds"] = d_off
            cleaned_decisions.append(d_item)

        cleaned_topics: list[dict] = []
        for t in body.summary.topics:
            t_title = " ".join(t.title.split())
            t_details = " ".join(t.details.split())
            if not (t_title or t_details):
                continue
            t_item: dict = {"title": t_title, "details": t_details}
            t_ts, t_off = resolve_citation_timestamp(
                t.timestamp,
                t.offset_seconds if not (t.timestamp or "").strip() else None,
                origin_utc=origin_utc,
                segments=cur_segments,
                keyframes=cur_keyframes,
            )
            if t_ts and t_off is not None:
                t_item["timestamp"] = t_ts
                t_item["offset_seconds"] = t_off
            cleaned_topics.append(t_item)

        cleaned_actions: list[dict] = []
        for a in body.summary.action_items:
            task = " ".join(a.task.split())
            if not task:
                continue
            item: dict = {
                "owner": " ".join(a.owner.split()) or "Team",
                "task": task,
            }
            due = " ".join((a.due or "").split())
            if due:
                item["due"] = due
            a_ts, a_off = resolve_citation_timestamp(
                a.timestamp,
                a.offset_seconds if not (a.timestamp or "").strip() else None,
                origin_utc=origin_utc,
                segments=cur_segments,
                keyframes=cur_keyframes,
            )
            if a_ts and a_off is not None:
                item["timestamp"] = a_ts
                item["offset_seconds"] = a_off
            cleaned_actions.append(item)

        if cleaned_summary_text or cleaned_decisions or cleaned_topics or cleaned_actions:
            meta["summary"] = {
                "summary": cleaned_summary_text,
                "decisions": cleaned_decisions,
                "topics": cleaned_topics,
                "action_items": cleaned_actions,
                "generated_at": datetime.now(UTC).isoformat(),
            }
        else:
            meta.pop("summary", None)
    if body.segment_edits is not None:
        prior_turn_ends = {
            str(seg.get("segment_id") or seg.get("id") or ""): float(seg["end"])
            for seg in export_data(db, recording)["segments"]
        }
        cur_edits = dict(meta.get("segment_edits") or {})
        cur_bounds = dict(meta.get("segment_edit_bounds") or {})
        for k, v in body.segment_edits.items():
            key = str(k).strip()[:120]
            if not key:
                continue
            val = str(v).strip()[:10000]
            if val:
                cur_edits[key] = val
                if key in prior_turn_ends:
                    cur_bounds[key] = prior_turn_ends[key]
            else:
                cur_edits.pop(key, None)
                cur_bounds.pop(key, None)
        meta["segment_edits"] = cur_edits
        meta["segment_edit_bounds"] = cur_bounds
    if body.opted_out_speakers is not None:
        cleaned_opt_out: list[str] = []
        seen_opt_out: set[str] = set()
        for item in body.opted_out_speakers[:64]:
            val = str(item).strip()[:200]
            if val and val.lower() not in seen_opt_out:
                seen_opt_out.add(val.lower())
                cleaned_opt_out.append(val)
        meta["opted_out_speakers"] = cleaned_opt_out
        if cleaned_opt_out and body.summary is None:
            meta.pop("summary", None)
        invalidate_recording_rag_index(meta)
    elif any(
        field is not None
        for field in (
            body.title,
            body.notes,
            body.summary,
            body.speaker_overrides,
            body.term_replacements,
            body.segment_edits,
        )
    ):
        invalidate_recording_rag_index(meta)
    recording.protocol_meta = meta
    if body.opted_out_speakers is not None:
        purge_recording_rag_chunks(db, recording.id)
    if body.opted_out_speakers:
        purge_opted_out_transcript_segments(db, recording)
        purge_opted_out_keyframes(db, recording)
    db.commit()
    return export_data(db, recording)


@app.post("/v1/recordings/{recording_id}/summary")
def create_recording_summary(
    recording_id: uuid.UUID,
    db: Db,
    principal: AuthPrincipal,
):
    if not get_settings().llm_summary_configured():
        raise HTTPException(
            503, "KI-Zusammenfassung ist deaktiviert (WORTLAUT_ENABLE_LLM_SUMMARY=false)"
        )
    recording = db.get(Recording, recording_id)
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    try:
        summary = generate_protocol_summary(db, recording_id)
    except LookupError:
        raise HTTPException(404, "Recording not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    except Exception as exc:
        reason = (
            str(exc)
            if isinstance(exc, RuntimeError) and str(exc).startswith(("ollama_", "llm_"))
            else type(exc).__name__
        )
        raise HTTPException(502, f"KI-Zusammenfassung fehlgeschlagen ({reason})") from None
    try:
        fresh_rec = db.get(Recording, recording_id)
        if fresh_rec is not None:
            publish_protocol_link_to_calendar_events(db, fresh_rec)
            db.commit()
    except Exception:
        db.rollback()
    return {"summary": summary}


@app.post("/v1/recordings/{recording_id}/calendar-link")
def link_recording_in_calendar(
    recording_id: uuid.UUID,
    db: Db,
    principal: AuthPrincipal,
):
    recording = db.get(Recording, recording_id)
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at or recording.metadata_deleted_at:
        raise HTTPException(410, "Recording retention expired")
    if recording.processing != "completed":
        raise HTTPException(409, "Das Protokoll wird noch verarbeitet.")
    res = publish_protocol_link_to_calendar_events(db, recording, force_empty_audio=True)
    db.commit()
    if res["status"] == "no_matching_calendar_event":
        raise HTTPException(
            404,
            "Kein passender Google- oder Microsoft-365-Kalendereintrag "
            "für diese Besprechung gefunden.",
        )
    if res["status"] == "error":
        err = res.get("error") or "calendar_update_failed"
        if err == "insufficient_calendar_write_scope":
            raise HTTPException(
                403,
                "Kalender-Berechtigung ist noch auf Read-Only gesetzt. "
                "Bitte verbinden Sie Ihren Kalender im Tab „Kalender“ einmalig neu, "
                "um das Eintragen von Protokoll-Links zu aktivieren.",
            )
        if err == "calendar_event_not_editable_by_guest":
            raise HTTPException(
                403,
                "Dieser Kalendereintrag lässt das Bearbeiten der Beschreibung "
                "durch Gäste nicht zu.",
            )
        raise HTTPException(
            502, f"Kalendereintrag konnte nicht aktualisiert werden ({err})."
        )
    return res


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


@app.get("/v1/recordings/{recording_id}/keyframes/{keyframe_id}.png")
def get_recording_keyframe_png(
    recording_id: uuid.UUID,
    keyframe_id: uuid.UUID,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    recording, _ = _authenticate_recording_access(db, recording_id, authorization)
    if recording.transcript_deleted_at or recording.metadata_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    kf = db.get(RecordingKeyframe, keyframe_id)
    if (
        kf is None
        or kf.recording_id != recording.id
        or kf.deleted_at is not None
        or not kf.object_key
        or is_keyframe_opted_out(db, recording, kf)
    ):
        raise HTTPException(404, "Keyframe not found")
    try:
        png_bytes = get_storage().read(kf.object_key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code") or "")
        if code in ("NoSuchKey", "404"):
            raise HTTPException(404, "Keyframe not found") from None
        raise HTTPException(502, "Storage read failed") from None
    except ObjectConflict:
        raise HTTPException(502, "Invalid keyframe object integrity") from None
    if hashlib.sha256(png_bytes).hexdigest() != kf.sha256:
        raise HTTPException(502, "Invalid keyframe object integrity")
    return Response(
        png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@app.delete("/v1/recordings/{recording_id}/keyframes/{keyframe_id}")
def delete_recording_keyframe(
    recording_id: uuid.UUID,
    keyframe_id: uuid.UUID,
    db: Db,
    principal: AuthPrincipal,
):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None or not can_access_recording(db, principal, recording):
        raise HTTPException(404, "Recording not found")
    if recording.transcript_deleted_at or recording.metadata_deleted_at:
        raise HTTPException(410, "Transcript retention expired")
    kf = db.scalar(
        select(RecordingKeyframe)
        .where(
            RecordingKeyframe.id == keyframe_id,
            RecordingKeyframe.recording_id == recording.id,
        )
        .with_for_update()
    )
    if kf is None or kf.deleted_at is not None:
        raise HTTPException(404, "Keyframe not found")
    object_key = kf.object_key
    kf_id = kf.id
    kf.deleted_at = datetime.now(UTC)
    kf.participant_name = None
    kf_key = str(kf_id)
    meta = dict(recording.protocol_meta or {})
    if isinstance(meta.get("keyframe_context"), dict):
        ctx_copy = dict(meta["keyframe_context"])
        ctx_copy.pop(kf_key, None)
        meta["keyframe_context"] = ctx_copy
    if isinstance(meta.get("keyframe_context_claims"), dict):
        claims_copy = dict(meta["keyframe_context_claims"])
        claims_copy.pop(kf_key, None)
        if claims_copy:
            meta["keyframe_context_claims"] = claims_copy
        else:
            meta.pop("keyframe_context_claims", None)
    invalidate_recording_rag_index(meta)
    recording.protocol_meta = meta
    purge_recording_rag_chunks(db, recording.id, keyframe_id=kf_id)
    db.commit()
    if object_key and get_settings().s3_access_key and get_settings().s3_secret_key:
        try:
            get_storage().delete_object(object_key)
        except (BotoCoreError, ClientError) as exc:
            logging.getLogger(__name__).warning(
                "Deferred S3 keyframe delete after API tombstone for %s: %s",
                kf_id,
                exc,
            )
        else:
            locked_kf = db.scalar(
                select(RecordingKeyframe)
                .where(RecordingKeyframe.id == kf_id)
                .with_for_update()
            )
            if locked_kf is not None and locked_kf.object_key == object_key:
                locked_kf.object_key = ""
                db.commit()
    elif object_key:
        locked_kf = db.scalar(
            select(RecordingKeyframe).where(RecordingKeyframe.id == kf_id).with_for_update()
        )
        if locked_kf is not None:
            locked_kf.object_key = ""
            db.commit()
    return Response(status_code=204)


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


def _humanize_inviter_name(raw: str | None) -> str | None:
    if not raw:
        return None
    clean = " ".join(str(raw).strip().split())
    if not clean:
        return None
    if "@" not in clean and (" " in clean or any(c.isupper() for c in clean)):
        return clean
    local = clean.split("@", 1)[0].strip()
    tokens = [t for t in re.split(r"[._+]+", local) if t]
    if not tokens:
        return local or clean
    return " ".join(
        "-".join(seg.capitalize() for seg in tok.split("-") if seg) or tok.capitalize()
        for tok in tokens
    )


def _recording_inviter(db: Session, recording: Recording) -> str | None:
    if recording.owner_email:
        return recording.owner_email
    if recording.calendar_entry_id:
        entry = db.get(CalendarEntry, recording.calendar_entry_id)
        if entry and entry.organizer:
            return entry.organizer
    synced = db.scalar(
        select(CalendarSyncedEvent)
        .where(CalendarSyncedEvent.recording_id == recording.id)
        .limit(1)
    )
    if synced and (synced.owner_email or synced.organizer_email):
        return synced.owner_email or synced.organizer_email
    return None


def _recording_inviter_name(db: Session, recording: Recording) -> str | None:
    meta = recording.protocol_meta if isinstance(recording.protocol_meta, dict) else {}
    owner_name = meta.get("owner_name")
    if isinstance(owner_name, str) and owner_name.strip():
        human = _humanize_inviter_name(owner_name)
        if human:
            return human
    if recording.calendar_entry_id:
        entry = db.get(CalendarEntry, recording.calendar_entry_id)
        if entry:
            if entry.original:
                try:
                    from icalendar import Calendar

                    ev = Calendar.from_ical(entry.original).walk("VEVENT")[0]
                    org_prop = ev.get("ORGANIZER")
                    cn = org_prop.params.get("CN") if org_prop is not None else None
                    if cn:
                        human_cn = _humanize_inviter_name(str(cn))
                        if human_cn:
                            return human_cn
                except Exception:
                    pass
            if entry.organizer:
                return _humanize_inviter_name(entry.organizer)
    inviter = _recording_inviter(db, recording)
    return _humanize_inviter_name(inviter)


def recording_display_name(db: Session, recording: Recording, settings=None) -> str:
    settings = settings or get_settings()
    base = (recording.guest_name or settings.assistant_name or "wortlaut").strip() or "wortlaut"
    inviter_name = _recording_inviter_name(db, recording)
    if not inviter_name:
        return base
    if inviter_name.lower() in base.lower() or "(" in base:
        return base
    combined = f"{base} ({inviter_name})"
    if len(combined) <= 60:
        return combined
    max_inviter = max(1, 60 - len(base) - 3)
    return f"{base} ({inviter_name[:max_inviter].rstrip()})"


def build_chat_intro(
    display_name: str,
    inviter: str | None,
    recording: Recording,
    settings,
) -> str | None:
    if not settings.enable_chat_intro:
        return None
    from wortlaut.settings import get_public_base_url

    base_url = get_public_base_url(settings)
    cred = chat_reader_token(recording)
    token_param = (
        f"&token=wortlaut-read-{recording.id}.{cred.removeprefix('wortlaut-read-')}"
        if cred
        else ""
    )
    recording_url = f"{base_url}/ui#view=meetings&id={recording.id}{token_param}"
    privacy_url = settings.privacy_url or f"{base_url}/privacy"
    bot_label = display_name.strip() or "wortlaut"
    keyframes_on = bool(getattr(settings, "enable_keyframes", True))
    if getattr(settings, "default_locale", "de") == "en":
        who_en = (inviter.strip() if inviter and inviter.strip() else "a participant")[:48]
        if keyframes_on:
            return (
                f"{bot_label} ({who_en}) transcribes this call (+ slide snapshots, no cameras). "
                f'Chat: "no" / "opt out" | #pause / #resume. '
                f"Transcript: {recording_url} | Info: {privacy_url}?lang=en"
            )
        return (
            f"{bot_label} ({who_en}) transcribes this call. "
            f'Chat: "no" / "opt out" | #pause / #resume. '
            f"Transcript: {recording_url} | Info: {privacy_url}?lang=en"
        )
    who = (inviter.strip() if inviter and inviter.strip() else "einem Teilnehmenden")[:48]
    if keyframes_on:
        return (
            f"{bot_label} ({who}) protokolliert (+ Folien-Standbilder, keine Kameras). "
            f'Chat: "no" / "opt out" | #pause / #resume. '
            f"Protokoll: {recording_url} | Info: {privacy_url}"
        )
    return (
        f"{bot_label} ({who}) protokolliert dieses Meeting. "
        f'Chat: "no" / "opt out" | #pause / #resume. '
        f"Protokoll: {recording_url} | Info: {privacy_url}"
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
    display_name = recording_display_name(db, recording, settings)
    inviter = _recording_inviter(db, recording)
    inviter_name = _recording_inviter_name(db, recording)
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
        "invited_by_name": inviter_name,
        "meeting_title": recording.title,
        "default_locale": settings.default_locale,
        "asr_language": effective_recording_language(recording, settings),
        "enable_keyframes": settings.enable_keyframes,
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
    if settings.enable_webex_browser and not settings.webex_service_token:
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
                "keyframes": None,
                **{k: v for k, v in attempt.diagnostics.items() if k != "speech_active"},
            }
            == body.model_dump(mode="json", exclude={"participation"})
        ):
            return {"accepted": True}
        raise HTTPException(409, "Attempt has already ended")
    now = datetime.now(UTC)
    prev_diag = attempt.diagnostics if isinstance(attempt.diagnostics, dict) else {}
    prev_active_samples = int(prev_diag.get("active_audio_samples") or 0)
    prev_audio_samples = int(prev_diag.get("audio_samples") or 0)
    attempt.last_heartbeat_at = now
    # Status is evidence about the current worker, not a provider acceptance test.
    diag_dump = body.model_dump(mode="json", exclude={"participation"})
    if body.participation == "capturing":
        diag_dump["speech_active"] = bool(
            not body.participant_sources.paused
            and int(diag_dump.get("active_audio_samples") or 0) > prev_active_samples
        )
    attempt.diagnostics = diag_dump
    if body.participant_sources.opted_out:
        meta = dict(recording.protocol_meta or {})
        cur_opted = list(meta.get("opted_out_speakers") or [])
        seen_opted = {str(x).strip().lower() for x in cur_opted if str(x).strip()}
        changed_opted = False
        for item in body.participant_sources.opted_out:
            val = str(item).strip()[:200]
            if val and val.lower() not in seen_opted and len(cur_opted) < 64:
                seen_opted.add(val.lower())
                cur_opted.append(val)
                changed_opted = True
        if changed_opted:
            meta["opted_out_speakers"] = cur_opted
            meta.pop("summary", None)
            recording.protocol_meta = meta
        purge_opted_out_transcript_segments(db, recording, [attempt])
        purge_opted_out_keyframes(db, recording, [attempt])
        cur_meta = recording.protocol_meta if isinstance(recording.protocol_meta, dict) else {}
        had_rag_marker = "rag_indexed_model" in cur_meta
        if had_rag_marker:
            next_meta = dict(cur_meta)
            invalidate_recording_rag_index(next_meta)
            recording.protocol_meta = next_meta
        if changed_opted or had_rag_marker or recording.processing == "completed":
            purge_recording_rag_chunks(db, recording.id)
    recording.participation = body.participation
    settings = get_settings()
    if (
        body.participation == "capturing"
        and recording.cancelled_at is None
        and recording.audio_closed_at is None
        and settings.max_overtime_seconds > 0
        and settings.bootstrap_lifetime_seconds == 0
        and now >= recording.ends_at - timedelta(minutes=2)
    ):
        dom_count = body.participant_sources.dom_participants
        is_sdk_worker = body.configured_speaker_slots is not None
        has_live_participants = (
            dom_count >= 1
            if dom_count is not None
            else (is_sdk_worker and body.participant_sources.total >= 2)
        )
        speech_advancing = body.streams > 0 and (
            body.active_audio_samples > prev_active_samples
            or (is_sdk_worker and body.audio_samples > prev_audio_samples)
        )
        active_share = bool(body.keyframes and body.keyframes.active_share)
        room_active = speech_advancing or has_live_participants or active_share
        if room_active:
            meta = dict(recording.protocol_meta or {})
            raw_sched = meta.get("scheduled_ends_at")
            scheduled_ends_at = (
                datetime.fromisoformat(raw_sched).astimezone(UTC)
                if isinstance(raw_sched, str) and raw_sched
                else recording.ends_at
            )
            hard_cap = scheduled_ends_at + timedelta(seconds=settings.max_overtime_seconds)
            if recording.ends_at < hard_cap:
                next_ends_at = min(hard_cap, max(recording.ends_at, now) + timedelta(minutes=15))
                if next_ends_at > recording.ends_at:
                    if "scheduled_ends_at" not in meta:
                        meta["scheduled_ends_at"] = scheduled_ends_at.isoformat()
                        recording.protocol_meta = meta
                    recording.ends_at = next_ends_at
                    attempt.credential_expires_at = max(
                        attempt.credential_expires_at,
                        recording.ends_at + timedelta(minutes=2),
                    )
    if body.participation == "ended":
        attempt.ended_at = now
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
    stop_requested = (
        recording.cancelled_at is not None or recording.audio_closed_at is not None
    )
    stop_reason = "cancelled" if recording.cancelled_at else "audio_retention_expired"
    effective_deadline = min(
        recording.ends_at, attempt.credential_expires_at - timedelta(seconds=30)
    )
    current_asr_lang = effective_recording_language(recording, settings)
    transcript_deleted = recording.transcript_deleted_at is not None
    db.commit()
    record_worker_status_telemetry(recording, attempt, body)
    live_transcript: list[dict] = []
    if body.participation == "capturing" and not transcript_deleted:
        has_any_segment = db.scalar(
            select(TranscriptSegment.id)
            .join(AsrJob, AsrJob.id == TranscriptSegment.id)
            .join(AudioStream, AudioStream.id == AsrJob.stream_id)
            .join(Attempt, Attempt.id == AudioStream.attempt_id)
            .where(Attempt.recording_id == recording.id)
            .limit(1)
        )
        if has_any_segment is not None:
            is_en = settings.default_locale == "en"
            exported = export_data(db, recording, tail_segments_limit=48)
            last_spk_key: tuple[str, str] | None = None
            for seg in exported["segments"][-24:]:
                if seg.get("attribution_unknown") and seg.get("source_kind") != "share_audio":
                    continue
                text_val = " ".join(str(seg.get("text") or "").split())
                if not text_val:
                    continue
                if seg.get("source_kind") == "share_audio":
                    spk = "Screen Share" if is_en else "Freigabe-Audio"
                    spk_identity = "share_audio"
                else:
                    clean_name = " ".join(str(seg.get("participant_name") or "").split())
                    spk = (
                        clean_name
                        if clean_name
                        else ("Participant" if is_en else "Teilnehmer")
                    )[:80]
                    spk_identity = str(seg.get("participant_id") or seg["speaker_id"])
                cur_key = (spk_identity, spk)
                if (
                    live_transcript
                    and last_spk_key == cur_key
                    and len(live_transcript[-1]["text"]) + 1 + len(text_val) <= 420
                ):
                    live_transcript[-1]["text"] = f"{live_transcript[-1]['text']} {text_val}"
                else:
                    live_transcript.append(
                        {
                            "speaker": spk,
                            "text": text_val[:420],
                            "start": round(float(seg["start"]), 2),
                        }
                    )
                    last_spk_key = cur_key
            live_transcript = live_transcript[-8:]
    return {
        "accepted": True,
        "stop_requested": stop_requested,
        "stop_reason": stop_reason,
        "deadline": effective_deadline,
        "asr_language": current_asr_lang,
        "live_transcript": live_transcript,
    }


def _decode_keyframe_header(raw_header: str) -> KeyframeIngestMetadata:
    clean = raw_header.strip()
    if not clean or len(clean) > 4096:
        raise HTTPException(400, "Invalid X-Wortlaut-Keyframe header")
    padded = clean + "=" * (-len(clean) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Invalid X-Wortlaut-Keyframe encoding") from None
    if not isinstance(payload, dict):
        raise HTTPException(400, "Invalid X-Wortlaut-Keyframe object")
    try:
        return KeyframeIngestMetadata.model_validate(payload)
    except ValidationError as exc:
        msg = exc.errors()[0].get("msg", "validation error") if exc.errors() else "validation error"
        raise HTTPException(400, f"Invalid keyframe metadata: {msg}") from None


@app.post("/v1/attempts/{attempt_id}/keyframes")
async def upload_attempt_keyframe(
    attempt_id: uuid.UUID,
    request: Request,
    db: Db,
    x_worker_id: Annotated[str, Header()],
    x_wortlaut_keyframe: Annotated[str, Header()],
    authorization: Annotated[str | None, Header()] = None,
):
    meta = _decode_keyframe_header(x_wortlaut_keyframe)
    ctype = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if ctype != "image/png":
        raise HTTPException(400, "Content-Type must be image/png")
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_KEYFRAME_BYTES + 1:
            raise HTTPException(400, "Invalid keyframe byte size")
    png_bytes = bytes(buf)

    def _store():
        attempt = authenticated_attempt(attempt_id, db, authorization)
        recording = db.scalar(
            select(Recording).where(Recording.id == attempt.recording_id).with_for_update()
        )
        db.refresh(attempt)
        if (
            recording is None
            or recording.active_attempt_id != attempt.id
            or attempt.worker_id != x_worker_id
            or attempt.ended_at is not None
            or recording.participation == "ended"
            or recording.audio_closed_at is not None
            or recording.audio_deleted_at is not None
            or recording.transcript_deleted_at is not None
        ):
            raise HTTPException(409, "Worker does not own this occurrence")
        kf, duplicate = ingest_keyframe(db, attempt, recording, meta, png_bytes)
        return {"id": str(kf.id), "sequence": kf.sequence, "duplicate": duplicate}, (
            200 if duplicate else 201
        )

    body_out, status_code = await run_in_threadpool(_store)
    return JSONResponse(
        body_out,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


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
