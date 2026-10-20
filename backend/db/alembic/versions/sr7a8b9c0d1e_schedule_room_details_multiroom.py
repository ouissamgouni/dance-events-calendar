"""schedule room details, session description and multi-room sessions

Revision ID: sr7a8b9c0d1e
Revises: rh1a2b3c4d5e
Create Date: 2026-10-21
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "sr7a8b9c0d1e"
down_revision: Union[str, None] = "rh1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "schedule_rooms", sa.Column("details", sa.String(length=160), nullable=True)
    )
    op.add_column("schedule_sessions", sa.Column("description", sa.Text(), nullable=True))
    op.create_table(
        "schedule_session_rooms",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["room_id"], ["schedule_rooms.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["session_id"], ["schedule_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", "room_id", name="uq_schedule_session_room"),
        sa.UniqueConstraint(
            "session_id", "position", name="uq_schedule_session_room_position"
        ),
    )
    op.create_index(
        "ix_schedule_session_rooms_session_id", "schedule_session_rooms", ["session_id"]
    )
    op.create_index(
        "ix_schedule_session_rooms_room_id", "schedule_session_rooms", ["room_id"]
    )
    op.execute(
        "INSERT INTO schedule_session_rooms (session_id, room_id, position) "
        "SELECT id, room_id, 0 FROM schedule_sessions WHERE room_id IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_index("ix_schedule_session_rooms_room_id", table_name="schedule_session_rooms")
    op.drop_index(
        "ix_schedule_session_rooms_session_id", table_name="schedule_session_rooms"
    )
    op.drop_table("schedule_session_rooms")
    op.drop_column("schedule_sessions", "description")
    op.drop_column("schedule_rooms", "details")
