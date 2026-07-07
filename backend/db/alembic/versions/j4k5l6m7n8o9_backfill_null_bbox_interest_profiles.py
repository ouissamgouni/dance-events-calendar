"""backfill_null_bbox_interest_profiles

Revision ID: j4k5l6m7n8o9
Revises: i4j5k6l7m8n9
Create Date: 2026-07-06

Corrects ``user_interest_profiles`` rows whose bbox columns
(``min_lat`` / ``min_lng`` / ``max_lat`` / ``max_lng``) are NULL.

Historical bug: ``7c1d9e2a6b4f_add_interest_profiles`` seeded one
profile per existing user by copying ``users.preferred_area_*``. Those
source columns are nullable, so users who never chose an area got a
profile row with all four bbox values NULL. The ``InterestProfileResponse``
Pydantic schema (and the frontend types) require non-null floats, so the
Settings page 500s (``ValidationError: min_lat Input should be a valid
number, input_value=None``) whenever such a user opens Settings.

The follow-up backfill ``f7a8b9c0d1e2`` only targeted users with **zero**
profiles, so it does not repair rows created broken by the initial
backfill. This migration is that safety net.

The defaults mirror ``DEFAULT_AREA_BBOX`` in
``backend/services/user_bootstrap.py`` and
``frontend/src/constants/area.ts`` (Europe & nearby).

Idempotent: only touches rows where ANY of the four bbox columns is
NULL. Safe no-op on prod (which has not yet applied
``7c1d9e2a6b4f``) and on any DB where the columns are already populated.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "j4k5l6m7n8o9"
down_revision: Union[str, None] = "i4j5k6l7m8n9"
branch_labels = None
depends_on = None


DEFAULT_MIN_LAT = 24.0
DEFAULT_MIN_LNG = -18.0
DEFAULT_MAX_LAT = 69.0
DEFAULT_MAX_LNG = 50.0


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "user_interest_profiles" not in set(inspector.get_table_names()):
        # Fresh DB where the profile table hasn't been created yet
        # (e.g. downgraded past 7c1d9e2a6b4f). Nothing to fix.
        return

    op.execute(
        sa.text(
            """
            UPDATE user_interest_profiles
               SET min_lat = COALESCE(min_lat, :min_lat),
                   min_lng = COALESCE(min_lng, :min_lng),
                   max_lat = COALESCE(max_lat, :max_lat),
                   max_lng = COALESCE(max_lng, :max_lng)
             WHERE min_lat IS NULL
                OR min_lng IS NULL
                OR max_lat IS NULL
                OR max_lng IS NULL
            """
        ).bindparams(
            min_lat=DEFAULT_MIN_LAT,
            min_lng=DEFAULT_MIN_LNG,
            max_lat=DEFAULT_MAX_LAT,
            max_lng=DEFAULT_MAX_LNG,
        )
    )


def downgrade() -> None:
    # Cannot distinguish rows we patched from rows the user set to the
    # same bbox intentionally. Safe no-op.
    pass
