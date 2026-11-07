"""Persisted source-local VAD progression. Storage chunks never define sentences."""

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import webrtcvad
from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import case, func, literal, select, union_all
from sqlalchemy.orm import Session

from wortlaut.ingest import SourceBinding
from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioControl, AudioStream, Recording
from wortlaut.settings import get_settings
from wortlaut.storage import canonical, get_storage

RATE = 16000
FRAME = 480  # WebRTC VAD: 30 ms, aggressiveness 2.
PRE_ROLL = 4800  # 300 ms
POST_ROLL = 2400  # 150 ms
SILENCE = 9600  # 600 ms
MAX_SEGMENT = RATE * 30
OVERLAP = 3200  # 200 ms, words assigned by midpoint in the disjoint core.
SILENCE_CHECKPOINT = RATE * 10
DRAIN_SECONDS = 20
MAX_CHUNK = RATE * 5
SCAN_WINDOW = SILENCE_CHECKPOINT + MAX_SEGMENT + OVERLAP


@dataclass
class Run:
    start: int
    end: int
    binding: dict | None
    chunks: list[AudioChunk] = field(default_factory=list)
    failure: str | None = None


class AudioReadError(ValueError):
    def __init__(self, chunk_id: str, reason: str, permanent: bool):
        super().__init__(reason)
        self.chunk_id, self.reason, self.permanent = chunk_id, reason, permanent


def stream_quality(db: Session, stream: AudioStream):
    """Read quality without materializing PCM contracts or VAD runs for the full history."""
    attempt = db.get(Attempt, stream.attempt_id)
    recording = db.get(Recording, attempt.recording_id)
    frozen = bool(
        recording.audio_closed_at
        or (
            attempt.ended_at
            and datetime.now(UTC) >= attempt.ended_at + timedelta(seconds=DRAIN_SECONDS)
        )
    )
    accepted, durable_end, unknown, deleted = db.execute(
        select(
            func.coalesce(func.sum(AudioChunk.sample_count), 0),
            func.coalesce(func.max(AudioChunk.start_sample + AudioChunk.sample_count), 0),
            func.bool_or(AudioChunk.contract["attribution_unknown"].as_boolean()),
            func.bool_or(AudioChunk.deleted_at.is_not(None)),
        ).where(AudioChunk.stream_id == stream.id)
    ).one()
    pcm_exists = (
        select(AudioChunk.id)
        .where(AudioChunk.stream_id == stream.id, AudioChunk.sequence == AudioControl.sequence)
        .exists()
    )
    gaps = (
        select(
            AudioControl.sequence.label("sequence"),
            AudioControl.start_sample.label("start"),
            (AudioControl.start_sample + AudioControl.contract["sample_count"].as_integer()).label(
                "end"
            ),
            literal(True).label("gap"),
        )
        .where(
            AudioControl.stream_id == stream.id,
            AudioControl.kind == "gap",
            True if frozen else AudioControl.contract["final"].as_boolean().is_(True),
            ~pcm_exists,
        )
        .distinct(AudioControl.sequence)
        .order_by(AudioControl.sequence)
        .subquery()
    )
    records = union_all(
        select(
            AudioChunk.sequence.label("sequence"),
            AudioChunk.start_sample.label("start"),
            (AudioChunk.start_sample + AudioChunk.sample_count).label("end"),
            literal(False).label("gap"),
        ).where(AudioChunk.stream_id == stream.id),
        select(gaps),
    ).subquery()
    ordered = select(
        records,
        func.coalesce(func.lag(records.c.end).over(order_by=records.c.sequence), 0).label(
            "previous_end"
        ),
        func.coalesce(func.lag(records.c.sequence).over(order_by=records.c.sequence), -1).label(
            "previous_sequence"
        ),
    ).cte("quality_ranges")
    # Live input may still be replayed. Only its contiguous prefix is settled;
    # EOS alone does not authorize inventing losses before the drain window ends.
    settled = select(ordered)
    if not frozen:
        prefix = select(
            ordered,
            func.min(
                case(
                    (
                        (ordered.c.sequence != ordered.c.previous_sequence + 1)
                        | (ordered.c.start != ordered.c.previous_end),
                        ordered.c.sequence,
                    )
                )
            )
            .over()
            .label("first_break"),
        ).subquery()
        settled = select(prefix).where(
            prefix.c.first_break.is_(None) | (prefix.c.sequence < prefix.c.first_break)
        )
    settled = settled.subquery()
    summarized = select(
        settled,
        func.max(settled.c.sequence).over().label("last_sequence"),
        func.max(settled.c.end).over().label("last_sample"),
    ).subquery()
    # Transfer losses and the final boundary only, rather than every accepted
    # PCM range. Window functions settle the prefix and its end in one query.
    events = (
        select(
            summarized.c.start,
            summarized.c.end,
            summarized.c.gap,
            summarized.c.previous_end,
            summarized.c.last_sequence,
            summarized.c.last_sample,
        )
        .where(
            summarized.c.gap
            | ((summarized.c.start > summarized.c.previous_end) & frozen)
            | (summarized.c.sequence == summarized.c.last_sequence),
        )
        .order_by(summarized.c.sequence)
    )
    known_gaps = []
    last_sequence, last_sample = -1, 0
    for start, end, gap, previous_end, sequence_end, sample_end in db.execute(events):
        last_sequence, last_sample = sequence_end, sample_end
        if frozen and start > previous_end:
            known_gaps.append({"start_sample": previous_end, "end_sample": start})
        if gap:
            known_gaps.append({"start_sample": start, "end_sample": end})
    if frozen and stream.final_sample is not None and last_sample < stream.final_sample:
        known_gaps.append({"start_sample": last_sample, "end_sample": stream.final_sample})
    failed = AudioChunk.processing_error.is_not(None) & (AudioChunk.processing_error != "")
    unprocessed = (
        select(
            case(
                (failed, AudioChunk.start_sample),
                else_=func.greatest(AudioChunk.start_sample, stream.scan_sample),
            ),
            AudioChunk.start_sample + AudioChunk.sample_count,
            case((failed, AudioChunk.processing_error), else_="audio_retention_expired"),
        )
        .where(
            AudioChunk.stream_id == stream.id,
            failed
            | (
                (AudioChunk.start_sample + AudioChunk.sample_count > stream.scan_sample)
                & (recording.processing_error == "audio_retention_expired")
            ),
        )
        .order_by(AudioChunk.sequence)
    )
    complete = (
        stream.final_sample is not None
        and last_sample == stream.final_sample
        and last_sequence == stream.last_sequence
    )
    return {
        "end_received": stream.final_sample is not None,
        "capture_end_unknown": stream.final_sample is None,
        "accepted_samples": accepted,
        "last_durable_sample": durable_end,
        "known_gaps": known_gaps,
        "pending_input": not (frozen or complete),
        "attribution_unknown": bool(unknown),
        "audio_deleted": bool(deleted),
        "unprocessed_ranges": [
            {"start_sample": start, "end_sample": end, "reason": reason}
            for start, end, reason in db.execute(unprocessed)
        ],
    }


def timeline(db: Session, stream: AudioStream, *, incremental: bool = False):
    attempt = db.get(Attempt, stream.attempt_id)
    recording = db.get(Recording, attempt.recording_id)
    frozen = bool(
        recording.audio_closed_at
        or (
            attempt.ended_at
            and datetime.now(UTC) >= attempt.ended_at + timedelta(seconds=DRAIN_SECONDS)
        )
    )
    chunks_query = select(AudioChunk).where(AudioChunk.stream_id == stream.id)
    gaps_query = select(AudioControl).where(
        AudioControl.stream_id == stream.id, AudioControl.kind == "gap"
    )
    next_sample = None
    if incremental:
        # Reconstruct the adaptive VAD from its durable reset, retaining overlap
        # before a long-speech cut. A storage block is at most five seconds.
        left = max(0, stream.scan_sample - OVERLAP)
        right = stream.scan_sample + SCAN_WINDOW
        chunks_query = chunks_query.where(
            AudioChunk.start_sample >= max(0, left - MAX_CHUNK),
            AudioChunk.start_sample <= right,
            AudioChunk.start_sample + AudioChunk.sample_count > left,
        )
        if not frozen:
            gaps_query = gaps_query.where(AudioControl.contract["final"].as_boolean().is_(True))
        future = [
            db.scalar(
                select(func.min(AudioChunk.start_sample)).where(
                    AudioChunk.stream_id == stream.id, AudioChunk.start_sample > right
                )
            ),
            db.scalar(
                select(func.min(AudioControl.start_sample)).where(
                    AudioControl.stream_id == stream.id,
                    AudioControl.kind == "gap",
                    AudioControl.start_sample > right,
                    True if frozen else AudioControl.contract["final"].as_boolean().is_(True),
                )
            ),
        ]
        next_sample = min((sample for sample in future if sample is not None), default=None)
        gaps_query = gaps_query.where(
            AudioControl.start_sample >= max(0, left - MAX_CHUNK),
            AudioControl.start_sample <= right,
            AudioControl.start_sample + AudioControl.contract["sample_count"].as_integer() > left,
        )
    chunks = db.scalars(chunks_query.order_by(AudioChunk.sequence)).all()
    gaps = db.scalars(gaps_query).all()
    records = {chunk.sequence: chunk for chunk in chunks}
    # A stored chunk wins over a possible buffer-overflow gap with a lost ACK.
    for gap in gaps:
        if frozen or gap.contract.get("final", False):
            records.setdefault(gap.contract["sequence"], gap)
    runs: list[Run] = []
    sample, sequence = 0, 0
    if incremental:
        sample = stream.scan_sample
        if records:
            first_sequence = min(records)
            sample = min(sample, records[first_sequence].start_sample)
            if stream.scan_sample:
                sequence = first_sequence
    for seq, record in sorted(records.items()):
        data = record.contract
        start, end = data["start_sample"], data["start_sample"] + data["sample_count"]
        if seq != sequence or start != sample:
            if not frozen:
                break  # Wait for retries; never infer active-stream losses.
            if start > sample:
                runs.append(Run(sample, start, None))
        if isinstance(record, AudioChunk) and record.processing_error:
            runs.append(Run(start, end, None, failure=record.processing_error))
        elif isinstance(record, AudioChunk):
            binding = {key: data.get(key) for key in SourceBinding.model_fields}
            if runs and runs[-1].end == start and runs[-1].binding == binding:
                runs[-1].end = end
                runs[-1].chunks.append(record)
            else:
                runs.append(Run(start, end, binding, [record]))
        else:
            runs.append(Run(start, end, None))
        sample, sequence = end, seq + 1
    received_end = stream.final_sample is not None
    complete = (
        received_end
        and sample == stream.final_sample
        and (sequence == stream.last_sequence + 1 or (incremental and not records))
    )
    if frozen and next_sample is not None and sample < next_sample:
        # This is a real frozen-stream loss, not the end of a query page. Jump
        # to the next durable range without filling or loading the missing audio.
        runs.append(Run(sample, next_sample, None))
    if frozen and next_sample is None and received_end and sample < stream.final_sample:
        runs.append(Run(sample, stream.final_sample, None))
        sample = stream.final_sample
    terminal = complete or (frozen and next_sample is None)
    quality = {
        "end_received": received_end,
        "capture_end_unknown": not received_end,
        "accepted_samples": sum(chunk.sample_count for chunk in chunks),
        "last_durable_sample": max((c.start_sample + c.sample_count for c in chunks), default=0),
        "known_gaps": [
            {"start_sample": r.start, "end_sample": r.end}
            for r in runs
            if r.binding is None and not r.failure
        ],
        "pending_input": not terminal,
        "attribution_unknown": any(c.contract["attribution_unknown"] for c in chunks),
        "audio_deleted": any(c.deleted_at is not None for c in chunks),
        "unprocessed_ranges": [
            {
                "start_sample": c.start_sample
                if c.processing_error
                else max(c.start_sample, stream.scan_sample),
                "end_sample": c.start_sample + c.sample_count,
                "reason": c.processing_error or "audio_retention_expired",
            }
            for c in chunks
            if c.processing_error
            or (
                recording.processing_error == "audio_retention_expired"
                and c.start_sample + c.sample_count > stream.scan_sample
            )
        ],
    }
    return runs, terminal, quality


def read_pcm(chunks: list[AudioChunk], start: int, end: int) -> bytes:
    pieces = []
    for chunk in chunks:
        left, right = (
            max(start, chunk.start_sample),
            min(end, chunk.start_sample + chunk.sample_count),
        )
        if left >= right:
            continue
        try:
            pcm = get_storage().read(chunk.object_key)
            if (
                len(pcm) != chunk.sample_count * 2
                or hashlib.sha256(pcm).hexdigest() != chunk.checksum
            ):
                raise ValueError("Stored PCM integrity failure")
        except ClientError as error:
            missing = error.response.get("Error", {}).get("Code") in ("NoSuchKey", "NoSuchObject")
            raise AudioReadError(
                chunk.id, "audio_object_missing" if missing else "storage_unavailable", missing
            ) from None
        except BotoCoreError:
            raise AudioReadError(chunk.id, "storage_unavailable", False) from None
        except ValueError:
            raise AudioReadError(chunk.id, "audio_integrity_failure", True) from None
        pieces.append(pcm[(left - chunk.start_sample) * 2 : (right - chunk.start_sample) * 2])
    result = b"".join(pieces)
    if len(result) != (end - start) * 2:
        raise ValueError("Missing PCM in an ASR range")
    return result


def speech_section(pcm: bytes, cursor: int, terminal: bool):
    """Replay from a durable reset boundary; adaptive VAD state is not guessed.

    Silent resets occur at fixed ten-second boundaries, speech resets after a
    closed section. Replaying the same prefix reconstructs an open section.
    """
    vad = webrtcvad.Vad(2)
    first = last = None
    samples = len(pcm) // 2
    available = cursor + samples
    for offset in range(0, samples, FRAME):
        frame = pcm[offset * 2 : (offset + FRAME) * 2]
        if len(frame) != FRAME * 2:
            if not terminal:
                break
            frame = frame.ljust(FRAME * 2, b"\0")  # VAD-only padding, never sent to ASR.
        frame_start, frame_end = cursor + offset, min(cursor + offset + FRAME, available)
        if vad.is_speech(frame, RATE):
            first = frame_start if first is None else first
            last = frame_end
        if first is None and frame_end - cursor >= SILENCE_CHECKPOINT:
            return None, cursor + SILENCE_CHECKPOINT
        if first is not None:
            audio_start = max(cursor, first - PRE_ROLL)
            cut = audio_start + MAX_SEGMENT
            if frame_end >= cut:
                if not terminal and available < cut + OVERLAP:
                    return None, cursor
                return (audio_start, min(available, cut + OVERLAP), cut), cut
            if frame_end - last >= SILENCE:
                end = min(available, last + POST_ROLL)
                return (audio_start, end, end), frame_end
    if terminal:
        if first is not None:
            return (max(cursor, first - PRE_ROLL), available, available), available
        return None, available
    return None, cursor


def segment_stream(db: Session, stream: AudioStream):
    runs, terminal, _ = timeline(db, stream, incremental=True)
    for index, run in enumerate(runs):
        if run.end <= stream.scan_sample:
            continue
        if run.binding is None:
            stream.scan_sample = run.end
            continue
        cursor = max(stream.scan_sample, run.start)
        # At most 10 s silence + 30 s voice + overlap; RAM remains bounded.
        limit = min(run.end, cursor + SCAN_WINDOW)
        final = limit == run.end and (index < len(runs) - 1 or terminal)
        pcm = read_pcm(run.chunks, cursor, limit)
        span, following = speech_section(pcm, cursor, final)
        if span:
            start, end, core_end = span
            # Pre-roll across a long-speech cut stays within the same source binding.
            if start == cursor:
                start = max(run.start, cursor - OVERLAP)
            identity = {
                "stream": str(stream.id),
                "start": start,
                "end": end,
                "core_start": cursor,
                "core_end": core_end,
                "binding": run.binding,
            }
            identifier = hashlib.sha256(canonical(identity).encode()).hexdigest()
            if db.get(AsrJob, identifier) is None:
                db.execute(select(func.pg_advisory_xact_lock(749836123)))
                count = db.scalar(
                    select(func.count())
                    .select_from(AsrJob)
                    .where(AsrJob.status.in_(["pending", "processing"]))
                )
                if count >= get_settings().max_open_asr_jobs:
                    return  # Keep the checkpoint and stored audio for later work.
                db.add(
                    AsrJob(
                        id=identifier,
                        stream_id=stream.id,
                        start_sample=start,
                        end_sample=end,
                        core_start=cursor,
                        core_end=core_end,
                        binding=run.binding,
                    )
                )
        stream.scan_sample = following
        if following < run.end:
            return
    if terminal:
        stream.scan_complete = True


def segmentation_pass(engine):
    with Session(engine) as db:
        identifiers = db.scalars(
            select(AudioStream.id)
            .where(
                AudioStream.scan_complete.is_(False),
                AudioStream.scan_retry_at.is_(None)
                | (AudioStream.scan_retry_at <= datetime.now(UTC)),
            )
            .order_by(AudioStream.last_scanned_at.asc().nullsfirst(), AudioStream.id)
            .limit(64)
        ).all()
    for identifier in identifiers:
        # One source per transaction: storage failure never rolls back other meetings.
        with Session(engine) as db:
            stream = db.scalar(
                select(AudioStream)
                .where(
                    AudioStream.id == identifier,
                    AudioStream.scan_complete.is_(False),
                    AudioStream.scan_retry_at.is_(None)
                    | (AudioStream.scan_retry_at <= datetime.now(UTC)),
                )
                .with_for_update(skip_locked=True)
            )
            if stream is None:
                continue
            try:
                with db.begin_nested():
                    segment_stream(db, stream)
                stream.scan_retry_at = None
            except AudioReadError as error:
                chunk = db.get(AudioChunk, error.chunk_id)
                if error.permanent:
                    chunk.read_failures += 1
                    if chunk.read_failures >= 3:
                        chunk.processing_error = error.reason
                stream.scan_retry_at = (
                    None if chunk.processing_error else datetime.now(UTC) + timedelta(seconds=30)
                )
                logging.getLogger("wortlaut").warning(
                    "segmentation_read_failed stream=%s chunk=%s reason=%s",
                    stream.id,
                    chunk.id,
                    error.reason,
                )
            stream.last_scanned_at = datetime.now(UTC)
            db.commit()
    return len(identifiers) == 64
