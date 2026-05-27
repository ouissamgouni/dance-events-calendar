"""backfill subscriptions for follows

Revision ID: c020d3e4f5a6
Revises: bf10c2d3e4f5
Create Date: 2026-05-27

"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "c020d3e4f5a6"
down_revision: Union[str, None] = "bf10c2d3e4f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            INSERT INTO calendar_subscriptions (
                subscriber_id,
                target_user_id,
                notify_new_events,
                created_at
            )
            SELECT
                f.follower_id,
                f.followee_id,
                TRUE,
                CURRENT_TIMESTAMP
            FROM user_follows f
            JOIN users follower ON follower.id = f.follower_id
            JOIN users followee ON followee.id = f.followee_id
            WHERE f.status = 'approved'
              AND f.follower_id != f.followee_id
              AND follower.deleted_at IS NULL
              AND followee.deleted_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM calendar_subscriptions s
                  WHERE s.subscriber_id = f.follower_id
                    AND s.target_user_id = f.followee_id
              )
            """
        )
    )


def downgrade() -> None:
    pass
