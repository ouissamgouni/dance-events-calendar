"""Tests for the DB-backed synonym loader (`load_taxonomy`).

Verifies that synonyms come from the ``tag_synonyms`` table only — the runtime
engine no longer falls back to the static seed map, so admin deletions stay
deleted.
"""

from datetime import datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend.db.models import Tag, TagGroup, TagSynonym
from backend.services.tag_suggester import load_taxonomy


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as sess:
        yield sess


def _seed(session: Session) -> tuple[int, int]:
    """Create one event-scope group with two tags and return their ids."""
    g = TagGroup(
        slug="dance",
        label="Dance",
        ordinal=0,
        allow_multiple=True,
        scope="event",
        enabled=True,
    )
    session.add(g)
    session.flush()
    salsa = Tag(group_id=g.id, slug="salsa", label="Salsa", ordinal=0)
    bachata = Tag(group_id=g.id, slug="bachata", label="Bachata", ordinal=1)
    session.add(salsa)
    session.add(bachata)
    session.flush()
    return salsa.id, bachata.id


def _terms_for(snapshot, slug):
    for t in snapshot.tags:
        if t.slug == slug:
            return {term for term, _ in t.terms}
    return set()


def test_load_taxonomy_uses_db_synonyms_when_present(session):
    salsa_id, _ = _seed(session)
    session.add(
        TagSynonym(
            tag_id=salsa_id, term="custom-salsa-term", created_at=datetime.utcnow()
        )
    )
    session.commit()

    snapshot = load_taxonomy(session)
    salsa_terms = _terms_for(snapshot, "salsa")

    assert "custom-salsa-term" in salsa_terms
    # Slug + label always included.
    assert "salsa" in salsa_terms


def test_load_taxonomy_does_not_fall_back_to_static_map(session):
    """Tags without DB rows should expose ONLY their slug + label — no static
    fallback. The static map is a one-time install seed, not a runtime source.
    """
    _seed(session)
    session.commit()

    snapshot = load_taxonomy(session)
    salsa_terms = _terms_for(snapshot, "salsa")
    # Only the slug/label survive ("salsa" itself); no "casino" / "rueda" / etc.
    assert salsa_terms == {"salsa"}


def test_db_rows_are_the_only_synonym_source(session):
    """Admin-configured synonyms are the sole runtime source."""
    salsa_id, _ = _seed(session)
    session.add(
        TagSynonym(tag_id=salsa_id, term="only-this", created_at=datetime.utcnow())
    )
    session.commit()

    snapshot = load_taxonomy(session)
    salsa_terms = _terms_for(snapshot, "salsa")
    bachata_terms = _terms_for(snapshot, "bachata")

    # Admin synonym present + slug. Hyphenated terms also gain a space variant.
    assert salsa_terms == {"salsa", "only-this", "only this"}
    # Bachata has no DB rows → only slug/label.
    assert bachata_terms == {"bachata"}
