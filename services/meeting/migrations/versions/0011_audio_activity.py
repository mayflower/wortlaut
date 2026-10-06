"""Report actual ingest activity; leave older acceptance times unknown."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("audio_chunks", sa.Column("accepted_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("audio_chunks", "accepted_at")
