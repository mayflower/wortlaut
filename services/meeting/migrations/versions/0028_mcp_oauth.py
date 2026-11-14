"""Add MCP OAuth 2.1 clients, pending authorizations, and revocable user grants."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mcp_oauth_clients",
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("client_secret_hash", sa.String(length=64), nullable=True),
        sa.Column("client_name", sa.String(length=200), nullable=False),
        sa.Column("client_uri", sa.String(length=512), nullable=True),
        sa.Column(
            "redirect_uris",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("token_endpoint_auth_method", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("client_id"),
    )

    op.create_table(
        "mcp_oauth_authorizations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("redirect_uri", sa.String(length=2048), nullable=False),
        sa.Column("client_state", sa.String(length=512), nullable=True),
        sa.Column("code_challenge", sa.String(length=128), nullable=False),
        sa.Column(
            "requested_scopes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "granted_scopes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("resource", sa.String(length=512), nullable=True),
        sa.Column("upstream_verifier", sa.String(length=128), nullable=True),
        sa.Column("upstream_nonce", sa.String(length=128), nullable=True),
        sa.Column("csrf_token", sa.String(length=128), nullable=False),
        sa.Column("user_sub", sa.String(length=256), nullable=True),
        sa.Column("user_email", sa.String(length=320), nullable=True),
        sa.Column("user_name", sa.String(length=200), nullable=True),
        sa.Column("is_operator", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("code_hash", sa.String(length=64), nullable=True),
        sa.Column("code_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("grant_id", sa.Uuid(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["mcp_oauth_clients.client_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_mcp_oauth_authorizations_code_hash"),
    )
    op.create_index(
        "ix_mcp_oauth_authorizations_client_id",
        "mcp_oauth_authorizations",
        ["client_id"],
    )
    op.create_index(
        "ix_mcp_oauth_authorizations_code_hash",
        "mcp_oauth_authorizations",
        ["code_hash"],
    )
    op.create_index(
        "ix_mcp_oauth_authorizations_expires_at",
        "mcp_oauth_authorizations",
        ["expires_at"],
    )

    op.create_table(
        "mcp_oauth_grants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=False),
        sa.Column("client_name", sa.String(length=200), nullable=False),
        sa.Column("owner_sub", sa.String(length=256), nullable=True),
        sa.Column("owner_email", sa.String(length=320), nullable=True),
        sa.Column("owner_name", sa.String(length=200), nullable=True),
        sa.Column("is_operator", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "scopes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("resource", sa.String(length=512), nullable=True),
        sa.Column("access_token_hash", sa.String(length=64), nullable=False),
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("refresh_token_hash", sa.String(length=64), nullable=False),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["mcp_oauth_clients.client_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("access_token_hash", name="uq_mcp_oauth_grants_access_hash"),
        sa.UniqueConstraint("refresh_token_hash", name="uq_mcp_oauth_grants_refresh_hash"),
    )
    op.create_index("ix_mcp_oauth_grants_client_id", "mcp_oauth_grants", ["client_id"])
    op.create_index("ix_mcp_oauth_grants_owner_sub", "mcp_oauth_grants", ["owner_sub"])
    op.create_index("ix_mcp_oauth_grants_owner_email", "mcp_oauth_grants", ["owner_email"])
    op.create_index(
        "ix_mcp_oauth_grants_access_token_hash",
        "mcp_oauth_grants",
        ["access_token_hash"],
    )
    op.create_index(
        "ix_mcp_oauth_grants_refresh_token_hash",
        "mcp_oauth_grants",
        ["refresh_token_hash"],
    )
    op.create_index(
        "ix_mcp_oauth_grants_refresh_expires_at",
        "mcp_oauth_grants",
        ["refresh_expires_at"],
    )


def downgrade():
    op.drop_table("mcp_oauth_grants")
    op.drop_table("mcp_oauth_authorizations")
    op.drop_table("mcp_oauth_clients")
