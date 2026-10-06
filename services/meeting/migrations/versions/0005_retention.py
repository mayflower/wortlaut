"""Bound audio/work retention independently from confirmed worker termination."""

import sqlalchemy as sa
from alembic import op

revision = "0005_retention"
down_revision = "0004_asr"


def upgrade():
    for name in (
        "audio_closed_at",
        "processing_finished_at",
        "audio_deleted_at",
        "transcript_deleted_at",
    ):
        op.add_column("recordings", sa.Column(name, sa.DateTime(timezone=True)))
    op.add_column("recordings", sa.Column("processing_error", sa.String(64)))
    op.add_column("audio_streams", sa.Column("last_scanned_at", sa.DateTime(timezone=True)))
    op.add_column("audio_chunks", sa.Column("deleted_at", sa.DateTime(timezone=True)))
    op.add_column("audio_chunks", sa.Column("object_size", sa.Integer(), nullable=True))
    op.execute(
        "UPDATE audio_chunks SET object_size = sample_count * 2 + octet_length(contract::text) + 13"
    )
    op.alter_column("audio_chunks", "object_size", nullable=False)


def downgrade():
    for name in ("object_size", "deleted_at"):
        op.drop_column("audio_chunks", name)
    op.drop_column("audio_streams", "last_scanned_at")
    for name in (
        "audio_closed_at",
        "processing_finished_at",
        "processing_error",
        "audio_deleted_at",
        "transcript_deleted_at",
    ):
        op.drop_column("recordings", name)
