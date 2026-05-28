"""add explorer performance indexes

Revision ID: e030f4a5b6c7
Revises: d020e3f4a5b6
Create Date: 2026-05-28
"""

from typing import Union

from alembic import op


revision: str = "e030f4a5b6c7"
down_revision: Union[str, None] = "d020e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_cached_events_explorer_window",
        "cached_events",
        ["calendar_id", "deleted_at", "is_hidden", "end", "start"],
    )
    op.create_index(
        "ix_event_tags_tag_event",
        "event_tags",
        ["tag_id", "event_id"],
    )
    op.create_index(
        "ix_event_views_event_created_at",
        "event_views",
        ["event_id", "created_at"],
    )
    op.create_index(
        "ix_user_saved_events_event_saved_at",
        "user_saved_events",
        ["event_id", "saved_at"],
    )
    op.create_index(
        "ix_user_event_attendances_event_attending_since",
        "user_event_attendances",
        ["event_id", "attending_since"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_event_attendances_event_attending_since",
        table_name="user_event_attendances",
    )
    op.drop_index(
        "ix_user_saved_events_event_saved_at",
        table_name="user_saved_events",
    )
    op.drop_index("ix_event_views_event_created_at", table_name="event_views")
    op.drop_index("ix_event_tags_tag_event", table_name="event_tags")
    op.drop_index("ix_cached_events_explorer_window", table_name="cached_events")
