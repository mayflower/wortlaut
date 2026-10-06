"""Keep the original recurrence anchor across calendar updates."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("calendar_entries", sa.Column("recurrence_anchor", sa.String(512)))


def downgrade():
    op.drop_column("calendar_entries", "recurrence_anchor")
