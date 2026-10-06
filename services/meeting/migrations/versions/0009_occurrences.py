"""Occurrence identity is the original recurrence time, never the moved start."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("recordings_calendar_entry_unique", "recordings", type_="unique")
    op.add_column("recordings", sa.Column("recurrence_key", sa.String(100)))
    op.execute(
        sa.text("UPDATE recordings SET recurrence_key = '' WHERE calendar_entry_id IS NOT NULL")
    )
    op.create_unique_constraint(
        "recordings_calendar_occurrence_unique",
        "recordings",
        ["calendar_entry_id", "recurrence_key"],
    )


def downgrade():
    raise RuntimeError("Occurrence expansion cannot be downgraded into one recording per series")
