"""Tests for tag endpoints: list tags, submit suggestions, admin CRUD."""

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
from backend.api.routes.tags import _group_to_response
from backend.db.database import get_session
from backend.db.models import Tag, TagGroup, EventTag, TagSuggestion, CachedEvent


def _mock_session():
    session = MagicMock(spec=Session)
    session._added = []
    session._deleted = []

    def mock_add(obj):
        session._added.append(obj)

    def mock_delete(obj):
        session._deleted.append(obj)

    def mock_refresh(obj):
        if getattr(obj, "id", None) is None:
            obj.id = 1

    session.add.side_effect = mock_add
    session.delete.side_effect = mock_delete
    session.refresh.side_effect = mock_refresh
    return session


def _make_tag_group(
    id=1, slug="format", label="Format", ordinal=0, allow_multiple=True
):
    g = TagGroup(
        id=id, slug=slug, label=label, ordinal=ordinal, allow_multiple=allow_multiple
    )
    g.tags = []
    return g


def _make_tag(
    id=1, group_id=1, slug="social", label="Social", color="#e11d48", ordinal=0
):
    t = Tag(
        id=id, group_id=group_id, slug=slug, label=label, color=color, ordinal=ordinal
    )
    return t


def _make_event(event_id="evt-001"):
    return CachedEvent(
        event_id=event_id,
        calendar_id="cal-001",
        title="Test Event",
        start="2025-01-01T20:00:00",
        end="2025-01-01T23:00:00",
    )


@pytest.fixture
def client():
    session = _mock_session()
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app), session
    app.dependency_overrides.clear()


@pytest.fixture
def admin_client():
    session = _mock_session()
    from backend.api.deps import require_admin

    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[require_admin] = lambda: {"sub": "admin"}
    yield TestClient(app), session
    app.dependency_overrides.clear()


@pytest.mark.unit
class TestListTags:
    def test_list_tags_empty(self, client):
        c, session = client
        session.exec.return_value.all.return_value = []
        resp = c.get("/api/tags")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_tags_returns_groups_with_tags(self, client):
        c, session = client
        group = _make_tag_group()
        tag = _make_tag()
        tag.group = group
        group.tags = [tag]

        # First exec().all() returns groups; second returns empty count rows
        session.exec.return_value.all.side_effect = [[group], []]
        resp = c.get("/api/tags")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["slug"] == "format"
        assert len(data[0]["tags"]) == 1
        assert data[0]["tags"][0]["slug"] == "social"

    def test_group_response_sorts_tags_by_ordinal(self):
        group = _make_tag_group()
        high = _make_tag(id=2, slug="zeta", label="Zeta", ordinal=3)
        low = _make_tag(id=1, slug="alpha", label="Alpha", ordinal=1)
        group.tags = [high, low]

        data = _group_to_response(group)
        assert [t.slug for t in data.tags] == ["alpha", "zeta"]


@pytest.mark.unit
class TestSubmitTagSuggestion:
    def test_submit_suggestion_honeypot_rejects(self, client):
        c, session = client
        resp = c.post(
            "/api/tags/suggestions",
            json={
                "event_id": "evt-001",
                "tag_id": 1,
                "device_id": "dev-123",
                "website": "http://spam.com",
            },
        )
        assert resp.status_code == 201
        assert len(session._added) == 0

    def test_submit_suggestion_requires_tag_or_free_text(self, client):
        c, session = client
        session.get.return_value = _make_event()
        resp = c.post(
            "/api/tags/suggestions",
            json={
                "event_id": "evt-001",
                "device_id": "dev-123",
            },
        )
        assert resp.status_code == 400

    def test_submit_suggestion_valid_tag(self, client):
        c, session = client
        event = _make_event()
        tag = _make_tag()
        session.get.side_effect = lambda model, id: {
            ("evt-001",): event,
            (1,): tag,
        }.get((id,))
        # Mock the rate limit check
        session.exec.return_value.one.return_value = 0

        resp = c.post(
            "/api/tags/suggestions",
            json={
                "event_id": "evt-001",
                "tag_id": 1,
                "device_id": "dev-123",
            },
        )
        assert resp.status_code == 201
        assert len(session._added) == 1
        suggestion = session._added[0]
        assert isinstance(suggestion, TagSuggestion)
        assert suggestion.event_id == "evt-001"
        assert suggestion.tag_id == 1

    def test_submit_suggestion_free_text(self, client):
        c, session = client
        event = _make_event()
        session.get.side_effect = lambda model, id: {
            ("evt-001",): event,
        }.get((id,))
        session.exec.return_value.one.return_value = 0

        resp = c.post(
            "/api/tags/suggestions",
            json={
                "event_id": "evt-001",
                "free_text": "cozy venue",
                "device_id": "dev-123",
            },
        )
        assert resp.status_code == 201
        suggestion = session._added[0]
        assert suggestion.free_text == "cozy venue"


@pytest.mark.unit
class TestAdminEventTags:
    def test_replace_event_tags(self, admin_client):
        c, session = admin_client
        event = _make_event()
        session.get.side_effect = lambda model, id: {
            (CachedEvent, "evt-001"): event,
            (Tag, 1): _make_tag(id=1),
            (Tag, 2): _make_tag(id=2, slug="class", label="Class"),
        }.get((model, id))
        session.exec.return_value.all.return_value = []
        # Mock get_event_tags
        with patch(
            "backend.api.routes.tags.get_event_tags", return_value={"evt-001": []}
        ):
            resp = c.put("/api/admin/events/evt-001/tags", json={"tag_ids": [1, 2]})
        assert resp.status_code == 200
        # Should have added 2 EventTag objects
        event_tags = [a for a in session._added if isinstance(a, EventTag)]
        assert len(event_tags) == 2

    def test_admin_updates_tag_group_ordinal(self, admin_client):
        c, session = admin_client
        group = _make_tag_group(id=1, ordinal=6)
        session.get.side_effect = lambda model, id: {
            (TagGroup, 1): group,
        }.get((model, id))

        resp = c.patch("/api/admin/tags/groups/1", json={"ordinal": 2})
        assert resp.status_code == 200
        assert group.ordinal == 2

    def test_admin_approve_tag_suggestion(self, admin_client):
        c, session = admin_client
        suggestion = TagSuggestion(
            id=1,
            event_id="evt-001",
            tag_id=1,
            status="pending",
            submitter_device_id="dev-123",
        )
        event = _make_event()
        tag = _make_tag()
        session.get.side_effect = lambda model, id: {
            (TagSuggestion, 1): suggestion,
            (CachedEvent, "evt-001"): event,
            (Tag, 1): tag,
        }.get((model, id))
        session.exec.return_value.first.return_value = None

        resp = c.post("/api/admin/tags/suggestions/1/approve", json={})
        assert resp.status_code == 200
        assert suggestion.status == "approved"
        event_tags = [a for a in session._added if isinstance(a, EventTag)]
        assert len(event_tags) == 1

    def test_admin_reject_tag_suggestion(self, admin_client):
        c, session = admin_client
        suggestion = TagSuggestion(
            id=2,
            event_id="evt-001",
            tag_id=1,
            status="pending",
            submitter_device_id="dev-123",
        )
        session.get.side_effect = lambda model, id: {
            (TagSuggestion, 2): suggestion,
        }.get((model, id))

        resp = c.post(
            "/api/admin/tags/suggestions/2/reject",
            json={
                "admin_notes": "Not applicable",
            },
        )
        assert resp.status_code == 200
        assert suggestion.status == "rejected"
        assert suggestion.admin_notes == "Not applicable"


@pytest.mark.unit
class TestHeroFilterMetadata:
    def test_tag_response_includes_hero_fields(self):
        """_tag_to_response exposes is_hero_filter and hero_ordinal."""
        from backend.api.routes.tags import _tag_to_response

        group = _make_tag_group()
        tag = Tag(
            id=5,
            group_id=1,
            slug="salsa",
            label="Salsa",
            ordinal=0,
            enabled=True,
            is_hero_filter=True,
            hero_ordinal=2,
        )
        tag.group = group
        resp = _tag_to_response(tag)
        assert resp.is_hero_filter is True
        assert resp.hero_ordinal == 2

    def test_non_hero_tag_response_defaults(self):
        """Tags without hero flag return is_hero_filter=False, hero_ordinal=None."""
        from backend.api.routes.tags import _tag_to_response

        group = _make_tag_group()
        tag = _make_tag()
        tag.group = group
        resp = _tag_to_response(tag)
        assert resp.is_hero_filter is False
        assert resp.hero_ordinal is None

    def test_admin_patch_sets_hero_filter(self, admin_client):
        """PATCH /api/admin/tags/{id} persists is_hero_filter and hero_ordinal."""
        c, session = admin_client
        tag = Tag(
            id=3,
            group_id=1,
            slug="social",
            label="Social",
            ordinal=0,
            enabled=True,
            is_hero_filter=False,
            hero_ordinal=None,
        )
        group = _make_tag_group()
        tag.group = group
        session.get.side_effect = lambda model, id: {
            (Tag, 3): tag,
        }.get((model, id))

        resp = c.patch(
            "/api/admin/tags/3",
            json={"is_hero_filter": True, "hero_ordinal": 0},
        )
        assert resp.status_code == 200
        assert tag.is_hero_filter is True
        assert tag.hero_ordinal == 0

    def test_admin_patch_clears_hero_filter(self, admin_client):
        """PATCH /api/admin/tags/{id} can remove hero status."""
        c, session = admin_client
        tag = Tag(
            id=4,
            group_id=1,
            slug="bachata",
            label="Bachata",
            ordinal=1,
            enabled=True,
            is_hero_filter=True,
            hero_ordinal=1,
        )
        group = _make_tag_group()
        tag.group = group
        session.get.side_effect = lambda model, id: {
            (Tag, 4): tag,
        }.get((model, id))

        resp = c.patch(
            "/api/admin/tags/4",
            json={"is_hero_filter": False, "hero_ordinal": None},
        )
        assert resp.status_code == 200
        assert tag.is_hero_filter is False
        assert tag.hero_ordinal is None

    def test_hero_status_does_not_affect_group_response_tag_order(self):
        """Tags in _group_to_response are always sorted by ordinal, hero status has no effect."""
        group = _make_tag_group()
        t1 = Tag(
            id=1,
            group_id=1,
            slug="a",
            label="A",
            ordinal=1,
            enabled=True,
            is_hero_filter=True,
            hero_ordinal=0,
        )
        t2 = Tag(
            id=2,
            group_id=1,
            slug="b",
            label="B",
            ordinal=2,
            enabled=True,
            is_hero_filter=False,
            hero_ordinal=None,
        )
        t3 = Tag(
            id=3,
            group_id=1,
            slug="c",
            label="C",
            ordinal=0,
            enabled=True,
            is_hero_filter=True,
            hero_ordinal=1,
        )
        group.tags = [t1, t2, t3]

        data = _group_to_response(group)
        assert [t.slug for t in data.tags] == ["c", "a", "b"]
