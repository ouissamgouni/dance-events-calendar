"""backfill_default_interest_profile

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-07-05

Ensures every existing user owns at least one ``user_interest_profiles``
row. Users created before the unified prefs+profiles design had zero
profiles when they skipped onboarding; the Explorer/For You/alerts
surfaces now read from profiles, so we backfill a permissive default
(matching the frontend's ``DEFAULT_AREA_BBOX``) with
``notify_enabled=False`` so no email fires on migration.

Idempotent: skips users who already own >=1 profile row.
"""

from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, None] = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None


DEFAULT_MIN_LAT = 24.0
DEFAULT_MIN_LNG = -18.0
DEFAULT_MAX_LAT = 69.0
DEFAULT_MAX_LNG = 50.0
DEFAULT_LABEL = "My preferences"


def upgrade() -> None:
    bind = op.get_bind()

    users_without_profile = bind.execute(
        sa.text(
            """
            SELECT u.id
            FROM users u
            LEFT JOIN user_interest_profiles p ON p.user_id = u.id
            WHERE p.id IS NULL
            """
        )
    ).fetchall()

    if not users_without_profile:
        return

    international_row = bind.execute(
        sa.text(
            """
            SELECT t.id
            FROM tags t
            JOIN tag_groups g ON g.id = t.group_id
            WHERE g.slug = 'reach' AND t.slug = 'international' AND t.enabled = TRUE
            LIMIT 1
            """
        )
    ).fetchone()
    international_tag_id = int(international_row[0]) if international_row else None

    for (user_id,) in users_without_profile:
        result = bind.execute(
            sa.text(
                """
                INSERT INTO user_interest_profiles
                    (user_id, label, min_lat, min_lng, max_lat, max_lng,
                     notify_enabled, is_active, created_at)
                VALUES
                    (:user_id, :label, :min_lat, :min_lng, :max_lat, :max_lng,
                     FALSE, TRUE, CURRENT_TIMESTAMP)
                RETURNING id
                """
            ),
            {
                "user_id": user_id,
                "label": DEFAULT_LABEL,
                "min_lat": DEFAULT_MIN_LAT,
                "min_lng": DEFAULT_MIN_LNG,
                "max_lat": DEFAULT_MAX_LAT,
                "max_lng": DEFAULT_MAX_LNG,
            },
        ).fetchone()
        profile_id = int(result[0])

        if international_tag_id is not None:
            bind.execute(
                sa.text(
                    """
                    INSERT INTO user_interest_profile_tags (profile_id, tag_id)
                    VALUES (:profile_id, :tag_id)
                    """
                ),
                {"profile_id": profile_id, "tag_id": international_tag_id},
            )


def downgrade() -> None:
    # Non-reversible: we cannot tell which profiles were seeded by this
    # migration vs. created by the user. Safe no-op.
    pass
