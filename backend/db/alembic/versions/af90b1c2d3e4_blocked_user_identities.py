"""blocked user identities

Revision ID: af90b1c2d3e4
Revises: ae80f9a0b1c2
Create Date: 2026-05-21

"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "af90b1c2d3e4"
down_revision: Union[str, None] = "ae80f9a0b1c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "blocked_user_identities",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("provider_subject", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "created_by_admin_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column(
            "revoked_by_admin_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.ForeignKeyConstraint(
            ["created_by_admin_user_id"],
            ["users.id"],
            name="fk_blocked_user_identities_created_by_admin_user_id",
        ),
        sa.ForeignKeyConstraint(
            ["revoked_by_admin_user_id"],
            ["users.id"],
            name="fk_blocked_user_identities_revoked_by_admin_user_id",
        ),
    )
    op.create_index(
        "ix_blocked_user_identities_provider",
        "blocked_user_identities",
        ["provider"],
    )
    op.create_index(
        "ix_blocked_user_identities_provider_subject",
        "blocked_user_identities",
        ["provider_subject"],
    )
    op.create_index(
        "ix_blocked_user_identities_email",
        "blocked_user_identities",
        ["email"],
    )
    op.create_index(
        "ix_blocked_user_identities_created_at",
        "blocked_user_identities",
        ["created_at"],
    )
    op.create_index(
        "ix_blocked_user_identities_created_by_admin_user_id",
        "blocked_user_identities",
        ["created_by_admin_user_id"],
    )
    op.create_index(
        "ix_blocked_user_identities_revoked_at",
        "blocked_user_identities",
        ["revoked_at"],
    )
    op.create_index(
        "ix_blocked_user_identities_revoked_by_admin_user_id",
        "blocked_user_identities",
        ["revoked_by_admin_user_id"],
    )
    op.create_index(
        "ux_blocked_user_identities_active_subject",
        "blocked_user_identities",
        ["provider", "provider_subject"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
        sqlite_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ux_blocked_user_identities_active_subject",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_revoked_by_admin_user_id",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_revoked_at",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_created_by_admin_user_id",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_created_at",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_email", table_name="blocked_user_identities"
    )
    op.drop_index(
        "ix_blocked_user_identities_provider_subject",
        table_name="blocked_user_identities",
    )
    op.drop_index(
        "ix_blocked_user_identities_provider", table_name="blocked_user_identities"
    )
    op.drop_table("blocked_user_identities")
