"""unique authenticated attendance

Revision ID: ae80f9a0b1c2
Revises: ad70e8f9a0b1
Create Date: 2026-05-21

"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "ae80f9a0b1c2"
down_revision: Union[str, None] = "ad70e8f9a0b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        WITH scoped AS (
            SELECT
                id,
                first_value(id) OVER (
                    PARTITION BY user_id, event_id
                    ORDER BY
                        CASE WHEN created_by_admin_user_id IS NOT NULL THEN 0 ELSE 1 END,
                        attending_since ASC,
                        id ASC
                ) AS keep_id,
                first_value(share_audience) OVER (
                    PARTITION BY user_id, event_id
                    ORDER BY attending_since DESC, id DESC
                ) AS latest_share_audience,
                first_value(share_publicly) OVER (
                    PARTITION BY user_id, event_id
                    ORDER BY attending_since DESC, id DESC
                ) AS latest_share_publicly,
                count(*) OVER (PARTITION BY user_id, event_id) AS row_count
            FROM user_event_attendances
            WHERE user_id IS NOT NULL
        ), updated AS (
            UPDATE user_event_attendances AS keep
            SET share_audience = scoped.latest_share_audience,
                share_publicly = scoped.latest_share_publicly
            FROM scoped
            WHERE keep.id = scoped.keep_id
              AND scoped.row_count > 1
            RETURNING keep.id
        )
        DELETE FROM user_event_attendances AS dup
        USING scoped
        WHERE dup.id = scoped.id
          AND scoped.row_count > 1
          AND scoped.id <> scoped.keep_id
        """
    )
    op.create_index(
        "ux_user_event_attendances_user_event_authed",
        "user_event_attendances",
        ["user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("user_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ux_user_event_attendances_user_event_authed",
        table_name="user_event_attendances",
    )
