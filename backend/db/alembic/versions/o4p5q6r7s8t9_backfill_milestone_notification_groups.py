"""backfill milestone notification groups

Revision ID: o4p5q6r7s8t9
Revises: n3o4p5q6r7s8
Create Date: 2026-09-21
"""

from datetime import timedelta
from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "o4p5q6r7s8t9"
down_revision: Union[str, None] = "n3o4p5q6r7s8"
branch_labels = None
depends_on = None


_BATCH_GAP = timedelta(seconds=5)


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, recipient_user_id, actor_user_id, kind, created_at "
            "FROM notifications "
            "WHERE kind IN ('milestone_unlocked', 'subscription_milestone') "
            "AND group_key IS NULL "
            "ORDER BY recipient_user_id, actor_user_id, kind, created_at, id"
        )
    ).mappings()

    previous_partition = None
    previous_created_at = None
    group_key = None
    for row in rows:
        partition = (
            row["recipient_user_id"],
            row["actor_user_id"],
            row["kind"],
        )
        if (
            partition != previous_partition
            or previous_created_at is None
            or row["created_at"] - previous_created_at > _BATCH_GAP
        ):
            group_key = f"legacy-batch-{row['id']}"

        bind.execute(
            sa.text("UPDATE notifications SET group_key = :group_key WHERE id = :id"),
            {"id": row["id"], "group_key": group_key},
        )
        previous_partition = partition
        previous_created_at = row["created_at"]


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE notifications SET group_key = NULL "
            "WHERE group_key LIKE 'legacy-batch-%'"
        )
    )
