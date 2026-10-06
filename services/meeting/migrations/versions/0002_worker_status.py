"""Worker heartbeat and provider capability, separate from participation."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002_worker_status"
down_revision = "0001"


def upgrade():
    op.add_column("attempts", sa.Column("last_heartbeat_at", sa.DateTime(timezone=True)))
    op.add_column("attempts", sa.Column("diagnostics", JSONB, nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("attempts", "diagnostics")
    op.drop_column("attempts", "last_heartbeat_at")
