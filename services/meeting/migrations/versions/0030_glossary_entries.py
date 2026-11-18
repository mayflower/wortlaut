"""Add glossary_entries table for persistent ASR and summary domain terms."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "glossary_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_email", sa.String(length=320), nullable=False, server_default=""),
        sa.Column("term_key", sa.String(length=80), nullable=False),
        sa.Column("term", sa.String(length=80), nullable=False),
        sa.Column(
            "aliases",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_email", "term_key", name="uq_glossary_entries_owner_term"),
    )
    op.create_index(
        "ix_glossary_entries_owner_email",
        "glossary_entries",
        ["owner_email"],
    )


def downgrade():
    op.drop_index("ix_glossary_entries_owner_email", table_name="glossary_entries")
    op.drop_table("glossary_entries")
