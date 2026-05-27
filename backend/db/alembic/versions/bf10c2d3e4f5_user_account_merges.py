"""user account merge audit

Revision ID: bf10c2d3e4f5
Revises: af90b1c2d3e4
Create Date: 2026-05-27

"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "bf10c2d3e4f5"
down_revision: Union[str, None] = "af90b1c2d3e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_account_merges",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("source_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("destination_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_by_admin_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["source_user_id"],
            ["users.id"],
            name="fk_user_account_merges_source_user_id",
        ),
        sa.ForeignKeyConstraint(
            ["destination_user_id"],
            ["users.id"],
            name="fk_user_account_merges_destination_user_id",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_admin_user_id"],
            ["users.id"],
            name="fk_user_account_merges_created_by_admin_user_id",
        ),
    )
    op.create_index(
        "ix_user_account_merges_source_user_id",
        "user_account_merges",
        ["source_user_id"],
    )
    op.create_index(
        "ix_user_account_merges_destination_user_id",
        "user_account_merges",
        ["destination_user_id"],
    )
    op.create_index(
        "ix_user_account_merges_created_by_admin_user_id",
        "user_account_merges",
        ["created_by_admin_user_id"],
    )
    op.create_index(
        "ix_user_account_merges_created_at", "user_account_merges", ["created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_user_account_merges_created_at", table_name="user_account_merges")
    op.drop_index(
        "ix_user_account_merges_created_by_admin_user_id",
        table_name="user_account_merges",
    )
    op.drop_index(
        "ix_user_account_merges_destination_user_id", table_name="user_account_merges"
    )
    op.drop_index(
        "ix_user_account_merges_source_user_id", table_name="user_account_merges"
    )
    op.drop_table("user_account_merges")
