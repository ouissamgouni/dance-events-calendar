"""notification delivery mode + source

Revision ID: nd1a2b3c4d5e
Revises: ea1a2b3c4d5e
Create Date: 2026-10-05

Audit which email route (instant / digest) and which sender (request / job /
tick / admin) produced each delivery row.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "nd1a2b3c4d5e"
down_revision: Union[str, None] = "ea1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {
        c["name"]
        for c in sa.inspect(op.get_bind()).get_columns("notification_deliveries")
    }
    with op.batch_alter_table("notification_deliveries") as batch:
        if "mode" not in columns:
            batch.add_column(sa.Column("mode", sa.String(length=16), nullable=True))
        if "source" not in columns:
            batch.add_column(sa.Column("source", sa.String(length=16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("notification_deliveries") as batch:
        batch.drop_column("source")
        batch.drop_column("mode")
