"""add_user_dancing_since

Revision ID: l0m1n2o3p4q5
Revises: k9l0m1n2o3p4
Create Date: 2026-08-09

Adds ``users.dancing_since`` (nullable date): the user-chosen date they
started dancing. May predate joining Movida, so it is distinct from
``created_at`` (account) and the earliest attended event. Drives the
"Dancing since" line on the Dance Passport + share card.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "l0m1n2o3p4q5"
down_revision: Union[str, None] = "k9l0m1n2o3p4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "dancing_since" not in existing:
        op.add_column("users", sa.Column("dancing_since", sa.Date(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "dancing_since" in existing:
        op.drop_column("users", "dancing_since")
