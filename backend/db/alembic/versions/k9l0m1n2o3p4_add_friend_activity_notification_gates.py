"""add_friend_activity_notification_gates

Revision ID: k9l0m1n2o3p4
Revises: j8h9c0d1e2f3
Create Date: 2026-08-08

Friend-activity notification split + new fan-out kinds:
- Splits ``subscription_going`` out of the broad ``social_activity`` bucket
  into its own per-feature gates (``users.{email,push}_friends_going_enabled``),
  backfilled from the existing social-activity values so users who had
  social-activity email/push off keep friend-going off too.
- Adds gates for two new follower-facing kinds: ``subscription_review``
  (``{email,push}_friend_reviews_enabled``) and ``subscription_milestone``
  (``{email,push}_friend_milestones_enabled``).
- Adds ``notifications.instant_emailed_at`` (paired with ``emailed_at``) so a
  feature configured for BOTH instant + digest email tracks each path
  independently.

No new dedupe indexes are needed: ``subscription_review`` rows carry an
``event_id`` (covered by ``uq_notification_dedupe``) and
``subscription_milestone`` rows carry ``subject_key`` with a null event
(covered by ``uq_notif_subject``).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "k9l0m1n2o3p4"
down_revision: Union[str, None] = "j8h9c0d1e2f3"
branch_labels = None
depends_on = None

# New per-feature gates, defaulting on like every other notification gate.
NEW_USER_COLS = (
    "email_friends_going_enabled",
    "push_friends_going_enabled",
    "email_friend_reviews_enabled",
    "push_friend_reviews_enabled",
    "email_friend_milestones_enabled",
    "push_friend_milestones_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    added_going = False
    for col in NEW_USER_COLS:
        if col not in existing_user_cols:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )
            if col in ("email_friends_going_enabled", "push_friends_going_enabled"):
                added_going = True

    # Preserve intent: "going" used to live inside social_activity, so a user
    # who had social email/push disabled should keep friend-going disabled.
    # Only backfill on the run that actually created the columns.
    if added_going:
        op.execute(
            "UPDATE users SET "
            "email_friends_going_enabled = email_social_activity_enabled, "
            "push_friends_going_enabled = push_social_activity_enabled"
        )

    notif_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "instant_emailed_at" not in notif_cols:
        op.add_column(
            "notifications",
            sa.Column("instant_emailed_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_notifications_instant_emailed_at",
            "notifications",
            ["instant_emailed_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    notif_indexes = {ix["name"] for ix in inspector.get_indexes("notifications")}
    if "ix_notifications_instant_emailed_at" in notif_indexes:
        op.drop_index("ix_notifications_instant_emailed_at", table_name="notifications")
    notif_cols = {c["name"] for c in inspector.get_columns("notifications")}
    if "instant_emailed_at" in notif_cols:
        op.drop_column("notifications", "instant_emailed_at")

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    for col in reversed(NEW_USER_COLS):
        if col in existing_user_cols:
            op.drop_column("users", col)
