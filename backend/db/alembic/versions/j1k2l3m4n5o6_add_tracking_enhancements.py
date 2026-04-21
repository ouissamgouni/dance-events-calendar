"""add_tracking_enhancements

Revision ID: j1k2l3m4n5o6
Revises: i1j2k3l4m5n6
Create Date: 2025-07-01 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "j1k2l3m4n5o6"
down_revision: Union[str, None] = "i1j2k3l4m5n6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add device_id and source to event_views
    op.add_column(
        "event_views",
        sa.Column("device_id", sa.String(), nullable=True),
    )
    op.add_column(
        "event_views",
        sa.Column("source", sa.String(), nullable=True),
    )
    op.create_index("ix_event_views_device_id", "event_views", ["device_id"])

    # Create event_link_clicks table
    op.create_table(
        "event_link_clicks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("device_id", sa.String(), nullable=True),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_link_clicks_event_id", "event_link_clicks", ["event_id"])
    op.create_index(
        "ix_event_link_clicks_device_id", "event_link_clicks", ["device_id"]
    )

    # Create event_exports table
    op.create_table(
        "event_exports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("device_id", sa.String(), nullable=True),
        sa.Column("format", sa.String(), nullable=False),
        sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_exports_device_id", "event_exports", ["device_id"])


def downgrade() -> None:
    op.drop_table("event_exports")
    op.drop_table("event_link_clicks")
    op.drop_index("ix_event_views_device_id", table_name="event_views")
    op.drop_column("event_views", "source")
    op.drop_column("event_views", "device_id")
