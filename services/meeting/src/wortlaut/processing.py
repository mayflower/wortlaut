"""Persisted source-local VAD progression. Storage chunks never define sentences."""

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import onnxruntime as ort
from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import case, func, literal, select, union_all
from sqlalchemy.orm import Session

from wortlaut.ingest import SourceBinding
from wortlaut.models import (
    AsrJob,
    Attempt,
    AudioChunk,
    AudioControl,
    AudioStream,
    Recording,
    TranscriptSegment,
)
from wortlaut.settings import get_settings
from wortlaut.storage import canonical, get_storage

RATE = 16000
FRAME = 512  # Silero VAD v6.2 native 32 ms window at 16 kHz.
SILERO_CONTEXT = 64  # 4 ms recurrent audio context prepended to each 512-sample frame.
SILERO_VAD_MODEL_PATH = Path(__file__).resolve().parent / "assets" / "silero_vad.onnx"
MIN_SPEECH_PEAK = 150  # Ignore digital comfort noise (-46.7 dBFS floor on int16 PCM).
VAD_ONSET_THRESHOLD = 0.50  # Neural speech probability onset threshold.
VAD_OFFSET_THRESHOLD = 0.35  # Hysteresis offset threshold maintaining active speech.
PRE_ROLL = 4800  # 300 ms
POST_ROLL = 5760  # 360 ms
SILENCE = 11520  # 720 ms
SOFT_MAX_SEGMENT = RATE * 14
SOFT_SILENCE = 5760  # 360 ms breath pause closes >=14 s monologues before hard 30 s cut.
MAX_SEGMENT = RATE * 30
OVERLAP = 3200  # 200 ms, words assigned by midpoint in the disjoint core.
SILENCE_CHECKPOINT = RATE * 10
DRAIN_SECONDS = 20
MAX_CHUNK = RATE * 5
SCAN_WINDOW = SILENCE_CHECKPOINT + MAX_SEGMENT + OVERLAP
MAX_SCAN_STEPS = 8
if not (POST_ROLL <= SOFT_SILENCE <= SILENCE):
    raise RuntimeError("VAD silence thresholds must not be shorter than POST_ROLL")


@lru_cache(maxsize=1)
def _silero_session() -> ort.InferenceSession:
    ort.set_default_logger_severity(3)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    return ort.InferenceSession(
        str(SILERO_VAD_MODEL_PATH),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )


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
            prev_binding = runs[-1].binding if runs else None
            same_verified_speaker = (
                prev_binding is not None
                and not prev_binding.get("attribution_unknown")
                and not binding.get("attribution_unknown")
                and bool(prev_binding.get("participant_id") or prev_binding.get("speaker_id"))
                and all(
                    prev_binding.get(k) == binding.get(k)
                    for k in ("provider_source_id", "source_kind", "speaker_id", "participant_id")
                )
                and (
                    prev_binding.get("participant_name") is None
                    or binding.get("participant_name") is None
                    or prev_binding.get("participant_name") == binding.get("participant_name")
                )
            )
            if (
                runs
                and runs[-1].end == start
                and (prev_binding == binding or same_verified_speaker)
            ):
                if (
                    prev_binding is not None
                    and not prev_binding.get("participant_name")
                    and binding.get("participant_name")
                ):
                    runs[-1].binding = dict(binding)
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


def _is_short_noise_blip(
    first: int,
    last: int,
    cursor: int,
    voiced_frames: int,
    max_prob: float,
) -> bool:
    if voiced_frames <= 0:
        return True
    # Never drop the trailing tail of speech continuing across a durable cut/cursor
    # (allowing up to 4 frames / 128 ms for a voiceless stop closure right on the cut).
    if cursor > 0 and first - cursor <= 4 * FRAME:
        return False
    if last - first > RATE or voiced_frames >= 6:
        return False
    if voiced_frames <= 3:
        return True
    return max_prob < 0.65


def speech_section(pcm: bytes, cursor: int, terminal: bool):
    """Replay from a durable reset boundary; neural Silero VAD LSTM state is deterministic.

    Silent resets occur at fixed ten-second boundaries, speech resets after a
    closed section. Replaying the same prefix reconstructs an open section.
    """
    samples = len(pcm) // 2
    available = cursor + samples
    if samples == 0:
        return None, (available if terminal else cursor)

    pcm_i16 = np.frombuffer(pcm[: samples * 2], dtype="<i2")
    sess = _silero_session()
    state = np.zeros((2, 1, 128), dtype=np.float32)
    ctx = np.zeros(SILERO_CONTEXT, dtype=np.float32)
    inp = np.empty((1, SILERO_CONTEXT + FRAME), dtype=np.float32)
    sr_tensor = np.array(RATE, dtype=np.int64)

    first = last = None
    speaking = False
    silent_zero_run = True
    voiced_frames = 0
    max_prob = 0.0

    for offset in range(0, samples, FRAME):
        raw_frame = pcm_i16[offset : offset + FRAME]
        if len(raw_frame) != FRAME:
            if not terminal:
                break
            padded = np.zeros(FRAME, dtype=np.int16)  # VAD-only padding, never sent to ASR.
            padded[: len(raw_frame)] = raw_frame
            raw_frame = padded
        frame_start, frame_end = cursor + offset, min(cursor + offset + FRAME, available)
        frame_peak = max(-int(raw_frame.min()), int(raw_frame.max()))

        if not speaking and frame_peak == 0 and silent_zero_run:
            prob = 0.0
        else:
            silent_zero_run = False
            chunk_f32 = raw_frame.astype(np.float32) * (1.0 / 32768.0)
            inp[0, :SILERO_CONTEXT] = ctx
            inp[0, SILERO_CONTEXT:] = chunk_f32
            out, state = sess.run(None, {"input": inp, "state": state, "sr": sr_tensor})
            ctx[:] = chunk_f32[-SILERO_CONTEXT:]
            prob = float(out[0, 0])

        threshold = VAD_OFFSET_THRESHOLD if speaking else VAD_ONSET_THRESHOLD
        is_speech = frame_peak >= MIN_SPEECH_PEAK and prob >= threshold
        speaking = is_speech

        if is_speech:
            first = frame_start if first is None else first
            last = frame_end
            voiced_frames += 1
            if prob > max_prob:
                max_prob = prob
        if first is None and frame_end - cursor >= SILENCE_CHECKPOINT:
            return None, cursor + SILENCE_CHECKPOINT
        if first is not None:
            audio_start = max(cursor, first - PRE_ROLL)
            cut = audio_start + MAX_SEGMENT
            if frame_end >= cut:
                if not terminal and available < cut + OVERLAP:
                    return None, cursor
                return (audio_start, min(available, cut + OVERLAP), cut), cut
            required_silence = (
                SOFT_SILENCE if frame_end - audio_start >= SOFT_MAX_SEGMENT else SILENCE
            )
            if frame_end - last >= required_silence:
                if _is_short_noise_blip(first, last, cursor, voiced_frames, max_prob):
                    return None, frame_end
                end = min(available, last + POST_ROLL)
                return (audio_start, end, end), frame_end
    if terminal:
        if first is not None and not _is_short_noise_blip(
            first, last, cursor, voiced_frames, max_prob
        ):
            return (max(cursor, first - PRE_ROLL), available, available), available
        return None, available
    return None, cursor


def collect_opted_out_speakers(
    recording: Recording | None,
    attempts: list[Attempt],
    participant_names: dict[str, str] | None = None,
) -> tuple[list[str], set[str]]:
    raw_list: list[str] = []
    norm_set: set[str] = set()

    def _add(val: object):
        if not isinstance(val, str):
            return
        cleaned = val.strip()[:200]
        if not cleaned:
            return
        low = cleaned.lower()
        if low not in norm_set:
            raw_list.append(cleaned)
        norm_set.add(low)

    if recording is not None and isinstance(recording.protocol_meta, dict):
        for item in recording.protocol_meta.get("opted_out_speakers") or []:
            _add(item)
    name_map: dict[str, str] = dict(participant_names or {})
    for attempt in attempts:
        diag = attempt.diagnostics if isinstance(attempt.diagnostics, dict) else {}
        ps = diag.get("participant_sources")
        if isinstance(ps, dict):
            for item in ps.get("opted_out") or []:
                _add(item)
            for src in ps.get("sources") or []:
                if (
                    isinstance(src, dict)
                    and src.get("participant_id")
                    and src.get("participant_name")
                ):
                    name_map[str(src["participant_id"])] = str(src["participant_name"])
        for rcv in diag.get("receiver_sources") or []:
            if (
                isinstance(rcv, dict)
                and rcv.get("signaled_participant_id")
                and rcv.get("participant_name")
            ):
                name_map[str(rcv["signaled_participant_id"])] = str(rcv["participant_name"])

    if norm_set and name_map:
        for pid, pname in list(name_map.items()):
            pid_l = pid.strip().lower()
            pname_l = pname.strip().lower()
            if pid_l in norm_set or pname_l in norm_set:
                if pid_l:
                    norm_set.add(pid_l)
                if pname_l:
                    norm_set.add(pname_l)
    return raw_list, norm_set


def is_speaker_opted_out(
    opted_out_norm: set[str],
    *,
    participant_id: str | None = None,
    speaker_id: str | None = None,
    participant_name: str | None = None,
    speaker_label: str | None = None,
    provider_source_id: str | None = None,
) -> bool:
    if not opted_out_norm:
        return False
    for candidate in (
        participant_id,
        speaker_id,
        participant_name,
        speaker_label,
        provider_source_id,
    ):
        if isinstance(candidate, str):
            low = candidate.strip().lower()
            if low and low in opted_out_norm:
                return True
    return False


def purge_opted_out_transcript_segments(
    db: Session,
    recording: Recording,
    attempts: list[Attempt] | None = None,
) -> int:
    if attempts is None:
        attempts = list(
            db.scalars(select(Attempt).where(Attempt.recording_id == recording.id)).all()
        )
    if not attempts:
        return 0
    streams = list(
        db.scalars(
            select(AudioStream).where(AudioStream.attempt_id.in_([a.id for a in attempts]))
        ).all()
    )
    participant_names: dict[str, str] = {}
    for s in streams:
        pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
        if pid and s.contract.get("participant_name"):
            participant_names[str(pid)] = str(s.contract["participant_name"])
    bind_controls = (
        list(
            db.scalars(
                select(AudioControl).where(
                    AudioControl.stream_id.in_([s.id for s in streams]),
                    AudioControl.kind == "bind",
                )
            ).all()
        )
        if streams
        else []
    )
    for ctrl in bind_controls:
        pid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
        if pid and ctrl.contract.get("participant_name"):
            participant_names[str(pid)] = str(ctrl.contract["participant_name"])
    _, opted_out_norm = collect_opted_out_speakers(recording, attempts, participant_names)
    if not opted_out_norm or not streams:
        return 0

    stream_ids = [s.id for s in streams]
    unambiguous_by_stream: dict[tuple[str, str], tuple[str, str | None]] = {}
    for s in streams:
        key = (str(s.stream_id), str(s.epoch))
        observed: set[tuple[str, str | None]] = set()
        if not s.contract.get("attribution_unknown"):
            pid = s.contract.get("participant_id") or s.contract.get("speaker_id")
            if pid:
                pname_s = s.contract.get("participant_name") or participant_names.get(str(pid))
                observed.add((str(pid), pname_s))
        for ctrl in bind_controls:
            if ctrl.stream_id == s.id and not ctrl.contract.get("attribution_unknown"):
                pid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
                if pid:
                    pname_c = ctrl.contract.get("participant_name") or participant_names.get(
                        str(pid)
                    )
                    observed.add((str(pid), pname_c))
        if len(observed) == 1:
            unambiguous_by_stream[key] = next(iter(observed))

    deleted = 0
    seg_rows = list(
        db.scalars(
            select(TranscriptSegment)
            .join(AsrJob, AsrJob.id == TranscriptSegment.id)
            .where(AsrJob.stream_id.in_(stream_ids))
        ).all()
    )
    for seg_row in seg_rows:
        res = seg_row.result if isinstance(seg_row.result, dict) else {}
        pid = res.get("participant_id") or res.get("speaker_id")
        pname = res.get("participant_name") or (participant_names.get(str(pid)) if pid else None)
        skey = (str(res.get("stream_id") or ""), str(res.get("epoch") or ""))
        if not pid and skey in unambiguous_by_stream:
            pid, pname = unambiguous_by_stream[skey]
        spk = res.get("speaker_id")
        psid = res.get("provider_source_id")
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=str(pid) if pid else None,
            speaker_id=str(spk) if spk else None,
            participant_name=str(pname) if pname else None,
            provider_source_id=str(psid) if psid else None,
        ):
            db.delete(seg_row)
            deleted += 1

    pending_jobs = list(
        db.scalars(
            select(AsrJob).where(
                AsrJob.stream_id.in_(stream_ids),
                AsrJob.status.in_(["pending", "processing"]),
            )
        ).all()
    )
    for job in pending_jobs:
        binding = job.binding if isinstance(job.binding, dict) else {}
        pid = binding.get("participant_id") or binding.get("speaker_id")
        pname = binding.get("participant_name") or (
            participant_names.get(str(pid)) if pid else None
        )
        spk = binding.get("speaker_id")
        psid = binding.get("provider_source_id")
        if is_speaker_opted_out(
            opted_out_norm,
            participant_id=str(pid) if pid else None,
            speaker_id=str(spk) if spk else None,
            participant_name=str(pname) if pname else None,
            provider_source_id=str(psid) if psid else None,
        ):
            job.status, job.error, job.retry_at = "completed", None, None

    return deleted


def stream_binding_opted_out(
    db: Session,
    stream: AudioStream | None,
    binding: dict | None,
) -> bool:
    if stream is None or not isinstance(binding, dict):
        return False
    attempt = db.get(Attempt, stream.attempt_id)
    recording = db.get(Recording, attempt.recording_id) if attempt else None
    participant_names: dict[str, str] = {}
    observed_pids: set[str] = set()
    pid_s = stream.contract.get("participant_id") or stream.contract.get("speaker_id")
    if pid_s:
        observed_pids.add(str(pid_s))
        if stream.contract.get("participant_name"):
            participant_names[str(pid_s)] = str(stream.contract["participant_name"])
    bind_controls = list(
        db.scalars(
            select(AudioControl).where(
                AudioControl.stream_id == stream.id,
                AudioControl.kind == "bind",
            )
        ).all()
    )
    for ctrl in bind_controls:
        cpid = ctrl.contract.get("participant_id") or ctrl.contract.get("speaker_id")
        if cpid:
            observed_pids.add(str(cpid))
            if ctrl.contract.get("participant_name"):
                participant_names[str(cpid)] = str(ctrl.contract["participant_name"])
    _, opted_out_norm = collect_opted_out_speakers(
        recording, [attempt] if attempt else [], participant_names
    )
    if not opted_out_norm:
        return False
    pid = binding.get("participant_id") or binding.get("speaker_id")
    if not pid and len(observed_pids) == 1:
        pid = next(iter(observed_pids))
    pname = binding.get("participant_name") or (participant_names.get(str(pid)) if pid else None)
    return is_speaker_opted_out(
        opted_out_norm,
        participant_id=str(pid) if pid else None,
        speaker_id=str(binding.get("speaker_id")) if binding.get("speaker_id") else None,
        participant_name=str(pname) if pname else None,
        provider_source_id=(
            str(binding.get("provider_source_id")) if binding.get("provider_source_id") else None
        ),
    )


def segment_stream(db: Session, stream: AudioStream):
    runs, terminal, _ = timeline(db, stream, incremental=True)
    steps = 0
    for index, run in enumerate(runs):
        if run.end <= stream.scan_sample:
            continue
        if run.binding is None:
            stream.scan_sample = run.end
            continue
        if stream_binding_opted_out(db, stream, run.binding):
            stream.scan_sample = run.end
            continue
        if steps >= MAX_SCAN_STEPS:
            return
        window_origin = max(stream.scan_sample, run.start)
        # At most 10 s silence + 30 s voice + overlap; RAM remains bounded (~1.3 MB)
        # and each chunk in the window is fetched from object storage only once.
        limit = min(run.end, window_origin + SCAN_WINDOW)
        final = limit == run.end and (index < len(runs) - 1 or terminal)
        window_pcm = read_pcm(run.chunks, window_origin, limit)
        while stream.scan_sample < limit:
            if steps >= MAX_SCAN_STEPS:
                return
            cursor = max(stream.scan_sample, run.start)
            if not final and limit - cursor < FRAME:
                return
            steps += 1
            pcm = window_pcm[(cursor - window_origin) * 2 :]
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
                break
            stream.scan_sample = following
            if following <= cursor:
                return
        if stream.scan_sample < run.end:
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
