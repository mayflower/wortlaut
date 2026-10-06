"""Durable source epochs, immutable PCM and acknowledged control messages."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003_audio"
down_revision = "0002_worker_status"


def upgrade():
    op.create_table(
        "audio_streams",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("attempt_id", sa.Uuid(), sa.ForeignKey("attempts.id"), nullable=False),
        sa.Column("stream_id", sa.Uuid(), nullable=False),
        sa.Column("epoch", sa.Uuid(), nullable=False),
        sa.Column("contract", JSONB, nullable=False),
        sa.Column("final_sample", sa.BigInteger()),
        sa.Column("last_sequence", sa.Integer()),
        sa.UniqueConstraint("attempt_id", "stream_id", "epoch"),
    )
    op.create_index("ix_audio_streams_attempt_id", "audio_streams", ["attempt_id"])
    op.create_table(
        "audio_chunks",
        sa.Column("id", sa.String(256), primary_key=True),
        sa.Column("stream_id", sa.Uuid(), sa.ForeignKey("audio_streams.id"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("start_sample", sa.BigInteger(), nullable=False),
        sa.Column("sample_count", sa.Integer(), nullable=False),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("contract", JSONB, nullable=False),
        sa.Column("object_key", sa.String(512), unique=True, nullable=False),
        sa.UniqueConstraint("stream_id", "sequence"),
    )
    op.create_index("ix_audio_chunks_stream_id", "audio_chunks", ["stream_id"])
    op.create_table(
        "audio_controls",
        sa.Column("id", sa.String(300), primary_key=True),
        sa.Column("stream_id", sa.Uuid(), sa.ForeignKey("audio_streams.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("start_sample", sa.BigInteger()),
        sa.Column("contract", JSONB, nullable=False),
    )
    op.create_index("ix_audio_controls_stream_id", "audio_controls", ["stream_id"])


def downgrade():
    op.drop_table("audio_controls")
    op.drop_table("audio_chunks")
    op.drop_table("audio_streams")
