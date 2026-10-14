"""tag parent hierarchy + drop redundant parent tags from search profiles

Revision ID: dh1a2b3c4d5e
Revises: pl1a2b3c4d5e
Create Date: 2026-10-14

Adds ``tags.parent_tag_id`` (one level, same group) and links the salsa
sub-styles to ``salsa``. Search profiles / preferred tags that hold both a
parent and one of its children are normalized to the child only; removed
rows are kept in ``site_settings`` so ``downgrade`` can restore them.
"""

import json
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "dh1a2b3c4d5e"
down_revision: Union[str, None] = "pl1a2b3c4d5e"
branch_labels = None
depends_on = None

_BACKUP_KEY = "migration_backup_dh1a2b3c4d5e"
_SALSA_CHILDREN = ("salsa-on1", "mambo", "cuban")
# (table, owner column)
_SELECTION_TABLES = (
    ("user_interest_profile_tags", "profile_id"),
    ("user_preferred_tags", "user_id"),
)


def _link_salsa_children(conn) -> None:
    parent_id = conn.execute(
        sa.text(
            "SELECT t.id FROM tags t JOIN tag_groups g ON g.id = t.group_id "
            "WHERE g.slug = 'dance-style' AND t.slug = 'salsa'"
        )
    ).scalar()
    if parent_id is None:
        return
    conn.execute(
        sa.text(
            "UPDATE tags SET parent_tag_id = :pid "
            "WHERE parent_tag_id IS NULL AND id <> :pid AND slug IN :slugs "
            "AND group_id = (SELECT group_id FROM tags WHERE id = :pid)"
        ).bindparams(sa.bindparam("slugs", expanding=True)),
        {"pid": parent_id, "slugs": list(_SALSA_CHILDREN)},
    )


def _drop_redundant_parents(conn) -> None:
    existing = conn.execute(
        sa.text("SELECT value FROM site_settings WHERE key = :k"), {"k": _BACKUP_KEY}
    ).scalar()
    backup: dict[str, list] = json.loads(existing) if existing else {}
    for table, owner in _SELECTION_TABLES:
        rows = conn.execute(
            sa.text(
                f"SELECT s.{owner}, s.tag_id FROM {table} s WHERE EXISTS ("
                f"SELECT 1 FROM {table} c JOIN tags t ON t.id = c.tag_id "
                f"WHERE c.{owner} = s.{owner} AND t.parent_tag_id = s.tag_id)"
            )
        ).all()
        for owner_id, tag_id in rows:
            conn.execute(
                sa.text(f"DELETE FROM {table} WHERE {owner} = :o AND tag_id = :t"),
                {"o": owner_id, "t": tag_id},
            )
        backup.setdefault(table, []).extend([str(o), int(t)] for o, t in rows)
    if not any(backup.values()):
        return
    value = json.dumps(backup)
    if existing is None:
        conn.execute(
            sa.text("INSERT INTO site_settings (key, value) VALUES (:k, :v)"),
            {"k": _BACKUP_KEY, "v": value},
        )
    else:
        conn.execute(
            sa.text("UPDATE site_settings SET value = :v WHERE key = :k"),
            {"k": _BACKUP_KEY, "v": value},
        )


def _restore_redundant_parents(conn) -> None:
    existing = conn.execute(
        sa.text("SELECT value FROM site_settings WHERE key = :k"), {"k": _BACKUP_KEY}
    ).scalar()
    if not existing:
        return
    for table, owner in _SELECTION_TABLES:
        for owner_id, tag_id in json.loads(existing).get(table, []):
            present = conn.execute(
                sa.text(f"SELECT 1 FROM {table} WHERE {owner} = :o AND tag_id = :t"),
                {"o": owner_id, "t": tag_id},
            ).first()
            if present is None:
                conn.execute(
                    sa.text(
                        f"INSERT INTO {table} ({owner}, tag_id, created_at) "
                        "VALUES (:o, :t, CURRENT_TIMESTAMP)"
                    ),
                    {"o": owner_id, "t": tag_id},
                )
    conn.execute(
        sa.text("DELETE FROM site_settings WHERE key = :k"), {"k": _BACKUP_KEY}
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "parent_tag_id" not in {c["name"] for c in inspector.get_columns("tags")}:
        op.add_column("tags", sa.Column("parent_tag_id", sa.Integer(), nullable=True))
        op.create_foreign_key(
            "fk_tags_parent_tag_id",
            "tags",
            "tags",
            ["parent_tag_id"],
            ["id"],
            ondelete="SET NULL",
        )
    if "ix_tags_parent_tag_id" not in {
        ix["name"] for ix in inspector.get_indexes("tags")
    }:
        op.create_index("ix_tags_parent_tag_id", "tags", ["parent_tag_id"])

    _link_salsa_children(bind)
    _drop_redundant_parents(bind)


def downgrade() -> None:
    bind = op.get_bind()
    _restore_redundant_parents(bind)
    inspector = sa.inspect(bind)
    if "ix_tags_parent_tag_id" in {ix["name"] for ix in inspector.get_indexes("tags")}:
        op.drop_index("ix_tags_parent_tag_id", table_name="tags")
    if "fk_tags_parent_tag_id" in {
        fk["name"] for fk in inspector.get_foreign_keys("tags")
    }:
        op.drop_constraint("fk_tags_parent_tag_id", "tags", type_="foreignkey")
    if "parent_tag_id" in {c["name"] for c in inspector.get_columns("tags")}:
        op.drop_column("tags", "parent_tag_id")
