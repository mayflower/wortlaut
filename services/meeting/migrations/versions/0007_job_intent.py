"""Preserve ambiguous Job creation across process failure."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("attempts", sa.Column("job_create_requested_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("attempts", "job_create_requested_at")
