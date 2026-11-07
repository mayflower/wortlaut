"""Add optional recording title and guest display name."""

import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("recordings", sa.Column("title", sa.String(length=200), nullable=True))
    op.add_column("recordings", sa.Column("guest_name", sa.String(length=120), nullable=True))


def downgrade():
    op.drop_column("recordings", "guest_name")
    op.drop_column("recordings", "title")
