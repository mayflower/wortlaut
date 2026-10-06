import asyncio
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
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, model_validator
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from wortlaut.asr import finalize_processing, inference_pass
from wortlaut.calendar import entry_json, imap_pass, import_mail
from wortlaut.controller import controller_pass, new_attempt, request_cancellation
from wortlaut.database import get_engine, session
from wortlaut.exports import export_data, render_export
from wortlaut.ingest import accept_chunk, accept_control, capacity_reached, verify_owner
from wortlaut.mail import delivery_json, smtp_pass
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioStream,
    CalendarEntry,
    Delivery,
    Recording,
)
from wortlaut.processing import segmentation_pass, timeline
from wortlaut.recurrence import recurrence_pass
from wortlaut.retention import retention_pass
from wortlaut.settings import get_settings
from wortlaut.storage import get_storage
from wortlaut.validation import validate_webex_url
from wortlaut.webex import WebexUnavailable, guest_token


async def processing_loop(stop: asyncio.Event, operation, interval=2):
    while not stop.is_set():
        try:
            await run_in_threadpool(operation, get_engine())
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
Db = Annotated[Session, Depends(session)]


def bearer_value(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Bearer credential required")
    return authorization[7:]


def api_auth(authorization: Annotated[str | None, Header()] = None):
    token = bearer_value(authorization)
    if not secrets.compare_digest(token, get_settings().api_token.get_secret_value()):
        raise HTTPException(401, "Invalid API credential")


class RecordingRequest(BaseModel):
    meeting_url: str = Field(max_length=2048)
    starts_at: datetime
    ends_at: datetime

    @model_validator(mode="after")
    def valid(self):
        validate_webex_url(self.meeting_url)
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None:
            raise ValueError("Explicit timezone required")
        if self.ends_at <= self.starts_at:
            raise ValueError("Meeting end must follow start")
        self.starts_at = self.starts_at.astimezone(UTC)
        self.ends_at = self.ends_at.astimezone(UTC)
        return self


class ClaimRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)


class RtpSourceEvidence(BaseModel):
    source: int = Field(ge=0, le=2**32 - 1)
    timestamp: float = Field(ge=0, allow_inf_nan=False)
    rtp_timestamp: int = Field(ge=0, le=2**32 - 1)


class ReceiverEvidence(BaseModel):
    provider_source_id: str = Field(max_length=256)
    source_kind: Literal["speaker", "share_audio"]
    capture_path: Literal["rtc_receiver", "sdk_stream"]
    track_id: str | None = Field(default=None, max_length=256)
    csi: int | None = Field(default=None, ge=0, le=2**32 - 1)
    signaled_participant_id: str | None = Field(default=None, max_length=256)
    source_state: str | None = Field(default=None, max_length=64)
    ssrc: list[RtpSourceEvidence] = Field(default_factory=list, max_length=64)
    csrc: list[RtpSourceEvidence] = Field(default_factory=list, max_length=64)


class ParticipantSourceEvidence(BaseModel):
    participant_id: str = Field(min_length=1, max_length=256)
    audio_csis: list[Annotated[int, Field(ge=0, le=2**32 - 1)]] = Field(max_length=64)
    share_audio_csis: list[Annotated[int, Field(ge=0, le=2**32 - 1)]] = Field(max_length=64)


class ParticipantEvidence(BaseModel):
    available: bool = False
    total: int = Field(default=0, ge=0)
    truncated: bool = False
    sources: list[ParticipantSourceEvidence] = Field(default_factory=list, max_length=256)


class WorkerStatus(BaseModel):
    participation: Literal["joining", "waiting_admission", "capturing", "ended"]
    capability: Literal["unverified", "capability_unsupported", "verified"] = "unverified"
    reason: str = Field(default="", max_length=64, pattern=r"^[a-z0-9_]*$")
    streams: int = Field(default=0, ge=0, le=64)
    configured_speaker_slots: int | None = Field(default=None, ge=0, le=64)
    configured_share_slots: int | None = Field(default=None, ge=0, le=64)
    audio_samples: int = Field(default=0, ge=0)
    receiver_sources: list[ReceiverEvidence] = Field(default_factory=list, max_length=64)
    participant_sources: ParticipantEvidence = Field(default_factory=ParticipantEvidence)


def recording_json(recording: Recording) -> dict:
    return {
        "id": str(recording.id),
        "starts_at": recording.starts_at,
        "ends_at": recording.ends_at,
        "participation": recording.participation,
        "processing": recording.processing,
        "processing_error": recording.processing_error,
        "participation_reason": recording.participation_reason,
        "cancelled_at": recording.cancelled_at,
        "audio_deleted_at": recording.audio_deleted_at,
        "transcript_deleted_at": recording.transcript_deleted_at,
        "active_attempt_id": str(recording.active_attempt_id)
        if recording.active_attempt_id
        else None,
        "calendar_entry_id": str(recording.calendar_entry_id)
        if recording.calendar_entry_id
        else None,
        "calendar_conflict": recording.calendar_conflict,
        "recurrence_key": recording.recurrence_key,
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


@app.post("/v1/recordings", dependencies=[Depends(api_auth)])
def create_recording(
    body: RecordingRequest,
    db: Db,
    idempotency_key: Annotated[str, Header(min_length=1, max_length=200)],
):
    digest = hashlib.sha256(
        json.dumps(body.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()
    existing = db.scalar(select(Recording).where(Recording.idempotency_key == idempotency_key))
    if existing:
        if existing.request_digest != digest:
            raise HTTPException(409, "Idempotency key already has a different request")
        return recording_json(existing)
    if capacity_reached(db):
        raise HTTPException(503, "audio_capacity_limit")
    recording = Recording(
        idempotency_key=idempotency_key, request_digest=digest, **body.model_dump()
    )
    db.add(recording)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Recording).where(Recording.idempotency_key == idempotency_key))
        if existing is None or existing.request_digest != digest:
            raise HTTPException(409, "Conflicting recording request") from None
        return recording_json(existing)
    return recording_json(recording)


@app.post("/v1/calendar/messages", dependencies=[Depends(api_auth)])
async def import_calendar_message(request: Request, db: Db):
    raw = bytearray()
    async for part in request.stream():
        raw.extend(part)
        if len(raw) > get_settings().max_mail_bytes:
            raise HTTPException(413, "Mail exceeds size limit")
    result = await run_in_threadpool(import_mail, db, bytes(raw))
    db.commit()
    return {"events": result}


@app.get("/v1/calendar", dependencies=[Depends(api_auth)])
def calendar_status(db: Db):
    entries = db.scalars(
        select(CalendarEntry).order_by(CalendarEntry.dtstamp.desc()).limit(128)
    ).all()
    result = []
    for entry in entries:
        recordings = db.scalars(
            select(Recording).where(Recording.calendar_entry_id == entry.id)
        ).all()
        item = entry_json(entry, recordings[0] if len(recordings) == 1 else None)
        item["recording_ids"] = [str(r.id) for r in recordings]
        result.append(item)
    return {"events": result}


@app.get("/v1/recordings/{recording_id}", dependencies=[Depends(api_auth)])
def get_recording(recording_id: uuid.UUID, db: Db):
    recording = db.get(Recording, recording_id)
    if not recording:
        raise HTTPException(404, "Recording not found")
    result = recording_json(recording)
    result["delivery"] = delivery_json(db.get(Delivery, recording.id))
    attempts = db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
    result["attempts"] = [
        {
            "id": str(a.id),
            "last_heartbeat_at": a.last_heartbeat_at,
            "ended_at": a.ended_at,
            "end_reason": a.end_reason,
            "diagnostics": a.diagnostics,
            "job_name": a.job_name,
            "job_uid": a.job_uid,
            "pod_uids": a.pod_uids,
            "process_ended_at": a.process_ended_at,
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
            **timeline(db, s)[2],
        }
        for s in streams
    ]
    jobs = db.scalars(select(AsrJob).where(AsrJob.stream_id.in_([s.id for s in streams]))).all()
    samples, chunks, last_audio = db.execute(
        select(
            func.coalesce(func.sum(AudioChunk.sample_count), 0),
            func.count(AudioChunk.id),
            func.max(AudioChunk.accepted_at),
        ).where(AudioChunk.stream_id.in_([s.id for s in streams]))
    ).one()
    result["ingest"] = {
        "durable_sample_count": samples,
        "durable_chunk_count": chunks,
        "last_audio_activity": last_audio,
    }
    result["asr"] = {
        "pending": sum(j.status in ("pending", "processing") for j in jobs),
        "failed": sum(j.status == "failed" for j in jobs),
        "completed": sum(j.status == "completed" for j in jobs),
    }
    return result


@app.post("/v1/recordings/{recording_id}/delivery/retry", dependencies=[Depends(api_auth)])
def retry_delivery(recording_id: uuid.UUID, db: Db):
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


@app.post("/v1/recordings/{recording_id}/cancel", dependencies=[Depends(api_auth)])
def cancel_recording(recording_id: uuid.UUID, db: Db):
    recording = db.scalar(select(Recording).where(Recording.id == recording_id).with_for_update())
    if recording is None:
        raise HTTPException(404, "Recording not found")
    request_cancellation(recording, datetime.now(UTC))
    db.commit()
    return recording_json(recording)


@app.get("/v1/recordings/{recording_id}/exports/{format}", dependencies=[Depends(api_auth)])
def get_export(recording_id: uuid.UUID, format: Literal["txt", "vtt", "json"], db: Db):
    recording = db.get(Recording, recording_id)
    if recording is None:
        raise HTTPException(404, "Recording not found")
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
        raise HTTPException(409, "Claim this occurrence before guest issuance")
    settings = get_settings()
    issued_request_started = datetime.now(UTC)
    try:
        guest = guest_token(
            settings.webex_service_token.get_secret_value()
            if settings.webex_service_token
            else None,
            f"wortlaut:{recording.id}",
            settings.assistant_name,
        )
        guest_deadline = issued_request_started + timedelta(seconds=guest["expires_in"] - 30)
        if guest_deadline <= datetime.now(UTC):
            raise WebexUnavailable("Webex guest lifetime is too short for safe participation")
    except (WebexUnavailable, httpx.HTTPError) as error:
        detail = str(error) if isinstance(error, WebexUnavailable) else "Webex request unavailable"
        raise HTTPException(503, detail) from None
    response.headers["Cache-Control"] = "no-store"
    return {
        "meeting_id": str(recording.id),
        "attempt_id": str(attempt.id),
        "meeting_url": recording.meeting_url,
        "sdk_page_url": settings.sdk_page_url,
        "deadline": min(
            recording.ends_at,
            attempt.credential_expires_at - timedelta(seconds=30),
        ),
        "guest_expires_at": issued_request_started + timedelta(seconds=guest["expires_in"]),
        "lobby_timeout_seconds": settings.lobby_timeout_seconds,
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
            and attempt.diagnostics == body.model_dump(exclude={"participation"})
        ):
            return {"accepted": True}
        raise HTTPException(409, "Attempt has already ended")
    attempt.last_heartbeat_at = datetime.now(UTC)
    # Status is evidence about the current worker, not a provider acceptance test.
    attempt.diagnostics = body.model_dump(exclude={"participation"})
    recording.participation = body.participation
    if body.participation == "ended":
        attempt.ended_at = datetime.now(UTC)
        attempt.end_reason = body.reason or "normal"
    db.commit()
    return {
        "accepted": True,
        "stop_requested": recording.cancelled_at is not None
        or recording.audio_closed_at is not None,
        "stop_reason": "cancelled" if recording.cancelled_at else "audio_retention_expired",
    }


def ingest_message(attempt_id, credential, worker_id, frame):
    with Session(get_engine()) as db:
        attempt, recording = verify_owner(db, attempt_id, credential, worker_id)
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

        def check_owner():
            with Session(get_engine()) as db:
                verify_owner(db, attempt_id, credential, worker_id)

        await run_in_threadpool(check_owner)
        await socket.send_json({"type": "ready"})
        while True:
            message = await socket.receive()
            if message["type"] == "websocket.disconnect":
                return
            frame = message.get("bytes") if message.get("bytes") is not None else message["text"]
            identifier = await run_in_threadpool(
                ingest_message, attempt_id, credential, worker_id, frame
            )
            await socket.send_json({"type": "ack", "id": identifier})
    except WebSocketDisconnect:
        return
    except (TimeoutError, HTTPException, ValidationError, ValueError, KeyError, TypeError) as error:
        reason = (
            "audio_capacity_limit"
            if isinstance(error, HTTPException) and error.detail == "audio_capacity_limit"
            else "ingest_rejected"
        )
        await socket.send_json({"type": "error", "reason": reason})
        await socket.close(1008)
    except Exception:
        # Temporary DB/storage failures do not ACK. Worker retains immutable frames
        # and reconnects, including after an object write without a DB commit.
        await socket.close(1011)
