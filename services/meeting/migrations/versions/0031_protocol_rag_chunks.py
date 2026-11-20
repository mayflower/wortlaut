"""Add protocol_chunks table for extension-free hybrid RAG protocol search."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "protocol_chunks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("recording_id", sa.Uuid(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("chunk_kind", sa.String(length=24), nullable=False),
        sa.Column("speaker_label", sa.Text(), nullable=True),
        sa.Column("start_seconds", sa.Float(), nullable=True),
        sa.Column("end_seconds", sa.Float(), nullable=True),
        sa.Column("wall_clock", sa.String(length=32), nullable=True),
        sa.Column("keyframe_id", sa.Uuid(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("search_tsv", postgresql.TSVECTOR(), nullable=False),
        sa.Column("embedding_model", sa.String(length=80), nullable=False),
        sa.Column("embedding_dim", sa.Integer(), nullable=False),
        sa.Column("embedding", sa.LargeBinary(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["recording_id"],
            ["recordings.id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("recording_id", "chunk_index", name="uq_protocol_chunks_rec_idx"),
        sa.CheckConstraint(
            "chunk_kind IN ("
            "'decision', 'action_item', 'summary', 'topic', 'notes', 'slide', 'transcript'"
            ")",
            name="protocol_chunks_kind",
        ),
    )
    op.create_index("ix_protocol_chunks_rec", "protocol_chunks", ["recording_id"])
    op.create_index(
        "ix_protocol_chunks_search_tsv",
        "protocol_chunks",
        ["search_tsv"],
        postgresql_using="gin",
    )


def downgrade():
    op.drop_index("ix_protocol_chunks_search_tsv", table_name="protocol_chunks")
    op.drop_index("ix_protocol_chunks_rec", table_name="protocol_chunks")
    op.drop_table("protocol_chunks")
