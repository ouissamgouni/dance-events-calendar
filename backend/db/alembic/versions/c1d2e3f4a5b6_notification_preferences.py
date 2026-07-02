"""notification preferences + email digest tracking

Revision ID: c1d2e3f4a5b6
Revises: f040a5b6c7d8
Create Date: 2026-06-20

Adds the re-engagement foundation:

* ``users.timezone`` — IANA tz used to format reminder/digest email times.
* ``users.reminder_email_enabled`` — transactional event-reminder emails.
* ``users.activity_email_enabled`` — batched friend/event activity digests.
* ``users.push_enabled`` — web-push delivery toggle.
* ``notifications.emailed_at`` — idempotency stamp for the activity digest
  worker so a notification is emailed at most once.

All new columns are non-null with sensible defaults (reminders/activity/push
opt-in by default, tz=UTC) so existing rows backfill without a data migration.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, None] = "f040a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "timezone",
            sa.String(length=64),
            nullable=False,
            server_default="UTC",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "reminder_email_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "activity_email_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "push_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "notifications",
        sa.Column("emailed_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_notifications_emailed_at",
        "notifications",
        ["emailed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_emailed_at", table_name="notifications")
    op.drop_column("notifications", "emailed_at")
    op.drop_column("users", "push_enabled")
    op.drop_column("users", "activity_email_enabled")
    op.drop_column("users", "reminder_email_enabled")
    op.drop_column("users", "timezone")
