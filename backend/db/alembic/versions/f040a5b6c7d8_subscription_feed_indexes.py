"""subscription feed indexes

Revision ID: f040a5b6c7d8
Revises: e030f4a5b6c7
Create Date: 2026-05-28
"""

from typing import Union

from alembic import op


revision: str = "f040a5b6c7d8"
down_revision: Union[str, None] = "e030f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_user_saved_events_user_audience_event",
        "user_saved_events",
        ["user_id", "audience", "event_id"],
    )
    op.create_index(
        "ix_user_event_attendances_user_audience_event",
        "user_event_attendances",
        ["user_id", "share_audience", "event_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_event_attendances_user_audience_event",
        table_name="user_event_attendances",
    )
    op.drop_index(
        "ix_user_saved_events_user_audience_event",
        table_name="user_saved_events",
    )
