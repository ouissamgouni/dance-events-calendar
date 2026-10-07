"""event_revisions.group_hash: one Review row for a change Google made to every date

Revision ID: gh1a2b3c4d5e
Revises: cr1a2b3c4d5e
Create Date: 2026-10-07
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "gh1a2b3c4d5e"
down_revision: Union[str, None] = "cr1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_revisions",
        sa.Column("group_hash", sa.String(length=64), nullable=True),
    )
    op.create_index("ix_event_revisions_group_hash", "event_revisions", ["group_hash"])


def downgrade() -> None:
    op.drop_index("ix_event_revisions_group_hash", table_name="event_revisions")
    op.drop_column("event_revisions", "group_hash")
