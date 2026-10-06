"""SMTP acceptance is durable and can remain unknown."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "deliveries",
        sa.Column("recording_id", sa.Uuid(), sa.ForeignKey("recordings.id"), primary_key=True),
        sa.Column("message_id", sa.String(300), nullable=False, unique=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("recipients", postgresql.JSONB(), nullable=False),
        sa.Column("accepted_recipients", postgresql.JSONB(), nullable=False),
        sa.Column("refused_codes", postgresql.JSONB(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("retry_at", sa.DateTime(timezone=True)),
        sa.Column("error", sa.String(64)),
        sa.Column("delivered_at", sa.DateTime(timezone=True)),
    )


def downgrade():
    op.drop_table("deliveries")
