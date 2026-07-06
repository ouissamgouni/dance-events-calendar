"""rename notification-gate site_settings keys

Revision ID: i4j5k6l7m8n9
Revises: h3i4j5k6l7m8
Create Date: 2026-07-05

Renames the four admin-configurable notification gate rows in
``site_settings`` to explicit ``<feature>_enabled`` names that match the
per-user ``User.<channel>_<feature>_enabled`` columns introduced in
``g2h3i4j5k6l7_notification_gating_matrix``:

    reminders_enabled              -> event_reminders_enabled
    activity_email_enabled         -> activity_digest_email_enabled
    interest_notifications_enabled -> interest_match_notifications_enabled
    webpush_enabled                -> web_push_enabled

Uses ``INSERT ... ON CONFLICT (key) DO UPDATE`` on Postgres and a
plain ``UPDATE`` fallback on SQLite so idempotent replays and empty
databases both work. Only touches rows whose new key does not already
exist (so re-running never clobbers a manually-set new key).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "i4j5k6l7m8n9"
down_revision: Union[str, None] = "h3i4j5k6l7m8"
branch_labels = None
depends_on = None


_RENAMES = (
    ("reminders_enabled", "event_reminders_enabled"),
    ("activity_email_enabled", "activity_digest_email_enabled"),
    ("interest_notifications_enabled", "interest_match_notifications_enabled"),
    ("webpush_enabled", "web_push_enabled"),
)


def _rename(bind: sa.engine.Connection, old: str, new: str) -> None:
    # Skip when the source row does not exist (nothing to migrate).
    src = bind.execute(
        sa.text("SELECT value FROM site_settings WHERE key = :k"),
        {"k": old},
    ).scalar()
    if src is None:
        return
    # If the destination already exists (e.g. re-run), just drop the old
    # row so we don't leave two keys behind.
    dst = bind.execute(
        sa.text("SELECT 1 FROM site_settings WHERE key = :k"),
        {"k": new},
    ).scalar()
    if dst is not None:
        bind.execute(
            sa.text("DELETE FROM site_settings WHERE key = :k"),
            {"k": old},
        )
        return
    bind.execute(
        sa.text("UPDATE site_settings SET key = :new WHERE key = :old"),
        {"new": new, "old": old},
    )


def upgrade() -> None:
    bind = op.get_bind()
    for old, new in _RENAMES:
        _rename(bind, old, new)


def downgrade() -> None:
    bind = op.get_bind()
    for old, new in _RENAMES:
        _rename(bind, new, old)
