"""normalize_interest_profile_geo_to_bbox

Revision ID: e6f7a8b9c0d1
Revises: 9d5e7a3b1f2c
Create Date: 2026-07-04

Collapses the two geo models (``area`` bbox vs ``radius`` circle) into a
single bbox model. For each existing ``radius`` profile, we convert
``(center_lat, center_lng, radius_km)`` into the smallest enclosing
bbox using an equirectangular approximation
(``dlat = radius_km/111``, ``dlng = radius_km/(111*cos(lat))``) so users see
roughly the same coverage after upgrade. Then we drop the now-unused
``geo_kind``, ``center_lat``, ``center_lng`` and ``radius_km`` columns.

Idempotent: guards on column presence let the migration run safely against
databases that were already downgraded/upgraded partially.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, None] = "9d5e7a3b1f2c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}

    # 1. Convert radius rows to bbox in place. Only meaningful if the
    #    legacy columns still exist.
    if {"geo_kind", "center_lat", "center_lng", "radius_km"} <= cols:
        # ``radians`` / ``cos`` aren't available in every SQLite build, so
        # we do the math on the client side and issue per-row updates.
        rows = bind.execute(
            sa.text(
                """
                SELECT id, center_lat, center_lng, radius_km
                  FROM user_interest_profiles
                 WHERE geo_kind = 'radius'
                   AND center_lat IS NOT NULL
                   AND center_lng IS NOT NULL
                   AND radius_km IS NOT NULL
                """
            )
        ).fetchall()
        import math

        for row in rows:
            rid, clat, clng, rkm = row
            dlat = rkm / 111.0
            # Guard against poles (cos ~ 0). Fall back to a full-longitude
            # span; the profile is degenerate anyway.
            cos_lat = math.cos(math.radians(clat))
            dlng = rkm / (111.0 * cos_lat) if abs(cos_lat) > 1e-6 else 180.0
            min_lat = max(-90.0, clat - dlat)
            max_lat = min(90.0, clat + dlat)
            min_lng = max(-180.0, clng - dlng)
            max_lng = min(180.0, clng + dlng)
            bind.execute(
                sa.text(
                    """
                    UPDATE user_interest_profiles
                       SET min_lat = :min_lat,
                           min_lng = :min_lng,
                           max_lat = :max_lat,
                           max_lng = :max_lng
                     WHERE id = :id
                    """
                ),
                {
                    "min_lat": min_lat,
                    "min_lng": min_lng,
                    "max_lat": max_lat,
                    "max_lng": max_lng,
                    "id": rid,
                },
            )

    # 2. Drop the legacy columns. Uses batch mode for SQLite compatibility.
    to_drop = [
        c for c in ("geo_kind", "center_lat", "center_lng", "radius_km") if c in cols
    ]
    if to_drop:
        with op.batch_alter_table("user_interest_profiles") as batch:
            for col in to_drop:
                batch.drop_column(col)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("user_interest_profiles")}

    with op.batch_alter_table("user_interest_profiles") as batch:
        if "geo_kind" not in cols:
            batch.add_column(
                sa.Column(
                    "geo_kind",
                    sa.String(length=16),
                    nullable=False,
                    server_default="area",
                )
            )
        if "center_lat" not in cols:
            batch.add_column(sa.Column("center_lat", sa.Float(), nullable=True))
        if "center_lng" not in cols:
            batch.add_column(sa.Column("center_lng", sa.Float(), nullable=True))
        if "radius_km" not in cols:
            batch.add_column(sa.Column("radius_km", sa.Float(), nullable=True))
