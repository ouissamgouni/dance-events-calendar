"""add_tag_group_scope

Revision ID: a2b3c4d5e6f7
Revises: z1a2b3c4d5e6
Create Date: 2026-05-05

Adds ``tag_groups.scope`` to separate first-class event taxonomy from
review-only aspect tags (Google/Yelp/Airbnb pattern):

- ``scope='event'`` (default) — used for event classification. Visible in
  the explorer filter, event tag pills and the public tag-suggestion form.
- ``scope='review'`` — used inside reviews only. Visible in the
  rate-event modal and the per-event review-list filter chips. Excluded
  from event classification surfaces by the API layer.

Existing ``review-tags`` group is migrated to ``scope='review'``;
everything else stays ``scope='event'``.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, None] = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: the column may already exist if SQLModel.metadata.create_all
    # auto-provisioned it on a fresh deploy that booted before this migration
    # was applied. We inspect the live schema and only add what's missing so
    # `alembic upgrade head` succeeds on partially-migrated databases.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c["name"] for c in inspector.get_columns("tag_groups")}
    if "scope" not in existing_cols:
        op.add_column(
            "tag_groups",
            sa.Column(
                "scope",
                sa.String(),
                nullable=False,
                server_default="event",
            ),
        )

    existing_indexes = {ix["name"] for ix in inspector.get_indexes("tag_groups")}
    if "ix_tag_groups_scope" not in existing_indexes:
        op.create_index(
            "ix_tag_groups_scope", "tag_groups", ["scope"], unique=False
        )

    # Backfill the seeded review-tags group so it is excluded from the
    # event-tag namespace going forward. Safe to re-run.
    op.execute(
        "UPDATE tag_groups SET scope = 'review' WHERE slug = 'review-tags'"
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_indexes = {ix["name"] for ix in inspector.get_indexes("tag_groups")}
    if "ix_tag_groups_scope" in existing_indexes:
        op.drop_index("ix_tag_groups_scope", table_name="tag_groups")
    existing_cols = {c["name"] for c in inspector.get_columns("tag_groups")}
    if "scope" in existing_cols:
        op.drop_column("tag_groups", "scope")
