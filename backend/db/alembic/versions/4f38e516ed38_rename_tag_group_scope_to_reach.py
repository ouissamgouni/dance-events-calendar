"""rename_tag_group_scope_to_reach

Revision ID: 4f38e516ed38
Revises: ca7ab554855a
Create Date: 2026-05-06

Renames the tag GROUP whose slug is ``scope`` (values local/regional/
international) to ``reach``, to avoid confusion with the unrelated
``tag_groups.scope`` COLUMN (event/review namespace, see
a2b3c4d5e6f7_add_tag_group_scope.py). Also marks it onboarding-eligible
per the Interest Profiles PRD.

Tag rows (local/regional/international) are keyed by group_id, not group
slug, so this rename does not touch existing EventTag assignments. It
must be a data migration (not just a seed change) because seed.py
upserts tag groups by slug — without this, a fresh seed run would create
a new empty ``reach`` group and orphan the old ``scope`` one.
"""

from typing import Union

from alembic import op

revision: str = "4f38e516ed38"
down_revision: Union[str, None] = "ca7ab554855a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent/re-runnable: only rename if a 'scope' group still exists
    # and no 'reach' group has already been created (e.g. by a fresh seed).
    op.execute(
        """
        UPDATE tag_groups
        SET slug = 'reach', label = 'Reach', onboarding_eligible = true
        WHERE slug = 'scope'
          AND NOT EXISTS (
              SELECT 1 FROM tag_groups AS existing WHERE existing.slug = 'reach'
          )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE tag_groups
        SET slug = 'scope', label = 'Scope', onboarding_eligible = false
        WHERE slug = 'reach'
        """
    )
