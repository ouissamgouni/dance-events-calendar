"""link legacy device-only share tokens to their owner account

Share links now require sign-in; tokens minted anonymously while the user
was actually signed in (missing credentials bug) are linked to the account
recorded on that device's saved/going rows. One token per user (newest wins).

Revision ID: st1a2b3c4d5e
Revises: ip1a2b3c4d5e
Create Date: 2026-10-02
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "st1a2b3c4d5e"
down_revision: Union[str, None] = "ip1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE share_tokens st
            SET user_id = picked.user_id
            FROM (
                SELECT DISTINCT ON (owners.user_id) t.id AS token_id, owners.user_id
                FROM share_tokens t
                JOIN (
                    SELECT device_id, user_id FROM user_event_attendances
                    WHERE user_id IS NOT NULL
                    UNION
                    SELECT device_id, user_id FROM user_saved_events
                    WHERE user_id IS NOT NULL
                ) owners ON owners.device_id = t.device_id
                WHERE t.user_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM share_tokens x WHERE x.user_id = owners.user_id
                  )
                ORDER BY owners.user_id, t.created_at DESC
            ) picked
            WHERE st.id = picked.token_id
            """
        )
    )


def downgrade() -> None:
    pass
