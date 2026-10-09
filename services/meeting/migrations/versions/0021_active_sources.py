"""Read active source capacity without scanning closed capture epochs."""

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_audio_streams_active_attempt",
        "audio_streams",
        ["attempt_id"],
        postgresql_where=sa.text("final_sample IS NULL"),
    )


def downgrade():
    op.drop_index("ix_audio_streams_active_attempt", table_name="audio_streams")
