"""Calendar identity, versions and durable mailbox progress."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "calendar_entries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("mailbox", sa.String(200), nullable=False),
        sa.Column("uid", sa.String(512), nullable=False),
        sa.Column("organizer", sa.String(320), nullable=False),
        sa.Column("recurrence_key", sa.String(100), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("dtstamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("original", sa.String(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("reason", sa.String(64)),
        sa.Column("conflict_digest", sa.String(64)),
        sa.UniqueConstraint("mailbox", "uid", "organizer", "recurrence_key"),
    )
    op.add_column("recordings", sa.Column("calendar_entry_id", sa.Uuid()))
    op.create_foreign_key(
        "recordings_calendar_entry_fk",
        "recordings",
        "calendar_entries",
        ["calendar_entry_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "recordings_calendar_entry_unique", "recordings", ["calendar_entry_id"]
    )
    op.add_column(
        "recordings",
        sa.Column("calendar_conflict", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "mail_cursors",
        sa.Column("mailbox", sa.String(200), primary_key=True),
        sa.Column("uidvalidity", sa.BigInteger(), nullable=False),
        sa.Column("last_uid", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "mail_imports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("mailbox", sa.String(200), nullable=False),
        sa.Column("uidvalidity", sa.BigInteger(), nullable=False),
        sa.Column("message_uid", sa.BigInteger(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("mailbox", "uidvalidity", "message_uid"),
    )


def downgrade():
    op.drop_table("mail_imports")
    op.drop_table("mail_cursors")
    op.drop_column("recordings", "calendar_conflict")
    op.drop_column("recordings", "calendar_entry_id")
    op.drop_table("calendar_entries")
