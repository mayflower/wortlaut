"""Fence superseded audio sockets before finalizing discarded ranges."""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("attempts", sa.Column("audio_connection_id", sa.Uuid()))


def downgrade():
    op.drop_column("attempts", "audio_connection_id")
