"""make price_is_free nullable (tri-state: free / paid / unknown)

Revision ID: pz1a2b3c4d5e
Revises: fgc1a2b3c4d5
Create Date: 2026-08-25
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "pz1a2b3c4d5e"
down_revision: Union[str, None] = "fgc1a2b3c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("cached_events", "event_suggestions"):
        with op.batch_alter_table(table) as batch:
            batch.alter_column(
                "price_is_free",
                existing_type=sa.Boolean(),
                nullable=True,
                server_default=None,
            )
        # Rows that were never priced (default False + no price_min) become
        # "unknown" (NULL) so cards stop implying a known price.
        op.execute(
            f"UPDATE {table} SET price_is_free = NULL "
            "WHERE price_is_free = false AND price_min IS NULL"
        )


def downgrade() -> None:
    for table in ("cached_events", "event_suggestions"):
        op.execute(f"UPDATE {table} SET price_is_free = false WHERE price_is_free IS NULL")
        with op.batch_alter_table(table) as batch:
            batch.alter_column(
                "price_is_free",
                existing_type=sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
