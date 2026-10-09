"""Scope large-export download credentials to one recording."""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("recordings", sa.Column("export_reader_nonce", sa.Uuid()))


def downgrade():
    op.drop_column("recordings", "export_reader_nonce")
