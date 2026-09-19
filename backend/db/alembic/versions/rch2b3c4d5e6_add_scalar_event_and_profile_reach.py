"""add scalar event and profile reach

Revision ID: rch2b3c4d5e6
Revises: sp1a2b3c4d5e
Create Date: 2026-08-24
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "rch2b3c4d5e6"
down_revision: Union[str, None] = "sp1a2b3c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    event_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("cached_events")
    }
    profile_columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("user_interest_profiles")
    }

    with op.batch_alter_table("cached_events") as batch:
        if "reach" not in event_columns:
            batch.add_column(sa.Column("reach", sa.String(length=16), nullable=True))
            batch.create_index("ix_cached_events_reach", ["reach"], unique=False)

    with op.batch_alter_table("user_interest_profiles") as batch:
        if "reach_filter" not in profile_columns:
            batch.add_column(
                sa.Column(
                    "reach_filter",
                    sa.String(length=16),
                    nullable=False,
                    server_default="any",
                )
            )

    conflicts = bind.execute(
        sa.text(
            """
            SELECT et.event_id
            FROM event_tags et
            JOIN tags t ON t.id = et.tag_id
            JOIN tag_groups g ON g.id = t.group_id
            WHERE g.slug = 'reach'
            GROUP BY et.event_id
            HAVING COUNT(DISTINCT t.slug) > 1
            LIMIT 20
            """
        )
    ).fetchall()
    if conflicts:
        event_ids = ", ".join(str(row[0]) for row in conflicts)
        raise RuntimeError(
            "Conflicting reach classifications must be resolved before migration: "
            f"{event_ids}"
        )

    bind.execute(
        sa.text(
            """
            UPDATE cached_events
            SET reach = (
                SELECT t.slug
                FROM event_tags et
                JOIN tags t ON t.id = et.tag_id
                JOIN tag_groups g ON g.id = t.group_id
                WHERE et.event_id = cached_events.event_id
                  AND g.slug = 'reach'
                LIMIT 1
            )
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE tag_groups
            SET label = 'Event reach', allow_multiple = false
            WHERE slug = 'reach'
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE user_interest_profiles
            SET reach_filter = CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM user_interest_profile_tags pit
                    JOIN tags t ON t.id = pit.tag_id
                    JOIN tag_groups g ON g.id = t.group_id
                    WHERE pit.profile_id = user_interest_profiles.id
                      AND g.slug = 'reach'
                      AND t.slug = 'local'
                ) THEN 'any'
                WHEN EXISTS (
                    SELECT 1
                    FROM user_interest_profile_tags pit
                    JOIN tags t ON t.id = pit.tag_id
                    JOIN tag_groups g ON g.id = t.group_id
                    WHERE pit.profile_id = user_interest_profiles.id
                      AND g.slug = 'reach'
                      AND t.slug = 'regional'
                ) THEN 'regional_plus'
                WHEN EXISTS (
                    SELECT 1
                    FROM user_interest_profile_tags pit
                    JOIN tags t ON t.id = pit.tag_id
                    JOIN tag_groups g ON g.id = t.group_id
                    WHERE pit.profile_id = user_interest_profiles.id
                      AND g.slug = 'reach'
                      AND t.slug = 'international'
                ) THEN 'international'
                ELSE 'any'
            END
            """
        )
    )
    with op.batch_alter_table("cached_events") as batch:
        batch.create_check_constraint(
            "ck_cached_events_reach",
            "reach IS NULL OR reach IN ('local', 'regional', 'international')",
        )
    with op.batch_alter_table("user_interest_profiles") as batch:
        batch.create_check_constraint(
            "ck_interest_profiles_reach_filter",
            "reach_filter IN ('any', 'regional_plus', 'international')",
        )


def downgrade() -> None:
    bind = op.get_bind()
    event_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("cached_events")
    }
    profile_columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("user_interest_profiles")
    }
    bind.execute(
        sa.text(
            """
            UPDATE tag_groups
            SET label = 'Reach', allow_multiple = true
            WHERE slug = 'reach'
            """
        )
    )
    with op.batch_alter_table("user_interest_profiles") as batch:
        if "reach_filter" in profile_columns:
            batch.drop_constraint("ck_interest_profiles_reach_filter", type_="check")
            batch.drop_column("reach_filter")
    with op.batch_alter_table("cached_events") as batch:
        if "reach" in event_columns:
            batch.drop_constraint("ck_cached_events_reach", type_="check")
            batch.drop_index("ix_cached_events_reach")
            batch.drop_column("reach")
