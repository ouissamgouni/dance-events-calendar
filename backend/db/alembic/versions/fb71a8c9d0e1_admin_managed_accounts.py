"""admin-managed accounts + audit columns for curation

Revision ID: fb71a8c9d0e1
Revises: ea50b6c7d8e9
Create Date: 2026-05-19

Phase 0 of admin-curated Going/Saved:

- ``users.is_admin_managed`` — boolean flag marking a user account as
  operated by site admins. Only managed accounts (plus the admin
  themselves) may be targeted by the bulk-curation routes.
- ``users.managed_label`` — admin-only nickname shown in the Admin
  Users tab (e.g. "Salsa Nights Paris curator"). Pure UI hint, not
  exposed publicly.
- ``user_saved_events.created_by_admin_user_id`` and
  ``user_event_attendances.created_by_admin_user_id`` — nullable
  FK to ``users.id``. When non-NULL, the row was created by the
  admin acting on behalf of the target user; surfaced as a
  "Curated" pill on the target's profile lists.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "fb71a8c9d0e1"
down_revision: Union[str, None] = "ea50b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_admin_managed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column("managed_label", sa.String(length=120), nullable=True),
    )
    op.create_index(
        "ix_users_is_admin_managed",
        "users",
        ["is_admin_managed"],
    )

    for table in ("user_saved_events", "user_event_attendances"):
        op.add_column(
            table,
            sa.Column(
                "created_by_admin_user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id"),
                nullable=True,
            ),
        )
        op.create_index(
            f"ix_{table}_created_by_admin_user_id",
            table,
            ["created_by_admin_user_id"],
        )


def downgrade() -> None:
    for table in ("user_event_attendances", "user_saved_events"):
        op.drop_index(f"ix_{table}_created_by_admin_user_id", table_name=table)
        op.drop_column(table, "created_by_admin_user_id")
    op.drop_index("ix_users_is_admin_managed", table_name="users")
    op.drop_column("users", "managed_label")
    op.drop_column("users", "is_admin_managed")
