"""API tests for the Dance Passport endpoints."""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlalchemy.pool import StaticPool

from backend.api.deps import get_current_user_optional, require_user
from backend.api.main import app
from backend.db.database import get_session
from backend.db.models import CachedEvent, User, UserEventAttendance

NOW = datetime.utcnow()


@pytest.fixture
def client_with_user():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    with Session(engine) as setup:
        user = User(email="dancer@example.com")
        setup.add(user)
        setup.commit()
        setup.refresh(user)
        user_id = user.id

    def _override_session():
        with Session(engine) as session:
            yield session

    def _override_user():
        with Session(engine) as session:
            return session.get(User, user_id)

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[require_user] = _override_user
    try:
        yield TestClient(app), engine, user_id
    finally:
        app.dependency_overrides.clear()
        SQLModel.metadata.drop_all(engine)


def _seed_going(engine, user_id, event_id, start, *, city=None, country=None):
    with Session(engine) as s:
        s.add(
            CachedEvent(
                event_id=event_id,
                calendar_id="cal-1",
                title=f"Event {event_id}",
                start=start,
                end=start + timedelta(hours=3),
                city=city,
                country=country,
            )
        )
        s.add(
            UserEventAttendance(
                device_id=f"dev-{event_id}",
                event_id=event_id,
                user_id=user_id,
            )
        )
        s.commit()


@pytest.mark.unit
class TestPassportEndpoint:
    def test_stats_and_collections(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )
        _seed_going(
            engine,
            user_id,
            "e2",
            NOW - timedelta(days=10),
            city="Berlin",
            country="Germany",
        )

        resp = client.get("/api/passport")

        assert resp.status_code == 200
        body = resp.json()
        assert body["stats"]["total_events_attended"] == 2
        assert body["stats"]["cities_visited"] == 2
        assert body["stats"]["countries_visited"] == 2
        assert len(body["collections"]["countries"]) == 2

    def test_empty_passport(self, client_with_user):
        client, _engine, _user_id = client_with_user

        resp = client.get("/api/passport")

        assert resp.status_code == 200
        assert resp.json()["stats"]["total_events_attended"] == 0


@pytest.mark.unit
class TestPassportTimeline:
    def test_timeline_paginated_newest_first(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(engine, user_id, "older", NOW - timedelta(days=30), city="Paris")
        _seed_going(engine, user_id, "newer", NOW - timedelta(days=2), city="Berlin")

        resp = client.get("/api/passport/timeline?offset=0&limit=1")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert len(body["items"]) == 1
        assert body["items"][0]["event_id"] == "newer"

    def test_timeline_offset(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(engine, user_id, "older", NOW - timedelta(days=30))
        _seed_going(engine, user_id, "newer", NOW - timedelta(days=2))

        resp = client.get("/api/passport/timeline?offset=1&limit=1")

        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) == 1
        assert items[0]["event_id"] == "older"

    def test_timeline_returns_milestone_markers(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )

        resp = client.get("/api/passport/timeline")

        assert resp.status_code == 200
        markers = resp.json()["markers"]
        keys = {m["key"] for m in markers}
        assert "first_event" in keys


@pytest.mark.unit
class TestPassportEvents:
    def test_events_endpoint_carries_place(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=10),
            city="Paris",
            country="France",
        )

        resp = client.get("/api/passport/events")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["event_id"] == "e1"
        assert body[0]["city"] == "Paris"
        assert body[0]["country"] == "France"


@pytest.mark.unit
class TestPassportShare:
    def test_mint_returns_token_and_is_idempotent(self, client_with_user):
        client, _engine, _user_id = client_with_user

        first = client.post("/api/passport/share")
        assert first.status_code == 201
        token = first.json()["token"]
        assert token

        second = client.post("/api/passport/share")
        assert second.status_code == 201
        assert second.json()["token"] == token

    def test_public_summary_exposes_stats_and_badges(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )
        _seed_going(
            engine,
            user_id,
            "e2",
            NOW - timedelta(days=10),
            city="Berlin",
            country="Germany",
        )
        # Unlock milestones for the owner via the authed passport read.
        client.get("/api/passport")

        token = client.post("/api/passport/share").json()["token"]

        resp = client.get(f"/api/passport/shared/{token}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["stats"]["total_events_attended"] == 2
        assert body["stats"]["cities_visited"] == 2
        assert body["stats"]["countries_visited"] == 2
        assert body["display_name"] == "dancer"  # email local part fallback
        unlocked_keys = {m["key"] for m in body["milestones"] if m["unlocked"]}
        assert "first_event" in unlocked_keys

    def test_public_summary_leaks_no_private_data(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )
        client.get("/api/passport")
        token = client.post("/api/passport/share").json()["token"]

        body = client.get(f"/api/passport/shared/{token}").json()

        # The shared surface reuses the owner-facing schemas (stats, collections,
        # milestones, map events) but never the private timeline or the owner's
        # email/full name. Timeline is opt-in (off by default) so its arrays are
        # present-but-empty.
        assert set(body.keys()) == {
            "display_name",
            "stats",
            "collections",
            "milestones",
            "events",
            "sections",
            "timeline_items",
            "timeline_markers",
            "handle",
            "is_self",
            "is_following",
        }
        assert body["timeline_items"] == []
        assert body["timeline_markers"] == []
        assert "@" not in (body["display_name"] or "")

    def test_shared_honors_section_toggles(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )
        client.get("/api/passport")
        # Owner hides badges + cities + countries, opts INTO timeline.
        with Session(engine) as s:
            owner = s.get(User, user_id)
            owner.passport_show_badges = False
            owner.passport_show_cities = False
            owner.passport_show_countries = False
            owner.passport_show_timeline = True
            s.add(owner)
            s.commit()
        token = client.post("/api/passport/share").json()["token"]

        body = client.get(f"/api/passport/shared/{token}").json()

        assert body["sections"] == ["timeline"]
        # Hidden sections leak nothing (no milestones, no map events, no place list).
        assert body["milestones"] == []
        assert body["events"] == []
        assert body["collections"]["cities"] == []
        assert body["collections"]["countries"] == []
        # Opted-in timeline is populated.
        assert len(body["timeline_items"]) == 1
        # Stats are always shown regardless of toggles.
        assert body["stats"]["total_events_attended"] == 1

    def test_public_summary_unknown_token_is_404(self, client_with_user):
        client, _engine, _user_id = client_with_user

        resp = client.get("/api/passport/shared/does-not-exist")

        assert resp.status_code == 404

    def test_shared_timeline_softens_location_to_city_country(self, client_with_user):
        client, engine, user_id = client_with_user
        _seed_going(
            engine,
            user_id,
            "e1",
            NOW - timedelta(days=30),
            city="Paris",
            country="France",
        )
        client.get("/api/passport")
        with Session(engine) as s:
            owner = s.get(User, user_id)
            owner.passport_show_timeline = True
            s.add(owner)
            s.commit()
        token = client.post("/api/passport/share").json()["token"]

        item = client.get(f"/api/passport/shared/{token}").json()["timeline_items"][0]

        # City-level only — never the exact venue or coordinates.
        assert item["location"] == "Paris, France"
        assert item["latitude"] is None
        assert item["longitude"] is None

    def test_share_require_signin_flag_persists_and_echoes(self, client_with_user):
        client, _engine, _user_id = client_with_user

        first = client.post("/api/passport/share", json={"require_signin": True}).json()
        assert first["require_signin"] is True
        # Re-minting with a new value flips the flag on the existing token.
        second = client.post(
            "/api/passport/share", json={"require_signin": False}
        ).json()
        assert second["token"] == first["token"]
        assert second["require_signin"] is False

    def test_shared_require_signin_blocks_anonymous(self, client_with_user):
        client, _engine, _user_id = client_with_user
        token = client.post(
            "/api/passport/share", json={"require_signin": True}
        ).json()["token"]

        resp = client.get(f"/api/passport/shared/{token}")

        assert resp.status_code == 401

    def test_shared_require_signin_allows_signed_in_viewer(self, client_with_user):
        client, engine, user_id = client_with_user
        token = client.post(
            "/api/passport/share", json={"require_signin": True}
        ).json()["token"]

        # A second, signed-in viewer resolves the gated link.
        with Session(engine) as s:
            viewer = User(email="viewer@example.com")
            s.add(viewer)
            s.commit()
            s.refresh(viewer)
            viewer_id = viewer.id

        def _override_optional():
            with Session(engine) as session:
                return session.get(User, viewer_id)

        app.dependency_overrides[get_current_user_optional] = _override_optional
        try:
            body = client.get(f"/api/passport/shared/{token}").json()
        finally:
            app.dependency_overrides.pop(get_current_user_optional, None)

        assert body["is_self"] is False
        assert body["is_following"] is False

    def test_shared_is_self_for_owner_viewer(self, client_with_user):
        client, engine, user_id = client_with_user
        token = client.post("/api/passport/share").json()["token"]

        def _override_optional():
            with Session(engine) as session:
                return session.get(User, user_id)

        app.dependency_overrides[get_current_user_optional] = _override_optional
        try:
            body = client.get(f"/api/passport/shared/{token}").json()
        finally:
            app.dependency_overrides.pop(get_current_user_optional, None)

        assert body["is_self"] is True
