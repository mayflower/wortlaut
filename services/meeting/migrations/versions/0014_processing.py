"""Isolate unreadable audio and schedule ASR work by age."""

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("audio_controls", sa.Column("sequence", sa.Integer()))
    op.execute(
        "UPDATE audio_controls SET sequence = (contract->>'sequence')::integer WHERE kind = 'gap'"
    )
    op.create_index(
        "ix_audio_controls_stream_sequence", "audio_controls", ["stream_id", "sequence"]
    )
    op.add_column("audio_streams", sa.Column("scan_retry_at", sa.DateTime(timezone=True)))
    op.add_column(
        "audio_chunks", sa.Column("read_failures", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("audio_chunks", sa.Column("processing_error", sa.String(64)))
    op.add_column(
        "asr_jobs",
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    # Historical jobs retain a stable order; future jobs carry their actual creation time.
    op.create_index("ix_asr_jobs_claim_age", "asr_jobs", ["status", "created_at", "id"])


def downgrade():
    op.drop_index("ix_audio_controls_stream_sequence", table_name="audio_controls")
    op.drop_column("audio_controls", "sequence")
    op.drop_index("ix_asr_jobs_claim_age", table_name="asr_jobs")
    op.drop_column("asr_jobs", "created_at")
    op.drop_column("audio_chunks", "processing_error")
    op.drop_column("audio_chunks", "read_failures")
    op.drop_column("audio_streams", "scan_retry_at")
