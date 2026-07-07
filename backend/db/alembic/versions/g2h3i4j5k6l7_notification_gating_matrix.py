"""notification gating matrix (Phase G)

Revision ID: g2h3i4j5k6l7
Revises: f7a8b9c0d1e2
Create Date: 2026-07-05

Refactor per-user notification gating from four flat booleans to a
six-cell (feature × channel) matrix and rename per-profile ``notify_enabled``
→ ``matches_enabled``.

Before:
- users.reminder_email_enabled         (email channel × reminders)
- users.activity_email_enabled         (email channel × social + interest)
- users.push_enabled                   (push channel × everything)
- users.interest_notifications_enabled (row-creation gate for matcher)

After (rows always land in-app; these gate delivery only):
- users.email_event_reminders_enabled
- users.email_social_activity_enabled
- users.email_interest_matches_enabled
- users.push_event_reminders_enabled
- users.push_social_activity_enabled
- users.push_interest_matches_enabled

Backfill preserves user intent conservatively (AND-combine on splits).
See docs/PHASE_G_NOTIFICATION_GATING.md §G.5.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "g2h3i4j5k6l7"
down_revision: Union[str, None] = "f7a8b9c0d1e2"
branch_labels = None
depends_on = None


NEW_COLS = (
    "email_event_reminders_enabled",
    "email_social_activity_enabled",
    "email_interest_matches_enabled",
    "push_event_reminders_enabled",
    "push_social_activity_enabled",
    "push_interest_matches_enabled",
)

LEGACY_COLS = (
    "reminder_email_enabled",
    "activity_email_enabled",
    "push_enabled",
    "interest_notifications_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    for col in NEW_COLS:
        if col not in existing:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )

    # Backfill from the legacy flags. AND-combine on splits so nobody who
    # was opted-out silently starts receiving email/push.
    if all(c in existing for c in LEGACY_COLS):
        op.execute(
            """
            UPDATE users SET
              email_event_reminders_enabled = reminder_email_enabled,
              email_social_activity_enabled = activity_email_enabled,
              email_interest_matches_enabled = (
                activity_email_enabled AND interest_notifications_enabled
              ),
              push_event_reminders_enabled = push_enabled,
              push_social_activity_enabled = push_enabled,
              push_interest_matches_enabled = (
                push_enabled AND interest_notifications_enabled
              )
            """
        )

    # Rename per-profile flag.
    profile_cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}
    if "notify_enabled" in profile_cols and "matches_enabled" not in profile_cols:
        with op.batch_alter_table("user_interest_profiles") as batch:
            batch.alter_column("notify_enabled", new_column_name="matches_enabled")

    # Drop the four legacy user columns.
    for col in LEGACY_COLS:
        if col in existing:
            op.drop_column("users", col)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    # Re-add legacy columns.
    for col in LEGACY_COLS:
        if col not in existing:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )

    # Best-effort reverse backfill (lossy — the split cannot be perfectly
    # inverted). See G.5.
    if all(c in NEW_COLS for c in NEW_COLS):
        op.execute(
            """
            UPDATE users SET
              reminder_email_enabled = email_event_reminders_enabled,
              activity_email_enabled = (
                email_social_activity_enabled OR email_interest_matches_enabled
              ),
              push_enabled = (
                push_event_reminders_enabled
                OR push_social_activity_enabled
                OR push_interest_matches_enabled
              ),
              interest_notifications_enabled = (
                email_interest_matches_enabled OR push_interest_matches_enabled
              )
            """
        )

    # Reverse the per-profile rename.
    profile_cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}
    if "matches_enabled" in profile_cols and "notify_enabled" not in profile_cols:
        with op.batch_alter_table("user_interest_profiles") as batch:
            batch.alter_column("matches_enabled", new_column_name="notify_enabled")

    # Drop the six new columns.
    existing = {c["name"] for c in inspector.get_columns("users")}
    for col in NEW_COLS:
        if col in existing:
            op.drop_column("users", col)
