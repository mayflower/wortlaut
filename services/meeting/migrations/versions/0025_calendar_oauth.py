"""Add calendar_connections and calendar_synced_events for Google & Microsoft OAuth2 sync."""

import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "calendar_connections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_sub", sa.String(length=256), nullable=True),
        sa.Column("owner_email", sa.String(length=320), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("account_email", sa.String(length=320), nullable=False),
        sa.Column("encrypted_refresh_token", sa.String(), nullable=False),
        sa.Column("encrypted_access_token", sa.String(), nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sync_error", sa.String(length=128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_email",
            "provider",
            "account_email",
            name="uq_calendar_connections_owner_provider",
        ),
        sa.CheckConstraint(
            "provider IN ('google', 'microsoft')",
            name="calendar_connections_provider",
        ),
    )
    op.create_index(
        "ix_calendar_connections_owner_sub", "calendar_connections", ["owner_sub"]
    )
    op.create_index(
        "ix_calendar_connections_owner_email", "calendar_connections", ["owner_email"]
    )

    op.create_table(
        "calendar_synced_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("connection_id", sa.Uuid(), nullable=False),
        sa.Column("owner_sub", sa.String(length=256), nullable=True),
        sa.Column("owner_email", sa.String(length=320), nullable=False),
        sa.Column("calendar_provider", sa.String(length=32), nullable=False),
        sa.Column("external_event_id", sa.String(length=512), nullable=False),
        sa.Column("ical_uid", sa.String(length=512), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("organizer_email", sa.String(length=320), nullable=True),
        sa.Column("is_self_organized", sa.Boolean(), nullable=False),
        sa.Column("meeting_provider", sa.String(length=32), nullable=False),
        sa.Column("meeting_url", sa.String(length=2048), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("auto_record", sa.Boolean(), nullable=False),
        sa.Column("user_override", sa.Boolean(), nullable=True),
        sa.Column("recording_id", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["calendar_connections.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["recording_id"],
            ["recordings.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "connection_id",
            "external_event_id",
            name="uq_calendar_synced_events_conn_ext",
        ),
        sa.CheckConstraint(
            "calendar_provider IN ('google', 'microsoft')",
            name="calendar_synced_events_cal_provider",
        ),
        sa.CheckConstraint(
            "meeting_provider IN ('webex', 'google_meet', 'teams')",
            name="calendar_synced_events_mtg_provider",
        ),
    )
    op.create_index(
        "ix_calendar_synced_events_connection_id",
        "calendar_synced_events",
        ["connection_id"],
    )
    op.create_index(
        "ix_calendar_synced_events_owner_sub",
        "calendar_synced_events",
        ["owner_sub"],
    )
    op.create_index(
        "ix_calendar_synced_events_owner_email",
        "calendar_synced_events",
        ["owner_email"],
    )
    op.create_index(
        "ix_calendar_synced_events_starts_at",
        "calendar_synced_events",
        ["starts_at"],
    )


def downgrade():
    op.drop_index("ix_calendar_synced_events_starts_at", table_name="calendar_synced_events")
    op.drop_index("ix_calendar_synced_events_owner_email", table_name="calendar_synced_events")
    op.drop_index("ix_calendar_synced_events_owner_sub", table_name="calendar_synced_events")
    op.drop_index("ix_calendar_synced_events_connection_id", table_name="calendar_synced_events")
    op.drop_table("calendar_synced_events")
    op.drop_index("ix_calendar_connections_owner_email", table_name="calendar_connections")
    op.drop_index("ix_calendar_connections_owner_sub", table_name="calendar_connections")
    op.drop_table("calendar_connections")
