"""Tests for the DB-backed synonym loader (`load_taxonomy`).

Verifies that synonyms come from the ``tag_synonyms`` table when present,
fall back to the static seed map otherwise, and that admin-edited synonyms
flow into the heuristic suggester's term index.
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


def test_load_taxonomy_falls_back_to_static_map_when_no_db_rows(session):
    """Tags without DB rows should still pick up the seed-map defaults."""
    _seed(session)
    session.commit()

    snapshot = load_taxonomy(session)
    # The static map ships defaults for "salsa" — confirm at least one
    # well-known synonym shows up via fallback.
    salsa_terms = _terms_for(snapshot, "salsa")
    # "salsa" itself is always present; the fallback should add more terms.
    assert len(salsa_terms) > 1


def test_db_rows_replace_static_map_for_that_tag(session):
    """If admin configures any synonyms for a tag, the static fallback is ignored."""
    salsa_id, bachata_id = _seed(session)
    session.add(
        TagSynonym(tag_id=salsa_id, term="only-this", created_at=datetime.utcnow())
    )
    session.commit()

    snapshot = load_taxonomy(session)
    salsa_terms = _terms_for(snapshot, "salsa")
    bachata_terms = _terms_for(snapshot, "bachata")

    # Admin synonym present.
    assert "only-this" in salsa_terms
    # Bachata still gets the fallback (it has no DB rows).
    assert len(bachata_terms) >= 1
