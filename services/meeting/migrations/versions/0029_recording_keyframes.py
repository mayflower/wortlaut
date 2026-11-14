"""Add recording_keyframes table for settled screen-share snapshots."""

import sqlalchemy as sa
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "recording_keyframes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("recording_id", sa.Uuid(), nullable=False),
        sa.Column("attempt_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("provider_source_id", sa.String(length=200), nullable=False),
        sa.Column("participant_id", sa.String(length=200), nullable=False),
        sa.Column("participant_name", sa.String(length=200), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["attempt_id"], ["attempts.id"]),
        sa.ForeignKeyConstraint(["recording_id"], ["recordings.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("attempt_id", "sequence", name="uq_recording_keyframes_attempt_seq"),
    )
    op.create_index(
        "ix_recording_keyframes_recording_id",
        "recording_keyframes",
        ["recording_id"],
    )
    op.create_index(
        "ix_recording_keyframes_attempt_id",
        "recording_keyframes",
        ["attempt_id"],
    )
    op.create_index(
        "ix_recording_keyframes_rec_captured",
        "recording_keyframes",
        ["recording_id", "captured_at"],
    )


def downgrade():
    op.drop_index("ix_recording_keyframes_rec_captured", table_name="recording_keyframes")
    op.drop_index("ix_recording_keyframes_attempt_id", table_name="recording_keyframes")
    op.drop_index("ix_recording_keyframes_recording_id", table_name="recording_keyframes")
    op.drop_table("recording_keyframes")
