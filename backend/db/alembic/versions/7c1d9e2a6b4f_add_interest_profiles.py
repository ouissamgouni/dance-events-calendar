"""add_interest_profiles

Revision ID: 7c1d9e2a6b4f
Revises: 4f38e516ed38
Create Date: 2026-05-07

Interest Profiles & Interest-Event Notifications PRD:
- ``users``: home_lat/home_lng/home_label + interest_notifications_enabled
  master switch.
- ``tag_groups.protected``: guards the ``reach`` group (and any future
  system-relied-upon group) from admin delete/disable.
- New ``user_interest_profiles`` (geography + notify_enabled) and
  ``user_interest_profile_tags`` (dance-style + reach tag join) tables.

Backfill: one profile per existing user from preferred_area (as an area
bbox) + preferred_tags (dance) + reach=[international, regional],
notify_enabled=true. All backfill statements are guarded with
NOT EXISTS so this migration is safe to re-run.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "7c1d9e2a6b4f"
down_revision: Union[str, None] = "4f38e516ed38"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "home_lat" not in existing_user_cols:
        op.add_column("users", sa.Column("home_lat", sa.Float(), nullable=True))
    if "home_lng" not in existing_user_cols:
        op.add_column("users", sa.Column("home_lng", sa.Float(), nullable=True))
    if "home_label" not in existing_user_cols:
        op.add_column(
            "users", sa.Column("home_label", sa.String(length=120), nullable=True)
        )
    if "interest_notifications_enabled" not in existing_user_cols:
        op.add_column(
            "users",
            sa.Column(
                "interest_notifications_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
        )

    existing_group_cols = {c["name"] for c in inspector.get_columns("tag_groups")}
    if "protected" not in existing_group_cols:
        op.add_column(
            "tag_groups",
            sa.Column(
                "protected",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    existing_tables = set(inspector.get_table_names())
    if "user_interest_profiles" not in existing_tables:
        op.create_table(
            "user_interest_profiles",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id"),
                nullable=False,
                index=True,
            ),
            sa.Column("label", sa.String(length=120), nullable=False),
            sa.Column("geo_kind", sa.String(length=16), nullable=False),
            sa.Column("min_lat", sa.Float(), nullable=True),
            sa.Column("min_lng", sa.Float(), nullable=True),
            sa.Column("max_lat", sa.Float(), nullable=True),
            sa.Column("max_lng", sa.Float(), nullable=True),
            sa.Column("center_lat", sa.Float(), nullable=True),
            sa.Column("center_lng", sa.Float(), nullable=True),
            sa.Column("radius_km", sa.Float(), nullable=True),
            sa.Column(
                "notify_enabled", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )

    existing_tables = set(inspector.get_table_names())
    if "user_interest_profile_tags" not in existing_tables:
        op.create_table(
            "user_interest_profile_tags",
            sa.Column(
                "profile_id",
                sa.Integer(),
                sa.ForeignKey("user_interest_profiles.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "tag_id",
                sa.Integer(),
                sa.ForeignKey("tags.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )

    # Guard the "reach" group from being deleted/disabled via the admin UI,
    # since interest_notification_service depends on it by well-known slug.
    op.execute("UPDATE tag_groups SET protected = true WHERE slug = 'reach'")

    # Backfill: one profile per existing user, seeded from their current
    # preferred_area + preferred_tags, plus reach=[international, regional].
    op.execute(
        """
        INSERT INTO user_interest_profiles
            (user_id, label, geo_kind, min_lat, min_lng, max_lat, max_lng,
             notify_enabled, created_at)
        SELECT u.id, 'My Area', 'area',
               u.preferred_area_min_lat, u.preferred_area_min_lng,
               u.preferred_area_max_lat, u.preferred_area_max_lng,
               true, now()
        FROM users u
        WHERE NOT EXISTS (
            SELECT 1 FROM user_interest_profiles p WHERE p.user_id = u.id
        )
        """
    )
    op.execute(
        """
        INSERT INTO user_interest_profile_tags (profile_id, tag_id, created_at)
        SELECT p.id, upt.tag_id, now()
        FROM user_interest_profiles p
        JOIN user_preferred_tags upt ON upt.user_id = p.user_id
        WHERE NOT EXISTS (
            SELECT 1 FROM user_interest_profile_tags ipt
            WHERE ipt.profile_id = p.id AND ipt.tag_id = upt.tag_id
        )
        """
    )
    op.execute(
        """
        INSERT INTO user_interest_profile_tags (profile_id, tag_id, created_at)
        SELECT p.id, t.id, now()
        FROM user_interest_profiles p
        JOIN tags t ON t.slug IN ('international', 'regional')
        JOIN tag_groups g ON g.id = t.group_id AND g.slug = 'reach'
        WHERE NOT EXISTS (
            SELECT 1 FROM user_interest_profile_tags ipt
            WHERE ipt.profile_id = p.id AND ipt.tag_id = t.id
        )
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "user_interest_profile_tags" in existing_tables:
        op.drop_table("user_interest_profile_tags")
    if "user_interest_profiles" in existing_tables:
        op.drop_table("user_interest_profiles")

    existing_group_cols = {c["name"] for c in inspector.get_columns("tag_groups")}
    if "protected" in existing_group_cols:
        op.drop_column("tag_groups", "protected")

    existing_user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "interest_notifications_enabled" in existing_user_cols:
        op.drop_column("users", "interest_notifications_enabled")
    if "home_label" in existing_user_cols:
        op.drop_column("users", "home_label")
    if "home_lng" in existing_user_cols:
        op.drop_column("users", "home_lng")
    if "home_lat" in existing_user_cols:
        op.drop_column("users", "home_lat")
