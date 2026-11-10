import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Recording(Base):
    __tablename__ = "recordings"
    __table_args__ = (
        UniqueConstraint("calendar_entry_id", "recurrence_key"),
        CheckConstraint(
            "provider IN ('webex', 'google_meet', 'teams', 'zoom')", name="recordings_provider"
        ),
        Index("ix_recordings_start_id", "starts_at", "id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    request_digest: Mapped[str] = mapped_column(String(64))
    meeting_url: Mapped[str] = mapped_column(String(2048))
    provider: Mapped[str] = mapped_column(String(32), default="webex", server_default="webex")
    title: Mapped[str | None] = mapped_column(String(200))
    guest_name: Mapped[str | None] = mapped_column(String(120))
    owner_sub: Mapped[str | None] = mapped_column(String(256), index=True)
    owner_email: Mapped[str | None] = mapped_column(String(320), index=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    participation: Mapped[str] = mapped_column(String(32), default="scheduled")
    processing: Mapped[str] = mapped_column(String(32), default="pending")
    active_attempt_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    participation_reason: Mapped[str | None] = mapped_column(String(64))
    audio_closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    processing_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    processing_error: Mapped[str | None] = mapped_column(String(64))
    audio_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    transcript_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    metadata_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    export_reader_nonce: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    calendar_entry_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("calendar_entries.id"))
    calendar_conflict: Mapped[bool] = mapped_column(Boolean, default=False)
    recurrence_key: Mapped[str | None] = mapped_column(String(100))
    protocol_meta: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")


class CalendarEntry(Base):
    __tablename__ = "calendar_entries"
    __table_args__ = (UniqueConstraint("mailbox", "uid", "organizer", "recurrence_key"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    mailbox: Mapped[str] = mapped_column(String(200))
    uid: Mapped[str] = mapped_column(String(512))
    organizer: Mapped[str] = mapped_column(String(320))
    recurrence_key: Mapped[str] = mapped_column(String(100), default="")
    recurrence_anchor: Mapped[str | None] = mapped_column(String(512))
    sequence: Mapped[int] = mapped_column(Integer)
    dtstamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    digest: Mapped[str] = mapped_column(String(64))
    original: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(String(64))
    conflict_digest: Mapped[str | None] = mapped_column(String(64))


class MailCursor(Base):
    __tablename__ = "mail_cursors"

    mailbox: Mapped[str] = mapped_column(String(200), primary_key=True)
    uidvalidity: Mapped[int] = mapped_column(BigInteger)
    last_uid: Mapped[int] = mapped_column(BigInteger, default=0)


class MailImport(Base):
    __tablename__ = "mail_imports"
    __table_args__ = (UniqueConstraint("mailbox", "uidvalidity", "message_uid"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    mailbox: Mapped[str] = mapped_column(String(200))
    uidvalidity: Mapped[int] = mapped_column(BigInteger)
    message_uid: Mapped[int] = mapped_column(BigInteger)
    result: Mapped[list] = mapped_column(JSONB)


class Delivery(Base):
    __tablename__ = "deliveries"

    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id"), primary_key=True)
    message_id: Mapped[str] = mapped_column(String(300), unique=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    recipients: Mapped[list] = mapped_column(JSONB)
    accepted_recipients: Mapped[list] = mapped_column(JSONB, default=list)
    refused_codes: Mapped[dict] = mapped_column(JSONB, default=dict)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(64))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Attempt(Base):
    __tablename__ = "attempts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id"), index=True)
    credential_hash: Mapped[str] = mapped_column(String(64))
    credential_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    audio_connection_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    audio_ingest_tokens: Mapped[float] = mapped_column(Float, default=0, server_default="0")
    audio_ingest_refilled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    diagnostics: Mapped[dict] = mapped_column(JSONB, default=dict)
    job_name: Mapped[str | None] = mapped_column(String(63), unique=True)
    job_uid: Mapped[str | None] = mapped_column(String(64))
    pod_uids: Mapped[list] = mapped_column(JSONB, default=list)
    process_ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    secret_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    job_create_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AudioStream(Base):
    __tablename__ = "audio_streams"
    __table_args__ = (
        UniqueConstraint("attempt_id", "stream_id", "epoch"),
        Index(
            "ix_audio_streams_active_attempt",
            "attempt_id",
            postgresql_where=text("final_sample IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempts.id"), index=True)
    stream_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    epoch: Mapped[uuid.UUID] = mapped_column(Uuid)
    contract: Mapped[dict] = mapped_column(JSONB)
    final_sample: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scan_sample: Mapped[int] = mapped_column(BigInteger, default=0)
    scan_complete: Mapped[bool] = mapped_column(Boolean, default=False)
    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scan_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AudioChunk(Base):
    __tablename__ = "audio_chunks"
    __table_args__ = (
        UniqueConstraint("stream_id", "sequence"),
        Index("ix_audio_chunks_stream_start", "stream_id", "start_sample"),
    )

    id: Mapped[str] = mapped_column(String(256), primary_key=True)
    stream_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audio_streams.id"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    start_sample: Mapped[int] = mapped_column(BigInteger)
    sample_count: Mapped[int] = mapped_column(Integer)
    checksum: Mapped[str] = mapped_column(String(64))
    contract: Mapped[dict] = mapped_column(JSONB)
    object_key: Mapped[str] = mapped_column(String(512), unique=True)
    object_size: Mapped[int] = mapped_column(Integer)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    processing_error: Mapped[str | None] = mapped_column(String(64))
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class AudioControl(Base):
    __tablename__ = "audio_controls"
    __table_args__ = (Index("ix_audio_controls_stream_start", "stream_id", "start_sample"),)

    id: Mapped[str] = mapped_column(String(300), primary_key=True)
    stream_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audio_streams.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    sequence: Mapped[int | None] = mapped_column(Integer)
    start_sample: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    contract: Mapped[dict] = mapped_column(JSONB)


class AsrJob(Base):
    __tablename__ = "asr_jobs"
    __table_args__ = (UniqueConstraint("stream_id", "core_start", "core_end"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    stream_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("audio_streams.id"), index=True)
    start_sample: Mapped[int] = mapped_column(BigInteger)
    end_sample: Mapped[int] = mapped_column(BigInteger)
    core_start: Mapped[int] = mapped_column(BigInteger)
    core_end: Mapped[int] = mapped_column(BigInteger)
    binding: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"

    id: Mapped[str] = mapped_column(ForeignKey("asr_jobs.id"), primary_key=True)
    result: Mapped[dict] = mapped_column(JSONB)


class CalendarConnection(Base):
    __tablename__ = "calendar_connections"
    __table_args__ = (
        UniqueConstraint(
            "owner_email",
            "provider",
            "account_email",
            name="uq_calendar_connections_owner_provider",
        ),
        CheckConstraint(
            "provider IN ('google', 'microsoft')",
            name="calendar_connections_provider",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_sub: Mapped[str | None] = mapped_column(String(256), index=True)
    owner_email: Mapped[str] = mapped_column(String(320), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    account_email: Mapped[str] = mapped_column(String(320))
    encrypted_refresh_token: Mapped[str] = mapped_column(String)
    encrypted_access_token: Mapped[str | None] = mapped_column(String, nullable=True)
    token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sync_error: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )


class CalendarSyncedEvent(Base):
    __tablename__ = "calendar_synced_events"
    __table_args__ = (
        UniqueConstraint(
            "connection_id",
            "external_event_id",
            name="uq_calendar_synced_events_conn_ext",
        ),
        CheckConstraint(
            "calendar_provider IN ('google', 'microsoft')",
            name="calendar_synced_events_cal_provider",
        ),
        CheckConstraint(
            "meeting_provider IN ('webex', 'google_meet', 'teams', 'zoom')",
            name="calendar_synced_events_mtg_provider",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    connection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("calendar_connections.id", ondelete="CASCADE"), index=True
    )
    owner_sub: Mapped[str | None] = mapped_column(String(256), index=True)
    owner_email: Mapped[str] = mapped_column(String(320), index=True)
    calendar_provider: Mapped[str] = mapped_column(String(32))
    external_event_id: Mapped[str] = mapped_column(String(512))
    ical_uid: Mapped[str | None] = mapped_column(String(512), nullable=True)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    organizer_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    is_self_organized: Mapped[bool] = mapped_column(Boolean, default=False)
    meeting_provider: Mapped[str] = mapped_column(String(32))
    meeting_url: Mapped[str] = mapped_column(String(2048))
    status: Mapped[str] = mapped_column(String(32), default="confirmed")
    auto_record: Mapped[bool] = mapped_column(Boolean, default=False)
    user_override: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    recording_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("recordings.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )

