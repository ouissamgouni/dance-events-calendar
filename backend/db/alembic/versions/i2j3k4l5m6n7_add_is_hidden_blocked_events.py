"""add_is_hidden_blocked_events

Revision ID: a1b2c3d4e5f6
Revises: z1a2b3c4d5e6
Create Date: 2026-05-11

Adds admin-controlled event suppression:
- ``cached_events.is_hidden`` — admin toggle that hides an event from public
  API without deleting it. Sync workers never touch this field, so it is
  sticky across Google Calendar syncs.
- ``blocked_events`` table — records event IDs that have been permanently
  suppressed. Sync workers skip any incoming event whose event_id exists
  here, preventing a re-blocked event from reappearing after a sync.
"""

from alembic import op
import sqlalchemy as sa

revision = "i2j3k4l5m6n7"
down_revision = "h2b3c4d5e6f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cached_events",
        sa.Column("is_hidden", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.create_index(
        "ix_cached_events_is_hidden", "cached_events", ["is_hidden"], unique=False
    )

    op.create_table(
        "blocked_events",
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column(
            "blocked_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("event_id"),
    )


def downgrade() -> None:
    op.drop_table("blocked_events")
    op.drop_index("ix_cached_events_is_hidden", table_name="cached_events")
    op.drop_column("cached_events", "is_hidden")
