"""add user_event_mutes (per-event message notification opt-out)

Revision ID: evm1a2b3c4d5
Revises: bd007debc419
Create Date: 2026-08-12

Adds the ``user_event_mutes`` table: one row means the user receives no
``event_message`` / ``event_message_reply`` notifications for that event on any
channel (an additional per-event opt-out on top of the global feature toggles).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "evm1a2b3c4d5"
down_revision: Union[str, None] = "bd007debc419"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_event_mutes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_event_mutes_user_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["cached_events.event_id"],
            name="fk_user_event_mutes_event_id",
        ),
        sa.UniqueConstraint("user_id", "event_id", name="uq_user_event_mute"),
    )
    op.create_index("ix_user_event_mutes_user_id", "user_event_mutes", ["user_id"])
    op.create_index("ix_user_event_mutes_event_id", "user_event_mutes", ["event_id"])


def downgrade() -> None:
    op.drop_index("ix_user_event_mutes_event_id", table_name="user_event_mutes")
    op.drop_index("ix_user_event_mutes_user_id", table_name="user_event_mutes")
    op.drop_table("user_event_mutes")
