"""restore profile radius geography

Revision ID: sp1a2b3c4d5e
Revises: rvsz1a2b3c4d
Create Date: 2026-08-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "sp1a2b3c4d5e"
down_revision: Union[str, None] = "rvsz1a2b3c4d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("user_interest_profiles")
    }
    with op.batch_alter_table("user_interest_profiles") as batch:
        if "geo_kind" not in columns:
            batch.add_column(
                sa.Column(
                    "geo_kind",
                    sa.String(length=16),
                    nullable=False,
                    server_default="area",
                )
            )
        if "center_lat" not in columns:
            batch.add_column(sa.Column("center_lat", sa.Float(), nullable=True))
        if "center_lng" not in columns:
            batch.add_column(sa.Column("center_lng", sa.Float(), nullable=True))
        if "radius_km" not in columns:
            batch.add_column(sa.Column("radius_km", sa.Float(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("user_interest_profiles")
    }
    with op.batch_alter_table("user_interest_profiles") as batch:
        for name in ("radius_km", "center_lng", "center_lat", "geo_kind"):
            if name in columns:
                batch.drop_column(name)
