"""schedule overview items (high-level program blocks and moments)

Revision ID: ov7a8b9c0d1e
Revises: sr7a8b9c0d1e
Create Date: 2026-10-21
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ov7a8b9c0d1e"
down_revision: Union[str, None] = "sr7a8b9c0d1e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedule_overview_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("external_id", sa.String(length=120), nullable=True),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("subtitle", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("url_label", sa.String(length=80), nullable=True),
        sa.Column("start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("activity_type_id", sa.Integer(), nullable=True),
        sa.Column("venue_id", sa.Integer(), nullable=True),
        sa.Column(
            "opens_detail", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column(
            "is_cancelled", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            '"end" > "start"', name="ck_schedule_overview_items_valid_time"
        ),
        sa.ForeignKeyConstraint(["schedule_id"], ["event_schedules.id"]),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["schedule_overview_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["activity_type_id"], ["schedule_activity_types.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["venue_id"], ["schedule_venues.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "schedule_id", "external_id", name="uq_schedule_overview_item_external_id"
        ),
    )
    for column in (
        "external_id",
        "schedule_id",
        "parent_id",
        "activity_type_id",
        "venue_id",
    ):
        op.create_index(
            f"ix_schedule_overview_items_{column}", "schedule_overview_items", [column]
        )
    op.create_index(
        "ix_schedule_overview_items_schedule_start",
        "schedule_overview_items",
        ["schedule_id", "start"],
    )
    op.create_table(
        "schedule_overview_item_rooms",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("room_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(
            ["item_id"], ["schedule_overview_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["room_id"], ["schedule_rooms.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "item_id", "room_id", name="uq_schedule_overview_item_room"
        ),
        sa.UniqueConstraint(
            "item_id", "position", name="uq_schedule_overview_item_room_position"
        ),
    )
    op.create_index(
        "ix_schedule_overview_item_rooms_item_id",
        "schedule_overview_item_rooms",
        ["item_id"],
    )
    op.create_index(
        "ix_schedule_overview_item_rooms_room_id",
        "schedule_overview_item_rooms",
        ["room_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_schedule_overview_item_rooms_room_id",
        table_name="schedule_overview_item_rooms",
    )
    op.drop_index(
        "ix_schedule_overview_item_rooms_item_id",
        table_name="schedule_overview_item_rooms",
    )
    op.drop_table("schedule_overview_item_rooms")
    op.drop_index(
        "ix_schedule_overview_items_schedule_start",
        table_name="schedule_overview_items",
    )
    for column in (
        "external_id",
        "schedule_id",
        "parent_id",
        "activity_type_id",
        "venue_id",
    ):
        op.drop_index(
            f"ix_schedule_overview_items_{column}", table_name="schedule_overview_items"
        )
    op.drop_table("schedule_overview_items")
