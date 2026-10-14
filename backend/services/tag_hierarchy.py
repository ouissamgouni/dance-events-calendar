"""One-level tag hierarchy (e.g. Salsa > On1 / On2 / Cuban).

Events carry the parent alongside a child so a parent selection ("All salsa")
matches the whole family. In a search selection a child supersedes its parent,
so "Salsa + On2" means On2 only.
"""

from typing import Iterable

from sqlmodel import Session, select

from backend.db.models import Tag


def _parent_ids(session: Session, tag_ids: list[int]) -> list[int]:
    if not tag_ids:
        return []
    return [
        int(pid)
        for pid in session.exec(
            select(Tag.parent_tag_id).where(
                Tag.id.in_(tag_ids),  # type: ignore[union-attr]
                Tag.parent_tag_id.is_not(None),  # type: ignore[union-attr]
            )
        ).all()
    ]


def with_parent_tag_ids(session: Session, tag_ids: Iterable[int]) -> list[int]:
    """Event tagging: ``tag_ids`` plus the parent of each child, order kept."""
    ids = list(dict.fromkeys(int(t) for t in tag_ids))
    for pid in _parent_ids(session, ids):
        if pid not in ids:
            ids.append(pid)
    return ids


def drop_superseded_parents(session: Session, tag_ids: Iterable[int]) -> list[int]:
    """Search selection: drop a parent when one of its children is selected."""
    ids = list(dict.fromkeys(int(t) for t in tag_ids))
    superseded = set(_parent_ids(session, ids))
    return [t for t in ids if t not in superseded]
