"""One durable PostgreSQL claim at a time; the GPU owns its inference lock."""

import hashlib
import math
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioStream, Recording, TranscriptSegment
from wortlaut.processing import RATE, read_pcm
from wortlaut.settings import get_settings


class InvalidResult(ValueError):
    pass


def segment_result(job: AsrJob, stream: AudioStream, response: dict):
    words = response.get("words")
    if not isinstance(words, list) or (response.get("text") and not words):
        raise InvalidResult("word_timestamps_unavailable")
    duration = (job.end_sample - job.start_sample) / RATE
    offset = (
        stream.contract["monotonic_origin_ms"] - stream.contract["session_monotonic_origin_ms"]
    ) / 1000
    accepted = []
    for word in words:
        start, end = word.get("start"), word.get("end")
        if (
            not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end < start
            or end > duration + 0.1
            or not isinstance(word.get("word"), str)
        ):
            raise InvalidResult("invalid_word_timestamps")
        midpoint = job.start_sample + (start + end) / 2 * RATE
        if job.core_start <= midpoint < job.core_end:
            accepted.append(
                {
                    "word": word["word"],
                    "start": offset + job.start_sample / RATE + start,
                    "end": offset + job.start_sample / RATE + min(end, duration),
                }
            )
    return {
        "id": job.id,
        "stream_id": str(stream.stream_id),
        "epoch": str(stream.epoch),
        **job.binding,
        "session_utc_origin": stream.contract["session_utc_origin"],
        "start": accepted[0]["start"] if accepted else offset + job.core_start / RATE,
        "end": accepted[-1]["end"] if accepted else offset + job.core_end / RATE,
        "text": " ".join(word["word"] for word in accepted),
        "words": accepted,
    }


def claim_job(db: Session):
    now = datetime.now(UTC)
    settings = get_settings()
    job = db.scalar(
        select(AsrJob)
        .where(
            or_(
                (AsrJob.status == "pending")
                & (AsrJob.retry_at.is_(None) | (AsrJob.retry_at <= now)),
                (AsrJob.status == "processing")
                & (AsrJob.claimed_at < now - timedelta(seconds=settings.asr_lease_seconds)),
            )
        )
        .order_by(AsrJob.retry_at.asc().nullsfirst(), AsrJob.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if job:
        job.status, job.claimed_at = "processing", now
        db.commit()
    return job


def commit_result(db: Session, identifier: str, result: dict):
    job = db.scalar(select(AsrJob).where(AsrJob.id == identifier).with_for_update())
    if job.status in ("completed", "failed"):
        return  # A late GPU result cannot revive explicitly abandoned work.
    # A client timeout cannot cancel GPU work. A late valid result is identified
    # by the immutable job, and a committed segment is never duplicated/rewritten.
    if db.get(TranscriptSegment, identifier) is None:
        db.add(TranscriptSegment(id=identifier, result=result))
    job.status, job.error, job.retry_at = "completed", None, None
    db.commit()


def retry_job(engine, identifier: str, reason: str, permanent: bool):
    with Session(engine) as db:
        job = db.scalar(select(AsrJob).where(AsrJob.id == identifier).with_for_update())
        if job.status == "completed" or job.error == "audio_retention_expired":
            return
        if permanent:
            job.attempts += 1
        job.error = reason
        job.status = (
            "failed" if job.attempts >= get_settings().asr_max_permanent_failures else "pending"
        )
        job.retry_at = datetime.now(UTC) + timedelta(seconds=30)
        db.commit()


def inference_pass(engine):
    settings = get_settings()
    if not settings.asr_token:
        return  # Visible pending work, never a fabricated successful transcript.
    with Session(engine) as db:
        job = claim_job(db)
        if job is None:
            return
        identifier = job.id
        stream = db.get(AudioStream, job.stream_id)
        chunks = db.scalars(
            select(AudioChunk)
            .where(
                AudioChunk.stream_id == stream.id,
                AudioChunk.start_sample < job.end_sample,
                AudioChunk.start_sample + AudioChunk.sample_count > job.start_sample,
            )
            .order_by(AudioChunk.start_sample)
        ).all()
        try:
            pcm = read_pcm(chunks, job.start_sample, job.end_sample)
            with httpx.Client(
                timeout=settings.asr_timeout_seconds, follow_redirects=False
            ) as client:
                response = client.post(
                    settings.asr_url + "/v1/transcribe",
                    content=pcm,
                    headers={
                        "Authorization": "Bearer " + settings.asr_token.get_secret_value(),
                        "Content-Type": "application/octet-stream",
                        "X-Job-ID": identifier,
                    },
                )
            if response.status_code != 200:
                retry_job(
                    engine,
                    identifier,
                    f"gpu_http_{response.status_code}",
                    response.status_code in (400, 413, 422),
                )
                return
            payload = response.json()
            if (
                payload.get("job_id") != identifier
                or payload.get("pcm_sha256") != hashlib.sha256(pcm).hexdigest()
            ):
                raise InvalidResult("gpu_result_identity_mismatch")
            result = segment_result(job, stream, payload)
            commit_result(db, identifier, result)
        except httpx.HTTPError:
            retry_job(engine, identifier, "gpu_unavailable", False)
        except (InvalidResult, ValueError, TypeError, KeyError, AttributeError):
            retry_job(engine, identifier, "invalid_audio_or_model_result", True)


def finalize_processing(engine):
    with Session(engine) as db:
        recordings = db.scalars(
            select(Recording)
            .where(
                Recording.participation == "ended",
                Recording.processing.in_(["pending", "processing"]),
            )
            .with_for_update(skip_locked=True)
        ).all()
        for recording in recordings:
            streams = db.scalars(
                select(AudioStream).join(Attempt).where(Attempt.recording_id == recording.id)
            ).all()
            if not all(stream.scan_complete for stream in streams):
                continue
            jobs = db.scalars(
                select(AsrJob).where(AsrJob.stream_id.in_([s.id for s in streams]))
            ).all()
            if any(job.status in ("pending", "processing") for job in jobs):
                continue
            recording.processing = (
                "failed" if any(job.status == "failed" for job in jobs) else "completed"
            )
            recording.processing_finished_at = datetime.now(UTC)
            recording.audio_closed_at = datetime.now(UTC)
        db.commit()
