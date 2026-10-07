"""cached_events.status: one lifecycle field (pending/published/hidden/cancelled/removed)

Revision ID: es1a2b3c4d5e
Revises: ec1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "es1a2b3c4d5e"
down_revision: Union[str, None] = "ec1a2b3c4d5e"
branch_labels = None
depends_on = None

_BLOCKED = "event_id IN (SELECT event_id FROM blocked_events)"
_DUPLICATE = (
    "(event_id IN (SELECT event_id FROM blocked_events WHERE reason = 'duplicate')"
    " OR rejected_duplicate_reason IS NOT NULL)"
)


def _suggestion_status(value: str) -> str:
    return (
        f"suggestion_id IN (SELECT id FROM event_suggestions WHERE status = '{value}')"
    )


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
    )
    op.add_column(
        "cached_events", sa.Column("status_reason", sa.String(length=32), nullable=True)
    )
    op.add_column(
        "cached_events",
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_cached_events_status", "cached_events", ["status"])

    # Most specific removal first; is_hidden alone only means an admin hide.
    op.execute(
        f"""
        UPDATE cached_events SET
            status = CASE
                WHEN deleted_at IS NOT NULL THEN 'removed'
                WHEN {_BLOCKED} THEN 'removed'
                WHEN is_hidden AND rejected_duplicate_reason IS NOT NULL THEN 'removed'
                WHEN is_hidden AND suggestion_id IS NOT NULL THEN 'removed'
                WHEN is_hidden THEN 'hidden'
                WHEN is_cancelled THEN 'cancelled'
                WHEN review_status = 'pending' THEN 'pending'
                ELSE 'published'
            END,
            status_reason = CASE
                WHEN deleted_at IS NOT NULL THEN 'google_calendar'
                WHEN {_DUPLICATE} THEN 'duplicate'
                WHEN {_BLOCKED} THEN 'admin'
                WHEN is_hidden AND {_suggestion_status("blocked")} THEN 'admin'
                WHEN is_hidden AND {_suggestion_status("withdrawn")} THEN 'owner'
                WHEN is_hidden AND suggestion_id IS NOT NULL THEN 'series_edit'
                ELSE NULL
            END
        """
    )
    op.execute(
        "UPDATE cached_events SET status_reason = NULL WHERE status <> 'removed'"
    )


def downgrade() -> None:
    op.drop_index("ix_cached_events_status", table_name="cached_events")
    op.drop_column("cached_events", "status_changed_at")
    op.drop_column("cached_events", "status_reason")
    op.drop_column("cached_events", "status")
