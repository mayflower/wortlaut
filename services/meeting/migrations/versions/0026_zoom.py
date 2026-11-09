"""Allow zoom provider in recordings and calendar_synced_events."""

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("recordings_provider", "recordings", type_="check")
    op.create_check_constraint(
        "recordings_provider",
        "recordings",
        "provider IN ('webex', 'google_meet', 'teams', 'zoom')",
    )
    op.drop_constraint(
        "calendar_synced_events_mtg_provider",
        "calendar_synced_events",
        type_="check",
    )
    op.create_check_constraint(
        "calendar_synced_events_mtg_provider",
        "calendar_synced_events",
        "meeting_provider IN ('webex', 'google_meet', 'teams', 'zoom')",
    )


def downgrade():
    op.drop_constraint(
        "calendar_synced_events_mtg_provider",
        "calendar_synced_events",
        type_="check",
    )
    op.create_check_constraint(
        "calendar_synced_events_mtg_provider",
        "calendar_synced_events",
        "meeting_provider IN ('webex', 'google_meet', 'teams')",
    )
    op.drop_constraint("recordings_provider", "recordings", type_="check")
    op.create_check_constraint(
        "recordings_provider",
        "recordings",
        "provider IN ('webex', 'google_meet', 'teams')",
    )
