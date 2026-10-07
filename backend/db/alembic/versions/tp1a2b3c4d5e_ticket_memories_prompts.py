"""ticket & memories prompts

Revision ID: tp1a2b3c4d5e
Revises: nd1a2b3c4d5e
Create Date: 2026-10-05

- ``cached_events.advance_ticket_override`` (NULL = derive from reach/duration)
- ``user_event_attendances.ticket_not_needed_at``
- ``users.{email,push}_{ticket,memories}_prompt_enabled``
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "tp1a2b3c4d5e"
down_revision: Union[str, None] = "nd1a2b3c4d5e"
branch_labels = None
depends_on = None

USER_COLS = (
    "email_ticket_prompt_enabled",
    "push_ticket_prompt_enabled",
    "email_memories_prompt_enabled",
    "push_memories_prompt_enabled",
)


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    existing = _columns("users")
    for name in USER_COLS:
        if name not in existing:
            op.add_column(
                "users",
                sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.true()),
            )
    if "advance_ticket_override" not in _columns("cached_events"):
        op.add_column(
            "cached_events",
            sa.Column("advance_ticket_override", sa.Boolean(), nullable=True),
        )
    if "ticket_not_needed_at" not in _columns("user_event_attendances"):
        op.add_column(
            "user_event_attendances",
            sa.Column(
                "ticket_not_needed_at", sa.DateTime(timezone=True), nullable=True
            ),
        )


def downgrade() -> None:
    with op.batch_alter_table("user_event_attendances") as batch:
        batch.drop_column("ticket_not_needed_at")
    with op.batch_alter_table("cached_events") as batch:
        batch.drop_column("advance_ticket_override")
    with op.batch_alter_table("users") as batch:
        for name in USER_COLS:
            batch.drop_column(name)
