"""Persisted source-local VAD progression. Storage chunks never define sentences."""

import hashlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import webrtcvad
from sqlalchemy import func, select
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


@dataclass
class Run:
    start: int
    end: int
    binding: dict | None
    chunks: list[AudioChunk] = field(default_factory=list)


def timeline(db: Session, stream: AudioStream):
    attempt = db.get(Attempt, stream.attempt_id)
    recording = db.get(Recording, attempt.recording_id)
    frozen = bool(
        recording.audio_closed_at
        or (
            attempt.ended_at
            and datetime.now(UTC) >= attempt.ended_at + timedelta(seconds=DRAIN_SECONDS)
        )
    )
    chunks = db.scalars(
        select(AudioChunk).where(AudioChunk.stream_id == stream.id).order_by(AudioChunk.sequence)
    ).all()
    gaps = db.scalars(
        select(AudioControl).where(AudioControl.stream_id == stream.id, AudioControl.kind == "gap")
    ).all()
    records = {chunk.sequence: chunk for chunk in chunks}
    # A stored chunk wins over a possible buffer-overflow gap with a lost ACK.
    if frozen:
        for gap in gaps:
            records.setdefault(gap.contract["sequence"], gap)
    runs: list[Run] = []
    sample, sequence = 0, 0
    for seq, record in sorted(records.items()):
        data = record.contract
        start, end = data["start_sample"], data["start_sample"] + data["sample_count"]
        if seq != sequence or start != sample:
            if not frozen:
                break  # Wait for retries; never infer active-stream losses.
            if start > sample:
                runs.append(Run(sample, start, None))
        if isinstance(record, AudioChunk):
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
        received_end and sample == stream.final_sample and sequence == stream.last_sequence + 1
    )
    if frozen and received_end and sample < stream.final_sample:
        runs.append(Run(sample, stream.final_sample, None))
        sample = stream.final_sample
    terminal = complete or frozen
    quality = {
        "end_received": received_end,
        "capture_end_unknown": not received_end,
        "accepted_samples": sum(chunk.sample_count for chunk in chunks),
        "last_durable_sample": max((c.start_sample + c.sample_count for c in chunks), default=0),
        "known_gaps": [
            {"start_sample": r.start, "end_sample": r.end} for r in runs if r.binding is None
        ],
        "pending_input": not terminal,
        "attribution_unknown": any(c.contract["attribution_unknown"] for c in chunks),
        "audio_deleted": any(c.deleted_at is not None for c in chunks),
        "unprocessed_ranges": [
            {
                "start_sample": max(c.start_sample, stream.scan_sample),
                "end_sample": c.start_sample + c.sample_count,
            }
            for c in chunks
            if recording.processing_error == "audio_retention_expired"
            and c.start_sample + c.sample_count > stream.scan_sample
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
        pcm = get_storage().read(chunk.object_key)
        if len(pcm) != chunk.sample_count * 2 or hashlib.sha256(pcm).hexdigest() != chunk.checksum:
            raise ValueError("Stored PCM integrity failure")
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
    runs, terminal, _ = timeline(db, stream)
    for index, run in enumerate(runs):
        if run.end <= stream.scan_sample:
            continue
        if run.binding is None:
            stream.scan_sample = run.end
            continue
        cursor = max(stream.scan_sample, run.start)
        # At most 10 s silence + 30 s voice + overlap; RAM remains bounded.
        limit = min(run.end, cursor + SILENCE_CHECKPOINT + MAX_SEGMENT + OVERLAP)
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
        streams = db.scalars(
            select(AudioStream)
            .where(AudioStream.scan_complete.is_(False))
            .order_by(AudioStream.last_scanned_at.asc().nullsfirst(), AudioStream.id)
            .with_for_update(skip_locked=True)
            .limit(16)
        ).all()
        for stream in streams:
            segment_stream(db, stream)
            stream.last_scanned_at = datetime.now(UTC)
        db.commit()
