"""Persist worker ownership and cancellation across controller restarts."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005_retention"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("recordings", sa.Column("cancelled_at", sa.DateTime(timezone=True)))
    op.add_column("recordings", sa.Column("participation_reason", sa.String(64)))
    op.add_column("attempts", sa.Column("job_name", sa.String(63)))
    op.create_unique_constraint("uq_attempts_job_name", "attempts", ["job_name"])
    op.add_column("attempts", sa.Column("job_uid", sa.String(64)))
    op.add_column(
        "attempts", sa.Column("pod_uids", postgresql.JSONB(), nullable=False, server_default="[]")
    )
    op.add_column("attempts", sa.Column("process_ended_at", sa.DateTime(timezone=True)))
    op.add_column("attempts", sa.Column("secret_deleted_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("attempts", "secret_deleted_at")
    op.drop_column("attempts", "process_ended_at")
    op.drop_column("attempts", "pod_uids")
    op.drop_column("attempts", "job_uid")
    op.drop_constraint("uq_attempts_job_name", "attempts", type_="unique")
    op.drop_column("attempts", "job_name")
    op.drop_column("recordings", "participation_reason")
    op.drop_column("recordings", "cancelled_at")
