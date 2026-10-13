"""Allow Teams alongside Webex and Google Meet."""

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("recordings_provider", "recordings", type_="check")
    op.create_check_constraint(
        "recordings_provider", "recordings", "provider IN ('webex', 'google_meet', 'teams')"
    )


def downgrade():
    op.drop_constraint("recordings_provider", "recordings", type_="check")
    op.create_check_constraint(
        "recordings_provider", "recordings", "provider IN ('webex', 'google_meet')"
    )
