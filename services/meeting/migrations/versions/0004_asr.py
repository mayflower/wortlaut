"""Source-local segmentation checkpoints and durable inference work."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004_asr"
down_revision = "0003_audio"


def upgrade():
    op.add_column(
        "audio_streams",
        sa.Column("scan_sample", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "audio_streams",
        sa.Column("scan_complete", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "asr_jobs",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("stream_id", sa.Uuid(), sa.ForeignKey("audio_streams.id"), nullable=False),
        sa.Column("start_sample", sa.BigInteger(), nullable=False),
        sa.Column("end_sample", sa.BigInteger(), nullable=False),
        sa.Column("core_start", sa.BigInteger(), nullable=False),
        sa.Column("core_end", sa.BigInteger(), nullable=False),
        sa.Column("binding", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.Column("retry_at", sa.DateTime(timezone=True)),
        sa.Column("error", sa.String(64)),
        sa.UniqueConstraint("stream_id", "core_start", "core_end"),
    )
    op.create_index("ix_asr_jobs_stream_id", "asr_jobs", ["stream_id"])
    op.create_index("ix_asr_jobs_status", "asr_jobs", ["status"])
    op.create_table(
        "transcript_segments",
        sa.Column("id", sa.String(64), sa.ForeignKey("asr_jobs.id"), primary_key=True),
        sa.Column("result", JSONB, nullable=False),
    )


def downgrade():
    op.drop_table("transcript_segments")
    op.drop_table("asr_jobs")
    op.drop_column("audio_streams", "scan_complete")
    op.drop_column("audio_streams", "scan_sample")
