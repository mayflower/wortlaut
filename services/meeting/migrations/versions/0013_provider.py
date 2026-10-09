"""Keep existing Webex recordings and identify the browser Meet provider."""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "recordings",
        sa.Column("provider", sa.String(32), nullable=False, server_default="webex"),
    )
    op.create_check_constraint(
        "recordings_provider", "recordings", "provider IN ('webex', 'google_meet')"
    )


def downgrade():
    op.drop_constraint("recordings_provider", "recordings", type_="check")
    op.drop_column("recordings", "provider")
