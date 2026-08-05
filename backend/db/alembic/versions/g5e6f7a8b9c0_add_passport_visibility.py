"""add_passport_visibility

Revision ID: g5e6f7a8b9c0
Revises: f4d5e6a7b8c9
Create Date: 2026-08-06

Dance Passport sharing Phase 2 — profile passport tab + owner-controlled
visibility. Adds to ``users``:
- ``passport_visibility`` (public | friends | private, default friends) —
  who may view the passport on the owner's public profile. Independent from
  ``account_visibility``.
- ``passport_show_badges`` / ``passport_show_cities`` /
  ``passport_show_countries`` / ``passport_show_timeline`` — per-section
  opt-in. Stats are always shown; timeline defaults OFF (most granular /
  location-revealing surface).
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "g5e6f7a8b9c0"
down_revision: Union[str, None] = "f4d5e6a7b8c9"
branch_labels = None
depends_on = None

BOOL_COLS = (
    ("passport_show_badges", sa.true()),
    ("passport_show_cities", sa.true()),
    ("passport_show_countries", sa.true()),
    ("passport_show_timeline", sa.false()),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}

    if "passport_visibility" not in existing:
        op.add_column(
            "users",
            sa.Column(
                "passport_visibility",
                sa.String(length=16),
                nullable=False,
                server_default="friends",
            ),
        )
    for name, default in BOOL_COLS:
        if name not in existing:
            op.add_column(
                "users",
                sa.Column(name, sa.Boolean(), nullable=False, server_default=default),
            )


def downgrade() -> None:
    for name, _ in reversed(BOOL_COLS):
        op.drop_column("users", name)
    op.drop_column("users", "passport_visibility")
