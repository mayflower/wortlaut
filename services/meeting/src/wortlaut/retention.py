"""Finite retry/audio retention, independent of worker-process termination."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from wortlaut.models import AsrJob, Attempt, AudioChunk, AudioStream, Recording, TranscriptSegment
from wortlaut.settings import get_settings
from wortlaut.storage import get_storage


def retention_pass(engine):
    now, settings = datetime.now(UTC), get_settings()
    with Session(engine) as db:
        identifiers = db.scalars(
            select(Recording.id)
            .where(
                Recording.audio_deleted_at.is_(None) | Recording.transcript_deleted_at.is_(None),
                (Recording.ends_at < now - timedelta(hours=settings.processing_max_age_hours))
                | (Recording.processing_finished_at.is_not(None)),
            )
            .order_by(Recording.ends_at)
        ).all()
    for identifier in identifiers:
        with Session(engine) as db:
            recording = db.scalar(
                select(Recording)
                .where(Recording.id == identifier)
                .with_for_update(skip_locked=True)
            )
            if recording is None:
                continue
            streams = db.scalars(
                select(AudioStream)
                .join(Attempt)
                .where(Attempt.recording_id == recording.id)
                .with_for_update(of=AudioStream)
            ).all()
            stream_ids = [s.id for s in streams]
            if recording.processing not in ("completed", "failed"):
                # This closes capture/processing, not the remote process. Its
                # exclusive claim remains blocked until actual termination proof.
                recording.audio_closed_at = recording.processing_finished_at = now
                recording.processing = "failed"
                recording.processing_error = "audio_retention_expired"
                for stream in streams:
                    stream.scan_complete = True
                jobs = db.scalars(
                    select(AsrJob)
                    .where(
                        AsrJob.stream_id.in_(stream_ids),
                        AsrJob.status.in_(["pending", "processing"]),
                    )
                    .with_for_update()
                ).all()
                for job in jobs:
                    job.status, job.error, job.retry_at = "failed", "audio_retention_expired", None
                db.commit()  # Publish abandonment before any audio deletion.
                continue
            finished = recording.processing_finished_at
            if finished is None:
                recording.processing_finished_at = now
                db.commit()
                continue
            hours = (
                settings.audio_retention_hours
                if recording.processing == "completed"
                else settings.failed_audio_retention_hours
            )
            if not recording.audio_deleted_at and now >= finished + timedelta(hours=hours):
                recording.audio_closed_at = recording.audio_closed_at or now
                get_storage().delete_recording(recording.id)
                chunks = db.scalars(select(AudioChunk).where(AudioChunk.stream_id.in_(stream_ids)))
                for chunk in chunks:
                    chunk.deleted_at = now
                recording.audio_deleted_at = now
            if not recording.transcript_deleted_at and now >= finished + timedelta(
                days=settings.transcript_retention_days
            ):
                ids = select(AsrJob.id).where(AsrJob.stream_id.in_(stream_ids))
                db.execute(delete(TranscriptSegment).where(TranscriptSegment.id.in_(ids)))
                recording.transcript_deleted_at = now
            db.commit()
