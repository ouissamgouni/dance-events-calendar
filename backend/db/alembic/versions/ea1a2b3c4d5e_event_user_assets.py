"""event user assets

Revision ID: ea1a2b3c4d5e
Revises: ev1a2b3c4d5e
Create Date: 2026-10-05

Per-user private tickets (files or links) and memory photos for events.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ea1a2b3c4d5e"
down_revision: Union[str, None] = "ev1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "event_user_assets" in inspector.get_table_names():
        return
    op.create_table(
        "event_user_assets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "event_id",
            sa.String(),
            sa.ForeignKey("cached_events.event_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("object_key", sa.String(length=255), nullable=True),
        sa.Column("url", sa.String(length=1000), nullable=True),
        sa.Column("content_type", sa.String(length=64), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column(
            "visibility",
            sa.String(length=16),
            nullable=False,
            server_default="private",
        ),
        sa.Column("caption", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_event_user_assets_user_id", "event_user_assets", ["user_id"])
    op.create_index("ix_event_user_assets_event_id", "event_user_assets", ["event_id"])
    op.create_index(
        "ix_event_user_assets_user_event",
        "event_user_assets",
        ["user_id", "event_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_event_user_assets_user_event", table_name="event_user_assets")
    op.drop_index("ix_event_user_assets_event_id", table_name="event_user_assets")
    op.drop_index("ix_event_user_assets_user_id", table_name="event_user_assets")
    op.drop_table("event_user_assets")
