"""add_event_suggestions_and_links

Revision ID: h1i2j3k4l5m6
Revises: g1h2i3j4k5l6
Create Date: 2026-04-16 14:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "h1i2j3k4l5m6"
down_revision: Union[str, None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add links column to cached_events
    op.add_column(
        "cached_events",
        sa.Column("links", sa.JSON(), nullable=True),
    )

    # Create event_suggestions table
    op.create_table(
        "event_suggestions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("links", sa.JSON(), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column("start", sa.DateTime(), nullable=False),
        sa.Column("end", sa.DateTime(), nullable=False),
        sa.Column("all_day", sa.Boolean(), nullable=False, server_default="false"),
        # Submitter info
        sa.Column("submitter_name", sa.String(), nullable=True),
        sa.Column("submitter_email", sa.String(), nullable=True),
        # Browser metadata
        sa.Column("submitter_ip", sa.String(), nullable=True),
        sa.Column("submitter_user_agent", sa.String(), nullable=True),
        sa.Column("submitter_language", sa.String(), nullable=True),
        sa.Column("submitter_referrer", sa.String(), nullable=True),
        sa.Column("submitter_screen_size", sa.String(), nullable=True),
        sa.Column("submitter_timezone", sa.String(), nullable=True),
        # IP geolocation
        sa.Column("submitter_city", sa.String(), nullable=True),
        sa.Column("submitter_country", sa.String(), nullable=True),
        sa.Column("submitter_lat", sa.Float(), nullable=True),
        sa.Column("submitter_lng", sa.Float(), nullable=True),
        # Workflow
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column("assigned_calendar_id", sa.String(), nullable=True),
        sa.Column("created_event_id", sa.String(), nullable=True),
        sa.Column("synced_to_google", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("google_event_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_suggestions_status", "event_suggestions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_event_suggestions_status", table_name="event_suggestions")
    op.drop_table("event_suggestions")
    op.drop_column("cached_events", "links")
