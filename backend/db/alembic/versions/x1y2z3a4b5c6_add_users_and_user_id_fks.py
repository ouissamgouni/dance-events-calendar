"""add users table and user_id FKs on saved/attending/share

Revision ID: x1y2z3a4b5c6
Revises: w1x2y3z4a5b6
Create Date: 2026-05-05

Introduces end-user accounts (Google Sign-In) so that bookmarked events,
attendance state, and the share-my-calendar token can follow a user across
devices. The admin role remains gated by ADMIN_EMAIL (no schema change).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "x1y2z3a4b5c6"
down_revision: Union[str, None] = "w1x2y3z4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=True),
        sa.Column("avatar_url", sa.String(length=512), nullable=True),
        sa.Column(
            "provider", sa.String(length=32), nullable=False, server_default="google"
        ),
        sa.Column("provider_subject", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("provider_subject", name="uq_users_provider_subject"),
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_provider_subject", "users", ["provider_subject"])
    op.create_index("ix_users_deleted_at", "users", ["deleted_at"])

    op.add_column(
        "user_saved_events",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_user_saved_events_user_id",
        "user_saved_events",
        "users",
        ["user_id"],
        ["id"],
    )
    op.create_index(
        "ix_user_saved_events_user_id", "user_saved_events", ["user_id"]
    )

    op.add_column(
        "user_event_attendances",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_user_event_attendances_user_id",
        "user_event_attendances",
        "users",
        ["user_id"],
        ["id"],
    )
    op.create_index(
        "ix_user_event_attendances_user_id", "user_event_attendances", ["user_id"]
    )

    op.add_column(
        "share_tokens",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_share_tokens_user_id",
        "share_tokens",
        "users",
        ["user_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uq_share_tokens_user_id", "share_tokens", ["user_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_share_tokens_user_id", "share_tokens", type_="unique")
    op.drop_constraint("fk_share_tokens_user_id", "share_tokens", type_="foreignkey")
    op.drop_column("share_tokens", "user_id")

    op.drop_index(
        "ix_user_event_attendances_user_id", table_name="user_event_attendances"
    )
    op.drop_constraint(
        "fk_user_event_attendances_user_id",
        "user_event_attendances",
        type_="foreignkey",
    )
    op.drop_column("user_event_attendances", "user_id")

    op.drop_index("ix_user_saved_events_user_id", table_name="user_saved_events")
    op.drop_constraint(
        "fk_user_saved_events_user_id", "user_saved_events", type_="foreignkey"
    )
    op.drop_column("user_saved_events", "user_id")

    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_index("ix_users_provider_subject", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
