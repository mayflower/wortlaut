"""Read remaining source audio by sample interval."""

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_audio_chunks_stream_start", "audio_chunks", ["stream_id", "start_sample"])
    op.create_index("ix_audio_controls_stream_start", "audio_controls", ["stream_id", "start_sample"])


def downgrade():
    op.drop_index("ix_audio_controls_stream_start", table_name="audio_controls")
    op.drop_index("ix_audio_chunks_stream_start", table_name="audio_chunks")
