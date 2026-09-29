"""add schedule contributors

Revision ID: pb2c3d4e5f6a
Revises: pa1b2c3d4e5f
Create Date: 2026-09-29
"""

from hashlib import sha1
from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "pb2c3d4e5f6a"
down_revision: Union[str, None] = "pa1b2c3d4e5f"
branch_labels = None
depends_on = None

LEGACY_CONTRIBUTOR_SPLITS = {
    "Alexis Ruiz, Angelo Rito, Terry Salsalianza": (
        "Alexis Ruiz",
        "Angelo Rito",
        "Terry Salsalianza",
    ),
}


def upgrade() -> None:
    op.create_table(
        "schedule_contributors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(length=120), nullable=False),
        sa.Column("schedule_id", sa.Integer(), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(
            ["schedule_id"], ["event_schedules.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "schedule_id", "external_id", name="uq_schedule_contributor_external_id"
        ),
    )
    op.create_index(
        "ix_schedule_contributors_external_id",
        "schedule_contributors",
        ["external_id"],
    )
    op.create_index(
        "ix_schedule_contributors_schedule_id",
        "schedule_contributors",
        ["schedule_id"],
    )
    op.create_table(
        "schedule_session_contributors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("contributor_id", sa.Integer(), nullable=False),
        sa.Column(
            "role", sa.String(length=20), nullable=False, server_default="instructor"
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "role IN ('instructor', 'dj', 'performer', 'host', 'other')",
            name="ck_schedule_session_contributors_role",
        ),
        sa.ForeignKeyConstraint(
            ["contributor_id"], ["schedule_contributors.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["session_id"], ["schedule_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "session_id",
            "contributor_id",
            "role",
            name="uq_schedule_session_contributor_role",
        ),
        sa.UniqueConstraint(
            "session_id", "position", name="uq_schedule_session_contributor_position"
        ),
    )
    op.create_index(
        "ix_schedule_session_contributors_contributor_id",
        "schedule_session_contributors",
        ["contributor_id"],
    )
    op.create_index(
        "ix_schedule_session_contributors_session_id",
        "schedule_session_contributors",
        ["session_id"],
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, schedule_id, instructors FROM schedule_sessions "
            "WHERE instructors IS NOT NULL AND TRIM(instructors) <> '' "
            "ORDER BY schedule_id, instructors, id"
        )
    ).mappings()
    contributor_ids: dict[tuple[int, str], int] = {}
    sort_orders: dict[int, int] = {}
    for row in rows:
        legacy_label = row["instructors"].strip()
        display_names = LEGACY_CONTRIBUTOR_SPLITS.get(legacy_label, (legacy_label,))
        for position, display_name in enumerate(display_names):
            key = (row["schedule_id"], display_name)
            contributor_id = contributor_ids.get(key)
            if contributor_id is None:
                external_id = (
                    f"legacy-{sha1(f'{key[0]}:{key[1]}'.encode()).hexdigest()[:20]}"
                )
                sort_order = sort_orders.get(key[0], 0)
                result = bind.execute(
                    sa.text(
                        "INSERT INTO schedule_contributors "
                        "(external_id, schedule_id, display_name, sort_order) "
                        "VALUES (:external_id, :schedule_id, :display_name, :sort_order)"
                    ),
                    {
                        "external_id": external_id,
                        "schedule_id": key[0],
                        "display_name": key[1],
                        "sort_order": sort_order,
                    },
                )
                contributor_id = result.lastrowid
                if contributor_id is None:
                    contributor_id = bind.execute(
                        sa.text(
                            "SELECT id FROM schedule_contributors "
                            "WHERE schedule_id = :schedule_id AND external_id = :external_id"
                        ),
                        {"schedule_id": key[0], "external_id": external_id},
                    ).scalar_one()
                contributor_ids[key] = contributor_id
                sort_orders[key[0]] = sort_order + 1
            bind.execute(
                sa.text(
                    "INSERT INTO schedule_session_contributors "
                    "(session_id, contributor_id, role, position) "
                    "VALUES (:session_id, :contributor_id, 'instructor', :position)"
                ),
                {
                    "session_id": row["id"],
                    "contributor_id": contributor_id,
                    "position": position,
                },
            )


def downgrade() -> None:
    op.drop_table("schedule_session_contributors")
    op.drop_table("schedule_contributors")
