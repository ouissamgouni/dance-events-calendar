"""add_review_prompt_notification_gates

Revision ID: d1e2f3a4b5c6
Revises: c7d8e9f0a1b2
Create Date: 2026-07-22

Adds a new standalone "Review prompt" notification feature bucket (Event
Quality Layer Phase 3):
- ``users.email_review_prompt_enabled``
- ``users.push_review_prompt_enabled``

Gates delivery of the new ``event_review_prompt`` in-app notification
(fired some hours after an event a user RSVP'd Going to has ended, nudging
them to rate their experience). In-app rows always land regardless of
these flags, same convention as the existing event_reminders/
social_activity/interest_matches/promo_codes gates.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, None] = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None

NEW_COLS = (
    "email_review_prompt_enabled",
    "push_review_prompt_enabled",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    for col in NEW_COLS:
        if col not in existing:
            op.add_column(
                "users",
                sa.Column(col, sa.Boolean(), nullable=False, server_default=sa.true()),
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    for col in NEW_COLS:
        if col in existing:
            op.drop_column("users", col)
