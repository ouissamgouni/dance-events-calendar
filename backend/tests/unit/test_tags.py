"""Tests for tag endpoints: list tags, submit suggestions, admin CRUD."""

import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.api.main import app
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

    session.add.side_effect = mock_add
    session.delete.side_effect = mock_delete
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

        session.exec.return_value.all.return_value = [group]
        resp = c.get("/api/tags")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["slug"] == "format"
        assert len(data[0]["tags"]) == 1
        assert data[0]["tags"][0]["slug"] == "social"


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
        assert resp.status_code == 200
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
