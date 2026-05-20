"""add organizer_claims + cached_events.organizer_user_id

Revision ID: da41b2c3d4e5
Revises: cf30a1b2c3d4
Create Date: 2026-05-20

User-submitted organizer claims. Sign-in required; admin-moderated.
A claim combines the account-level verified-organizer badge with a
list of per-event organizer attributions. Admins decide each event
independently; on approval, ``cached_events.organizer_user_id`` is set
to the claim's submitter.

Indexes:
- ix_organizer_claims_user_id — list-my-claims and dedup checks.
- ix_organizer_claims_status — admin queue paging by status.
- ix_organizer_claim_events_claim_id / event_id — join paths.
- ix_cached_events_organizer_user_id — reverse lookup for the public
  profile's "events I organize" list.
"""

from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "da41b2c3d4e5"
down_revision: Union[str, None] = "cf30a1b2c3d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "organizer_claims",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "grant_badge",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("admin_notes", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_organizer_claims_user_id", "organizer_claims", ["user_id"])
    op.create_index("ix_organizer_claims_status", "organizer_claims", ["status"])

    op.create_table(
        "organizer_claim_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("claim_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column(
            "decision",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"], ["organizer_claims.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["cached_events.event_id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint("claim_id", "event_id", name="uq_organizer_claim_event"),
    )
    op.create_index(
        "ix_organizer_claim_events_claim_id",
        "organizer_claim_events",
        ["claim_id"],
    )
    op.create_index(
        "ix_organizer_claim_events_event_id",
        "organizer_claim_events",
        ["event_id"],
    )

    op.add_column(
        "cached_events",
        sa.Column("organizer_user_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_cached_events_organizer_user_id",
        "cached_events",
        "users",
        ["organizer_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_cached_events_organizer_user_id",
        "cached_events",
        ["organizer_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_cached_events_organizer_user_id", table_name="cached_events")
    op.drop_constraint(
        "fk_cached_events_organizer_user_id",
        "cached_events",
        type_="foreignkey",
    )
    op.drop_column("cached_events", "organizer_user_id")

    op.drop_index(
        "ix_organizer_claim_events_event_id",
        table_name="organizer_claim_events",
    )
    op.drop_index(
        "ix_organizer_claim_events_claim_id",
        table_name="organizer_claim_events",
    )
    op.drop_table("organizer_claim_events")

    op.drop_index("ix_organizer_claims_status", table_name="organizer_claims")
    op.drop_index("ix_organizer_claims_user_id", table_name="organizer_claims")
    op.drop_table("organizer_claims")
