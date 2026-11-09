"""Add recording owner_sub and owner_email for Dex OIDC user isolation."""

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("recordings", sa.Column("owner_sub", sa.String(length=256), nullable=True))
    op.add_column("recordings", sa.Column("owner_email", sa.String(length=320), nullable=True))
    op.create_index("ix_recordings_owner_sub", "recordings", ["owner_sub"])
    op.create_index("ix_recordings_owner_email", "recordings", ["owner_email"])


def downgrade():
    op.drop_index("ix_recordings_owner_email", table_name="recordings")
    op.drop_index("ix_recordings_owner_sub", table_name="recordings")
    op.drop_column("recordings", "owner_email")
    op.drop_column("recordings", "owner_sub")
