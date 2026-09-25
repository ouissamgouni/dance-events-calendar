"""add_event_schedules

Revision ID: v1a2b3c4d5e6
Revises: ua1b2c3d4e5f
Create Date: 2026-09-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "v1a2b3c4d5e6"
down_revision: Union[str, None] = "ua1b2c3d4e5f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_schedules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("day_start_hour", sa.Integer(), nullable=False, server_default="6"),
        sa.Column("days", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "day_start_hour >= 0 AND day_start_hour <= 23",
            name="ck_event_schedules_day_start_hour",
        ),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id"),
    )
    op.create_index("ix_event_schedules_event_id", "event_schedules", ["event_id"])

    op.create_table(
        "schedule_venues",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("address", sa.String(length=300), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("schedule_id", "name", name="uq_schedule_venue_name"),
    )
    op.create_index(
        "ix_schedule_venues_schedule_id", "schedule_venues", ["schedule_id"]
    )

    op.create_table(
        "schedule_levels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("notation", sa.String(length=20), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("schedule_id", "label", name="uq_schedule_level_label"),
    )
    op.create_index(
        "ix_schedule_levels_schedule_id", "schedule_levels", ["schedule_id"]
    )

    op.create_table(
        "schedule_activity_types",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("color", sa.String(length=24), nullable=False, server_default="blue"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "schedule_id", "name", name="uq_schedule_activity_type_name"
        ),
    )
    op.create_index(
        "ix_schedule_activity_types_schedule_id",
        "schedule_activity_types",
        ["schedule_id"],
    )

    op.create_table(
        "schedule_rooms",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("venue_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("color", sa.String(length=24), nullable=False, server_default="blue"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.ForeignKeyConstraint(["venue_id"], ["schedule_venues.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("schedule_id", "name", name="uq_schedule_room_name"),
    )
    op.create_index("ix_schedule_rooms_schedule_id", "schedule_rooms", ["schedule_id"])
    op.create_index("ix_schedule_rooms_venue_id", "schedule_rooms", ["venue_id"])

    op.create_table(
        "schedule_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("instructors", sa.String(length=300), nullable=True),
        sa.Column("start", sa.DateTime(), nullable=False),
        sa.Column("end", sa.DateTime(), nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=True),
        sa.Column("venue_id", sa.Integer(), nullable=True),
        sa.Column("level_id", sa.Integer(), nullable=True),
        sa.Column("activity_type_id", sa.Integer(), nullable=True),
        sa.Column("attendee_note", sa.Text(), nullable=True),
        sa.Column("allow_plan", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "is_cancelled", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint('"end" > "start"', name="ck_schedule_sessions_valid_time"),
        sa.ForeignKeyConstraint(["activity_type_id"], ["schedule_activity_types.id"]),
        sa.ForeignKeyConstraint(["level_id"], ["schedule_levels.id"]),
        sa.ForeignKeyConstraint(["room_id"], ["schedule_rooms.id"]),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.ForeignKeyConstraint(["venue_id"], ["schedule_venues.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_schedule_sessions_schedule_start",
        "schedule_sessions",
        ["schedule_id", "start"],
    )
    for column in (
        "schedule_id",
        "room_id",
        "venue_id",
        "level_id",
        "activity_type_id",
        "deleted_at",
    ):
        op.create_index(f"ix_schedule_sessions_{column}", "schedule_sessions", [column])

    op.create_table(
        "schedule_publications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=False),
        sa.Column("published_by_user_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["published_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "schedule_id", "version", name="uq_schedule_publication_version"
        ),
    )
    op.create_index(
        "ix_schedule_publications_schedule_id", "schedule_publications", ["schedule_id"]
    )
    op.create_index(
        "ix_schedule_publications_published_by_user_id",
        "schedule_publications",
        ["published_by_user_id"],
    )

    op.create_table(
        "user_plan_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("last_known_session", sa.JSON(), nullable=False),
        sa.Column("added_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["cached_events.event_id"]),
        sa.ForeignKeyConstraint(["session_id"], ["schedule_sessions.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "session_id", name="uq_user_plan_session"),
    )
    op.create_index("ix_user_plan_sessions_user_id", "user_plan_sessions", ["user_id"])
    op.create_index(
        "ix_user_plan_sessions_session_id", "user_plan_sessions", ["session_id"]
    )
    op.create_index(
        "ix_user_plan_sessions_event_id", "user_plan_sessions", ["event_id"]
    )
    op.create_index(
        "ix_user_plan_sessions_user_event",
        "user_plan_sessions",
        ["user_id", "event_id"],
    )


def downgrade() -> None:
    op.drop_table("user_plan_sessions")
    op.drop_table("schedule_publications")
    op.drop_table("schedule_sessions")
    op.drop_table("schedule_rooms")
    op.drop_table("schedule_activity_types")
    op.drop_table("schedule_levels")
    op.drop_table("schedule_venues")
    op.drop_table("event_schedules")
