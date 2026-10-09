"""Bound new ingest records per attempt across sockets and service restarts."""

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "attempts", sa.Column("audio_ingest_tokens", sa.Float(), nullable=False, server_default="0")
    )
    op.add_column("attempts", sa.Column("audio_ingest_refilled_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("attempts", "audio_ingest_refilled_at")
    op.drop_column("attempts", "audio_ingest_tokens")
