import hashlib
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import Integer, cast, func, select, union_all
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioControl, AudioStream, Recording
from wortlaut.settings import get_settings
from wortlaut.storage import ObjectConflict, canonical, get_storage

INGEST_BURST = 4096  # Twice the worker's maximum queued chunks plus controls.
INGEST_FRAMES_PER_SECOND = 64
AUDIO_WINDOW_SAMPLES = 16000 * 60
MAX_WINDOW_RECORDS = 1024


def admit_frame(attempt: Attempt):
    # verify_owner holds the recording row lock, including across reconnects.
    # Charge only new durable records; immutable retries and EOS remain free.
    now = datetime.now(UTC)
    previous = attempt.audio_ingest_refilled_at
    available = (
        INGEST_BURST
        if previous is None
        else min(
            INGEST_BURST,
            attempt.audio_ingest_tokens
            + max(0, (now - previous).total_seconds()) * INGEST_FRAMES_PER_SECOND,
        )
    )
    if available < 1:
        raise HTTPException(409, "audio_ingest_rate_limit")
    attempt.audio_ingest_tokens = available - 1
    attempt.audio_ingest_refilled_at = max(now, previous) if previous else now


def check_window_capacity(db: Session, stream: AudioStream, start_sample: int):
    # Count rows in the indexed sample window, not the complete stream history.
    # A 40.2-second VAD scan with overlap/chunk context spans at most two windows.
    left = start_sample // AUDIO_WINDOW_SAMPLES * AUDIO_WINDOW_SAMPLES
    right = left + AUDIO_WINDOW_SAMPLES
    records = union_all(
        select(AudioChunk.id).where(
            AudioChunk.stream_id == stream.id,
            AudioChunk.start_sample >= left,
            AudioChunk.start_sample < right,
        ),
        select(AudioControl.id).where(
            AudioControl.stream_id == stream.id,
            AudioControl.kind.in_(["bind", "gap"]),
            AudioControl.start_sample >= left,
            AudioControl.start_sample < right,
        ),
    ).limit(MAX_WINDOW_RECORDS)
    if db.scalar(select(func.count()).select_from(records.subquery())) >= MAX_WINDOW_RECORDS:
        raise HTTPException(409, "audio_metadata_capacity_limit")


class SourceBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    provider_source_id: str = Field(min_length=1, max_length=200)
    speaker_id: str | None = Field(default=None, max_length=200)
    source_kind: Literal["speaker", "share_audio"]
    attribution_unknown: bool
    participant_id: str | None = Field(default=None, max_length=200)
    participant_name: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def consistent(self):
        if self.source_kind == "speaker" and not self.attribution_unknown and not self.speaker_id:
            raise ValueError("Speaker binding requires an identity or attribution_unknown")
        if self.attribution_unknown and (
            self.speaker_id or self.participant_id or self.participant_name
        ):
            raise ValueError("Unknown attribution cannot assign a speaker or participant")
        return self


class StreamContract(SourceBinding):
    meeting_id: uuid.UUID
    attempt_id: uuid.UUID
    stream_id: uuid.UUID
    epoch: uuid.UUID
    sample_rate: Literal[16000]
    channels: Literal[1]
    encoding: Literal["pcm_s16le"]
    monotonic_origin_ms: float
    session_monotonic_origin_ms: float
    session_utc_origin: AwareDatetime


class ChunkContract(StreamContract):
    sequence: int = Field(ge=0, le=1_000_000)
    start_sample: int = Field(ge=0, le=16000 * 60 * 60 * 48)
    sample_count: int = Field(gt=0, le=16000 * 5)


class StreamBegin(StreamContract):
    type: Literal["begin"]
    id: str = Field(max_length=300)


class ControlBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=300)
    stream_id: uuid.UUID
    epoch: uuid.UUID


class StreamEnd(ControlBase):
    type: Literal["end"]
    final_sample: int = Field(ge=0, le=16000 * 60 * 60 * 48)
    last_sequence: int = Field(ge=-1, le=1_000_000)

    @model_validator(mode="after")
    def consistent(self):
        if (self.last_sequence == -1) != (self.final_sample == 0):
            raise ValueError("Empty stream must end with sequence -1 and sample zero")
        return self


class Gap(ControlBase):
    type: Literal["gap"]
    sequence: int = Field(ge=0, le=1_000_000)
    start_sample: int = Field(ge=0, le=16000 * 60 * 60 * 48)
    sample_count: int = Field(gt=0, le=16000 * 5)
    reason: str = Field(max_length=64)
    final: bool = False


class Bind(ControlBase, SourceBinding):
    type: Literal["bind"]
    start_sample: int = Field(ge=0, le=16000 * 60 * 60 * 48)


def stream_for(db: Session, attempt: Attempt, stream_id: uuid.UUID, epoch: uuid.UUID):
    return db.scalar(
        select(AudioStream)
        .where(
            AudioStream.attempt_id == attempt.id,
            AudioStream.stream_id == stream_id,
            AudioStream.epoch == epoch,
        )
        .with_for_update()
    )


def verify_owner(
    db: Session,
    attempt_id: uuid.UUID,
    credential: str,
    worker_id: str,
    connection_id: uuid.UUID | None = None,
):
    from wortlaut.app import authenticated_attempt

    attempt = authenticated_attempt(attempt_id, db, f"Bearer {credential}")
    recording = db.scalar(
        select(Recording).where(Recording.id == attempt.recording_id).with_for_update()
    )
    db.refresh(attempt)
    if (
        recording.active_attempt_id != attempt.id
        or attempt.worker_id != worker_id
        or attempt.ended_at is not None
        or recording.participation == "ended"
        or recording.audio_closed_at is not None
        or (connection_id is not None and attempt.audio_connection_id != connection_id)
    ):
        raise HTTPException(409, "Worker does not own this occurrence")
    return attempt, recording


def pending_samples(db: Session, attempt_id: uuid.UUID | None = None):
    # Segmented PCM is represented by its pending ASR jobs, not counted a second time.
    chunks = (
        select(
            func.coalesce(
                func.sum(
                    func.greatest(
                        0,
                        AudioChunk.start_sample
                        + AudioChunk.sample_count
                        - func.greatest(AudioChunk.start_sample, AudioStream.scan_sample),
                    )
                ),
                0,
            )
        )
        .join(AudioStream)
        .where(AudioStream.scan_complete.is_(False))
    )
    jobs = (
        select(func.coalesce(func.sum(AsrJob.end_sample - AsrJob.start_sample), 0))
        .join(AudioStream)
        .where(AsrJob.status.in_(["pending", "processing"]))
    )
    if attempt_id is not None:
        chunks = chunks.where(AudioStream.attempt_id == attempt_id)
        jobs = jobs.where(AudioStream.attempt_id == attempt_id)
    return db.scalar(chunks) + db.scalar(jobs)


def capacity_reached(db: Session, incoming_samples=0, incoming_bytes=0):
    settings = get_settings()
    stored = db.scalar(
        select(func.coalesce(func.sum(AudioChunk.object_size), 0)).where(
            AudioChunk.deleted_at.is_(None)
        )
    )
    open_jobs = db.scalar(
        select(func.count()).select_from(AsrJob).where(AsrJob.status.in_(["pending", "processing"]))
    )
    return (
        pending_samples(db) + incoming_samples > settings.max_pending_samples_total
        or (incoming_samples == 0 and pending_samples(db) >= settings.max_pending_samples_total)
        or stored + incoming_bytes > settings.max_stored_audio_bytes
        or (incoming_bytes == 0 and stored >= settings.max_stored_audio_bytes)
        or open_jobs >= settings.max_open_asr_jobs
    )


def check_range(db: Session, stream: AudioStream, sequence: int, start: int, count: int):
    if sequence == 0 and start != 0:
        raise HTTPException(409, "First chunk must start at sample zero")
    neighbours = []
    for model in (AudioChunk, AudioControl):
        samples = (
            model.sample_count
            if model is AudioChunk
            else cast(model.contract["sample_count"].astext, Integer)
        )
        query = select(model.sequence, model.start_sample, samples.label("sample_count")).where(
            model.stream_id == stream.id
        )
        if model is AudioControl:
            query = query.where(model.kind == "gap")
        # All accepted ranges are monotonic. Their nearest neighbours imply
        # the ordering of the rest of the history; read at most six rows.
        for condition, ordering in (
            (model.sequence < sequence, model.sequence.desc()),
            (model.sequence == sequence, model.sequence),
            (model.sequence > sequence, model.sequence),
        ):
            neighbours.append(select(query.where(condition).order_by(ordering).limit(1).subquery()))
    for other_sequence, other_start, samples in db.execute(union_all(*neighbours)):
        other_end, end = other_start + samples, start + count
        if other_sequence == sequence:
            if other_start != start or other_end != end:
                raise HTTPException(409, "Sequence has different sample boundaries")
        elif other_sequence < sequence:
            if other_end > start or (other_sequence + 1 == sequence and other_end != start):
                raise HTTPException(409, "Non-contiguous or reversed sample boundaries")
        elif end > other_start or (sequence + 1 == other_sequence and end != other_start):
            raise HTTPException(409, "Non-contiguous or reversed sample boundaries")


def accept_control(db: Session, attempt: Attempt, recording: Recording, data: dict) -> str:
    models = {"begin": StreamBegin, "end": StreamEnd, "gap": Gap, "bind": Bind}
    if data.get("type") not in models:
        raise HTTPException(400, "Unknown control type")
    body = models[data["type"]].model_validate(data)
    contract = body.model_dump(mode="json")
    if isinstance(body, Gap) and not body.final:
        contract.pop("final")  # Preserve immutable contracts from older workers.
    old = db.get(AudioControl, body.id)
    if old:
        if old.contract != contract:
            raise HTTPException(409, "Control ID has different metadata")
        owned = db.get(AudioStream, old.stream_id)
        if owned.attempt_id != attempt.id:
            raise HTTPException(409, "Control belongs to another attempt")
        return body.id
    if not isinstance(body, StreamEnd):
        admit_frame(attempt)
    stream = stream_for(db, attempt, body.stream_id, body.epoch)
    if isinstance(body, StreamBegin):
        if body.attempt_id != attempt.id or body.meeting_id != recording.id:
            raise HTTPException(409, "Stream belongs to another occurrence")
        if stream:
            raise HTTPException(409, "Stream already began with another control ID")
        count = db.scalar(
            select(func.count())
            .select_from(AudioStream)
            .where(AudioStream.attempt_id == attempt.id, AudioStream.final_sample.is_(None))
        )
        if count >= 64:
            raise HTTPException(409, "Active source limit reached")
        stream = AudioStream(
            attempt_id=attempt.id,
            stream_id=body.stream_id,
            epoch=body.epoch,
            contract=body.model_dump(mode="json", exclude={"type", "id"}),
        )
        db.add(stream)
        db.flush()
    elif not stream:
        raise HTTPException(409, "Stream begin has not been registered")
    if isinstance(body, (Bind, Gap)):
        check_window_capacity(db, stream, body.start_sample)
    if isinstance(body, StreamEnd):
        if stream.final_sample is not None:
            raise HTTPException(409, "Stream already ended with another control ID")
        for model in (AudioChunk, AudioControl):
            samples = (
                model.sample_count
                if model is AudioChunk
                else model.contract["sample_count"].as_integer()
            )
            excluded = select(model.id).where(
                model.stream_id == stream.id,
                (model.start_sample + samples > body.final_sample)
                | (model.sequence > body.last_sequence),
            )
            if model is AudioControl:
                excluded = excluded.where(model.kind == "gap")
            if db.scalar(excluded.limit(1)) is not None:
                raise HTTPException(409, "End excludes accepted audio or gap")
        stream.final_sample, stream.last_sequence = body.final_sample, body.last_sequence
    elif isinstance(body, Bind):
        duplicate = db.scalar(
            select(AudioControl).where(
                AudioControl.stream_id == stream.id,
                AudioControl.kind.in_(["begin", "bind"]),
                AudioControl.start_sample == body.start_sample,
            ).limit(1)
        )
        if duplicate or (
            stream.final_sample is not None and body.start_sample >= stream.final_sample
        ):
            raise HTTPException(409, "Binding boundary already exists or lies beyond stream end")
        overlaps = db.scalar(
            select(AudioChunk).where(
                AudioChunk.stream_id == stream.id,
                AudioChunk.start_sample >= max(0, body.start_sample - 16000 * 5),
                AudioChunk.start_sample < body.start_sample,
                AudioChunk.start_sample + AudioChunk.sample_count > body.start_sample,
            ).limit(1)
        )
        later = db.scalar(
            select(AudioChunk).where(
                AudioChunk.stream_id == stream.id, AudioChunk.start_sample >= body.start_sample
            ).limit(1)
        )
        if overlaps or later:
            raise HTTPException(409, "Binding would relabel already accepted audio")
    elif isinstance(body, Gap):
        if stream.final_sample is not None and (
            body.start_sample + body.sample_count > stream.final_sample
            or body.sequence > stream.last_sequence
        ):
            raise HTTPException(409, "Gap exceeds declared stream end")
        check_range(db, stream, body.sequence, body.start_sample, body.sample_count)
        # WebSocket order settles frames already sent on this connection. The
        # recording lock fences older connections; the stream lock also makes
        # the chunk/gap decision atomic with running segmentation. Durable PCM
        # wins even when its ACK was lost. A final gap forbids absent PCM later.
    db.add(
        AudioControl(
            id=body.id,
            stream_id=stream.id,
            kind=body.type,
            sequence=getattr(body, "sequence", None),
            contract=contract,
            start_sample=getattr(body, "start_sample", 0 if body.type == "begin" else None),
        )
    )
    db.commit()
    return body.id


def accept_chunk(
    db: Session, attempt: Attempt, recording: Recording, metadata: dict, pcm: bytes
) -> str:
    body = ChunkContract.model_validate(metadata)
    contract = body.model_dump(mode="json")
    if body.attempt_id != attempt.id or body.meeting_id != recording.id:
        raise HTTPException(409, "Chunk belongs to another occurrence")
    if len(pcm) != body.sample_count * 2:
        raise HTTPException(400, "PCM byte count is incorrect")
    identifier = f"{attempt.id}/{body.stream_id}/{body.epoch}/{body.sequence}"
    checksum = hashlib.sha256(pcm).hexdigest()
    old = db.get(AudioChunk, identifier)
    if old:
        if old.checksum != checksum or old.contract != contract:
            raise HTTPException(409, "Chunk ID has different PCM or metadata")
        return identifier
    admit_frame(attempt)
    stream = stream_for(db, attempt, body.stream_id, body.epoch)
    if not stream:
        raise HTTPException(409, "Stream begin has not been registered")
    check_window_capacity(db, stream, body.start_sample)
    final_gap = db.scalar(
        select(AudioControl.id).where(
            AudioControl.stream_id == stream.id,
            AudioControl.kind == "gap",
            AudioControl.sequence == body.sequence,
            AudioControl.contract["final"].as_boolean().is_(True),
        ).limit(1)
    )
    if final_gap:
        raise HTTPException(409, "Audio range was finalized as lost")
    for key in (
        "monotonic_origin_ms",
        "session_monotonic_origin_ms",
        "session_utc_origin",
        "sample_rate",
        "channels",
        "encoding",
    ):
        if stream.contract[key] != contract[key]:
            raise HTTPException(409, "Stream time or format changed within an epoch")
    binding = db.scalar(
        select(AudioControl)
        .where(
            AudioControl.stream_id == stream.id,
            AudioControl.kind.in_(["begin", "bind"]),
            AudioControl.start_sample <= body.start_sample,
        )
        .order_by(AudioControl.start_sample.desc())
        .limit(1)
    )
    for key in SourceBinding.model_fields:
        if binding is None or binding.contract.get(key) != contract.get(key):
            raise HTTPException(409, "Chunk does not match its registered binding")
    next_binding = db.scalar(
        select(AudioControl).where(
            AudioControl.stream_id == stream.id,
            AudioControl.kind == "bind",
            AudioControl.start_sample > body.start_sample,
            AudioControl.start_sample < body.start_sample + body.sample_count,
        ).limit(1)
    )
    if next_binding:
        raise HTTPException(409, "Chunk spans a binding boundary")
    if stream.final_sample is not None and (
        body.start_sample + body.sample_count > stream.final_sample
        or body.sequence > stream.last_sequence
    ):
        raise HTTPException(409, "Chunk exceeds declared stream end")
    check_range(db, stream, body.sequence, body.start_sample, body.sample_count)
    # Serialize capacity admission across different recording-row locks. This is
    # a transaction-scoped PostgreSQL lock, not another queue or lease service.
    db.execute(select(func.pg_advisory_xact_lock(749836123)))
    settings = get_settings()
    object_size = len(pcm) + 13 + len(canonical(contract).encode())
    if pending_samples(
        db, attempt.id
    ) + body.sample_count > settings.max_pending_samples_per_attempt or capacity_reached(
        db, body.sample_count, object_size
    ):
        raise HTTPException(409, "audio_capacity_limit")
    key = f"audio/{recording.id}/{identifier}.pcm"
    try:
        get_storage().put(key, pcm, contract)
    except ObjectConflict:
        raise HTTPException(409, "Stored object contains different audio or metadata") from None
    # A crash before this commit leaves an immutable orphan. An identical retry
    # verifies the object and completes registration; ACK follows this commit.
    db.add(
        AudioChunk(
            id=identifier,
            stream_id=stream.id,
            sequence=body.sequence,
            start_sample=body.start_sample,
            sample_count=body.sample_count,
            checksum=checksum,
            contract=contract,
            object_key=key,
            object_size=object_size,
        )
    )
    recording.processing = "processing"
    db.commit()
    return identifier
