"""Recording occurrences and exclusive capture attempts."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "recordings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("idempotency_key", sa.String(200), nullable=False, unique=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("meeting_url", sa.String(2048), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("participation", sa.String(32), nullable=False),
        sa.Column("processing", sa.String(32), nullable=False),
        sa.Column("active_attempt_id", sa.Uuid(), nullable=True),
    )
    op.create_table(
        "attempts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("recording_id", sa.Uuid(), sa.ForeignKey("recordings.id"), nullable=False),
        sa.Column("credential_hash", sa.String(64), nullable=False),
        sa.Column("credential_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("worker_id", sa.String(128), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(64), nullable=True),
    )
    op.create_index("ix_attempts_recording_id", "attempts", ["recording_id"])


def downgrade():
    op.drop_table("attempts")
    op.drop_table("recordings")
