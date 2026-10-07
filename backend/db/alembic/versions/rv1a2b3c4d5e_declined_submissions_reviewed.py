"""mark events of declined submissions as reviewed

Revision ID: rv1a2b3c4d5e
Revises: sf1a2b3c4d5e
Create Date: 2026-10-06
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "rv1a2b3c4d5e"
down_revision: Union[str, None] = "sf1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE cached_events SET review_status = 'reviewed' "
            "WHERE review_status = 'pending' AND suggestion_id IN "
            "(SELECT id FROM event_suggestions WHERE status = 'declined')"
        )
    )


def downgrade() -> None:
    pass
