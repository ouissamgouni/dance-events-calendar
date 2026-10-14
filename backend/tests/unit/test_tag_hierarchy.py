"""Tag parent hierarchy: event tagging adds parents, search selections drop them."""

import importlib
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend.api.deps import require_admin
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventTag,
    SiteSetting,
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
    UserPreferredTag,
)
from backend.services.reach import assign_event_tag
from backend.services.tag_hierarchy import (
    drop_superseded_parents,
    with_parent_tag_ids,
)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    yield eng
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture
def family(session):
    """dance-style: salsa > (on1, on2, cuban); bachata standalone."""
    group = TagGroup(slug="dance-style", label="Dance Style")
    other = TagGroup(slug="format", label="Format")
    session.add_all([group, other])
    session.commit()
    salsa = Tag(group_id=group.id, slug="salsa", label="Salsa")
    bachata = Tag(group_id=group.id, slug="bachata", label="Bachata")
    social = Tag(group_id=other.id, slug="social", label="Social")
    session.add_all([salsa, bachata, social])
    session.commit()
    on1 = Tag(group_id=group.id, slug="salsa-on1", label="On1", parent_tag_id=salsa.id)
    on2 = Tag(group_id=group.id, slug="mambo", label="On2", parent_tag_id=salsa.id)
    cuban = Tag(group_id=group.id, slug="cuban", label="Cuban")
    session.add_all([on1, on2, cuban])
    session.commit()
    return {t.slug: t for t in (salsa, bachata, social, on1, on2, cuban)}


@pytest.fixture
def admin_client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = lambda: {"sub": "admin"}
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(require_admin, None)


def _event(session, event_id="evt-1"):
    event = CachedEvent(
        event_id=event_id,
        calendar_id="cal",
        title="Night",
        start=datetime(2030, 1, 1, 20, tzinfo=timezone.utc),
        end=datetime(2030, 1, 1, 23, tzinfo=timezone.utc),
    )
    session.add(event)
    session.commit()
    return event


def _event_tag_ids(session, event_id="evt-1"):
    return set(
        session.exec(select(EventTag.tag_id).where(EventTag.event_id == event_id)).all()
    )


@pytest.mark.unit
class TestHelpers:
    def test_with_parent_adds_parent_once(self, session, family):
        ids = with_parent_tag_ids(
            session, [family["mambo"].id, family["salsa-on1"].id, family["bachata"].id]
        )
        assert ids == [
            family["mambo"].id,
            family["salsa-on1"].id,
            family["bachata"].id,
            family["salsa"].id,
        ]

    def test_with_parent_keeps_explicit_parent(self, session, family):
        ids = with_parent_tag_ids(session, [family["salsa"].id, family["mambo"].id])
        assert ids == [family["salsa"].id, family["mambo"].id]

    def test_drop_superseded_parent_when_child_selected(self, session, family):
        ids = drop_superseded_parents(
            session, [family["salsa"].id, family["mambo"].id, family["bachata"].id]
        )
        assert ids == [family["mambo"].id, family["bachata"].id]

    def test_siblings_are_kept_together(self, session, family):
        ids = drop_superseded_parents(
            session, [family["salsa"].id, family["salsa-on1"].id, family["mambo"].id]
        )
        assert ids == [family["salsa-on1"].id, family["mambo"].id]

    def test_parent_alone_is_kept(self, session, family):
        assert drop_superseded_parents(session, [family["salsa"].id]) == [
            family["salsa"].id
        ]


@pytest.mark.unit
class TestEventTagging:
    def test_assign_child_also_assigns_parent(self, session, family):
        event = _event(session)
        assert assign_event_tag(session, event, family["mambo"]) is True
        session.commit()
        assert _event_tag_ids(session) == {family["mambo"].id, family["salsa"].id}

    def test_assign_child_when_parent_present(self, session, family):
        event = _event(session)
        assign_event_tag(session, event, family["salsa"])
        session.commit()
        assert assign_event_tag(session, event, family["mambo"]) is True
        session.commit()
        assert _event_tag_ids(session) == {family["mambo"].id, family["salsa"].id}

    def test_set_event_tags_route_adds_parent(self, admin_client, session, family):
        _event(session)
        resp = admin_client.put(
            "/api/admin/events/evt-1/tags",
            json={"tag_ids": [family["salsa-on1"].id, family["bachata"].id]},
        )
        assert resp.status_code == 200, resp.text
        assert {t["slug"] for t in resp.json()} == {"salsa-on1", "salsa", "bachata"}


@pytest.mark.unit
class TestTagParentAdmin:
    def test_set_parent(self, admin_client, family):
        resp = admin_client.patch(
            f"/api/admin/tags/{family['cuban'].id}",
            json={"parent_tag_id": family["salsa"].id},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["parent_tag_id"] == family["salsa"].id

    def test_clear_parent(self, admin_client, family):
        resp = admin_client.patch(
            f"/api/admin/tags/{family['mambo'].id}", json={"parent_tag_id": None}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["parent_tag_id"] is None

    def test_set_and_clear_short_label(self, admin_client, family):
        url = f"/api/admin/tags/{family['mambo'].id}"
        resp = admin_client.patch(url, json={"short_label": " On2 "})
        assert resp.status_code == 200, resp.text
        assert resp.json()["short_label"] == "On2"
        resp = admin_client.patch(url, json={"short_label": ""})
        assert resp.status_code == 200, resp.text
        assert resp.json()["short_label"] is None

    @pytest.mark.parametrize(
        "child, parent",
        [
            ("cuban", "mambo"),  # parent already has a parent
            ("salsa", "bachata"),  # tag already has children
            ("social", "salsa"),  # cross-group
            ("salsa", "salsa"),  # self
        ],
    )
    def test_rejects_invalid_parent(self, admin_client, family, child, parent):
        resp = admin_client.patch(
            f"/api/admin/tags/{family[child].id}",
            json={"parent_tag_id": family[parent].id},
        )
        assert resp.status_code == 400

    def test_cannot_move_linked_tag_to_another_group(self, admin_client, family):
        resp = admin_client.patch(
            f"/api/admin/tags/{family['mambo'].id}",
            json={"group_id": family["social"].group_id},
        )
        assert resp.status_code == 400

    def test_deleting_parent_detaches_children(self, admin_client, session, family):
        resp = admin_client.delete(f"/api/admin/tags/{family['salsa'].id}")
        assert resp.status_code == 204
        session.expire_all()
        assert session.get(Tag, family["mambo"].id).parent_tag_id is None


def _migration():
    return importlib.import_module(
        "backend.db.alembic.versions.dh1a2b3c4d5e_tag_parent_hierarchy"
    )


@pytest.mark.unit
def test_migration_links_children_and_normalizes_selections(session):
    group = TagGroup(slug="dance-style", label="Dance Style")
    session.add(group)
    session.commit()
    tags = {
        slug: Tag(group_id=group.id, slug=slug, label=slug)
        for slug in ("salsa", "salsa-on1", "mambo", "cuban", "bachata")
    }
    session.add_all(tags.values())
    user = User(
        email="u@example.com",
        handle="u",
        display_name="U",
        provider="google",
        provider_subject="mock|u",
    )
    session.add(user)
    session.commit()
    ids = {slug: tag.id for slug, tag in tags.items()}
    p_on2 = UserInterestProfile(
        user_id=user.id,
        label="On2",
        area_label="EU",
        min_lat=0,
        min_lng=0,
        max_lat=1,
        max_lng=1,
    )
    p_all = UserInterestProfile(
        user_id=user.id,
        label="All",
        area_label="EU",
        min_lat=0,
        min_lng=0,
        max_lat=1,
        max_lng=1,
    )
    session.add_all([p_on2, p_all])
    session.commit()
    session.add_all(
        [
            UserInterestProfileTag(profile_id=p_on2.id, tag_id=ids["salsa"]),
            UserInterestProfileTag(profile_id=p_on2.id, tag_id=ids["mambo"]),
            UserInterestProfileTag(profile_id=p_on2.id, tag_id=ids["bachata"]),
            UserInterestProfileTag(profile_id=p_all.id, tag_id=ids["salsa"]),
            UserPreferredTag(user_id=user.id, tag_id=ids["salsa"]),
            UserPreferredTag(user_id=user.id, tag_id=ids["cuban"]),
        ]
    )
    session.commit()

    migration = _migration()
    connection = session.connection()
    migration._link_salsa_children(connection)
    migration._drop_redundant_parents(connection)
    session.commit()
    session.expire_all()

    assert {
        t.slug
        for t in session.exec(select(Tag)).all()
        if t.parent_tag_id == ids["salsa"]
    } == {"salsa-on1", "mambo", "cuban"}

    def profile_tags(pid):
        return set(
            session.exec(
                select(UserInterestProfileTag.tag_id).where(
                    UserInterestProfileTag.profile_id == pid
                )
            ).all()
        )

    assert profile_tags(p_on2.id) == {ids["mambo"], ids["bachata"]}
    assert profile_tags(p_all.id) == {ids["salsa"]}
    assert set(session.exec(select(UserPreferredTag.tag_id)).all()) == {ids["cuban"]}
    backup = json.loads(session.get(SiteSetting, migration._BACKUP_KEY).value)
    assert len(backup["user_interest_profile_tags"]) == 1
    assert len(backup["user_preferred_tags"]) == 1

    # Re-running is a no-op; downgrade restores exactly what was removed.
    connection = session.connection()
    migration._drop_redundant_parents(connection)
    migration._restore_redundant_parents(connection)
    session.commit()
    session.expire_all()
    assert profile_tags(p_on2.id) == {ids["salsa"], ids["mambo"], ids["bachata"]}
    assert set(session.exec(select(UserPreferredTag.tag_id)).all()) == {
        ids["salsa"],
        ids["cuban"],
    }
    assert session.get(SiteSetting, migration._BACKUP_KEY) is None
