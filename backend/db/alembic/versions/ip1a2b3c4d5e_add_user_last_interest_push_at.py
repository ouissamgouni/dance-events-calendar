"""add users.last_interest_push_at and notification open/click stamps

Revision ID: ip1a2b3c4d5e
Revises: br3a4b5c6d7e
Create Date: 2026-10-01
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "ip1a2b3c4d5e"
down_revision: Union[str, None] = "br3a4b5c6d7e"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("users", "last_interest_push_at"),
    ("notifications", "push_opened_at"),
    ("notifications", "email_clicked_at"),
)


def _existing(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table, column in _COLUMNS:
        if column not in _existing(table):
            op.add_column(
                table, sa.Column(column, sa.DateTime(timezone=True), nullable=True)
            )


def downgrade() -> None:
    for table, column in reversed(_COLUMNS):
        if column in _existing(table):
            op.drop_column(table, column)
