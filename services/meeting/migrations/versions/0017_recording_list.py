"""Page scheduled recordings in chronological order."""

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_recordings_start_id", "recordings", ["starts_at", "id"])


def downgrade():
    op.drop_index("ix_recordings_start_id", table_name="recordings")
