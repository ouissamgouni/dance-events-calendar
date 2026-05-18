"""follow_notifications

Revision ID: ab10c3d4e5f7
Revises: ff60a7b8c9d0
Create Date: 2026-05-13

Make ``notifications.event_id`` nullable to support follow/friend
notifications that are not tied to a specific event.

Two new ``kind`` values:
  * ``new_follower``: ``actor_user_id`` started following ``recipient_user_id``.
  * ``new_friend``:   ``actor_user_id`` and ``recipient_user_id`` are now
    mutual friends (produced in pairs, one per participant).

Changes:
  1. Drop ``uq_notification_dedupe`` unique constraint (covered all four
     columns including ``event_id``; fails to enforce uniqueness on NULL
     rows in any DB).
  2. Alter ``event_id`` to allow NULL.
  3. Re-add a *partial* unique index for event-based notifications
     (``event_id IS NOT NULL``) — same semantics as the old constraint
     but scoped to rows that have an event.
  4. Add a *partial* unique index for follow/friend notifications
     (``event_id IS NULL``) on (recipient, kind, actor).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ab10c3d4e5f7"
down_revision: Union[str, None] = "ff60a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_notification_dedupe", "notifications", type_="unique")
    op.alter_column("notifications", "event_id", nullable=True)
    op.create_index(
        "uq_notification_dedupe",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL"),
    )
    op.create_index(
        "uq_notif_no_event",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_notif_no_event", table_name="notifications")
    op.drop_index("uq_notification_dedupe", table_name="notifications")
    op.alter_column("notifications", "event_id", nullable=False)
    op.create_unique_constraint(
        "uq_notification_dedupe",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "event_id"],
    )
