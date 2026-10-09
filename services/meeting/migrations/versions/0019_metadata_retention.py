"""Track completed metadata retention independently of worker termination."""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("recordings", sa.Column("metadata_deleted_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("recordings", "metadata_deleted_at")
