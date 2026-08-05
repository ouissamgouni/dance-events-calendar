"""add_milestone_notification_gates

Revision ID: e3c4d5e6f7a8
Revises: d2b3c4d5e6f7
Create Date: 2026-08-12

Dance Passport Phase C — milestone-unlock notifications:
- ``users.email_milestone_unlocked_enabled`` / ``push_milestone_unlocked_enabled``
  gate email/push delivery of the new ``milestone_unlocked`` notification
  (in-app rows always land, same convention as the other gates).
- ``notifications.subject_key`` stores the milestone key so distinct
  milestones for the same recipient don't collide on the dedupe indexes.

Dedupe indexes: milestone notifications carry ``event_id IS NULL`` and so are
governed by the ``uq_notif_no_event`` partial unique index on
``(recipient, kind, actor)`` (added in ``ab10c3d4e5f7``). Since all of a
user's milestones share ``actor = recipient`` and ``kind =
'milestone_unlocked'``, that index would reject the second milestone. To fix
this without weakening dedupe for the existing null-event kinds
(new_follower / new_friend / follow_request, which have ``subject_key IS
NULL``):
  * ``uq_notif_no_event`` is re-scoped to ``event_id IS NULL AND subject_key
    IS NULL`` (unchanged behaviour for the follow/friend kinds).
  * a new ``uq_notif_subject`` partial index enforces uniqueness on
    ``(recipient, kind, actor, subject_key)`` for ``event_id IS NULL AND
    subject_key IS NOT NULL`` (one notification per user per milestone).
The event-based ``uq_notification_dedupe`` partial index is untouched.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3c4d5e6f7a8"
down_revision: Union[str, None] = "d2b3c4d5e6f7"
branch_labels = None
depends_on = None

USER_COLS = (
    "email_milestone_unlocked_enabled",
    "push_milestone_unlocked_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    for col in USER_COLS:
        if col not in existing_user_cols:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )

    notif_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "subject_key" not in notif_cols:
        op.add_column(
            "notifications",
            sa.Column("subject_key", sa.String(length=64), nullable=True),
        )
        op.create_index(
            "ix_notifications_subject_key", "notifications", ["subject_key"]
        )

    existing_indexes = {ix["name"] for ix in inspector.get_indexes("notifications")}

    # Re-scope the null-event dedupe index so it no longer covers milestone
    # rows (subject_key IS NOT NULL); the follow/friend kinds (subject_key
    # NULL) keep their exact previous uniqueness semantics.
    if "uq_notif_no_event" in existing_indexes:
        op.drop_index("uq_notif_no_event", table_name="notifications")
    op.create_index(
        "uq_notif_no_event",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL AND subject_key IS NULL"),
    )
    # Per-milestone dedupe (one notification per user per milestone key).
    op.create_index(
        "uq_notif_subject",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id", "subject_key"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL AND subject_key IS NOT NULL"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_indexes = {ix["name"] for ix in inspector.get_indexes("notifications")}
    if "uq_notif_subject" in existing_indexes:
        op.drop_index("uq_notif_subject", table_name="notifications")
    if "uq_notif_no_event" in existing_indexes:
        op.drop_index("uq_notif_no_event", table_name="notifications")
    op.create_index(
        "uq_notif_no_event",
        "notifications",
        ["recipient_user_id", "kind", "actor_user_id"],
        unique=True,
        postgresql_where=sa.text("event_id IS NULL"),
    )

    notif_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "subject_key" in notif_cols:
        op.drop_index("ix_notifications_subject_key", table_name="notifications")
        op.drop_column("notifications", "subject_key")

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    for col in USER_COLS:
        if col in existing_user_cols:
            op.drop_column("users", col)
