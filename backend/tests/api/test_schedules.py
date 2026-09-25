import os
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-event-schedules")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    NotificationDelivery,
    SiteSetting,
    User,
    UserEventAttendance,
)


@pytest.fixture
def engine():
    value = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(value)
    yield value
    SQLModel.metadata.drop_all(value)


@pytest.fixture
def client(engine):
    auth_module.limiter.reset()

    def _override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = _override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def schedule_event(engine):
    with Session(engine) as session:
        session.add(SiteSetting(key="event_schedule_enabled", value="true"))
        session.add(
            CalendarSetting(
                calendar_id="festivals",
                name="Festivals",
                enabled=True,
                show_events=True,
            )
        )
        session.add(
            CachedEvent(
                event_id="back-2-mambo-2026",
                calendar_id="festivals",
                title="Back 2 Mambo 2026",
                location="Prague, Czech Republic",
                start=datetime(2026, 10, 15, 8),
                end=datetime(2026, 10, 20, 3),
                review_status="reviewed",
            )
        )
        session.commit()


def _login(client: TestClient, email: str) -> None:
    response = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )
    assert response.status_code == 200


def test_schedule_publish_and_my_plan_lifecycle(
    client, engine, schedule_event, monkeypatch
):
    emailed: list[str] = []
    pushed: list[str] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_plan_changed_email",
        lambda user, event, changes: emailed.append(user.email) or True,
        raising=False,
    )
    monkeypatch.setattr(
        "backend.services.push_service.send_push",
        lambda user_id, **kwargs: pushed.append(str(user_id)) or 1,
    )
    _login(client, "admin@example.com")

    created = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule",
        json={
            "timezone": "Europe/Prague",
            "day_start_hour": 6,
            "days": ["2026-10-15", "2026-10-16", "2026-10-17"],
        },
    )
    assert created.status_code == 201
    assert [row["name"] for row in created.json()["activity_types"]][:3] == [
        "Workshop",
        "Bootcamp",
        "Social",
    ]
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 404

    venue = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/venues",
        json={"name": "Slovanský dům", "address": "Prague"},
    ).json()
    room = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/rooms",
        json={"name": "Grand Hall", "venue_id": venue["id"], "color": "amber"},
    ).json()
    level = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/levels",
        json={"label": "Open Level", "notation": "*"},
    ).json()
    activity_type_id = created.json()["activity_types"][0]["id"]

    first = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/sessions",
        json={
            "title": "Shines / Partnerwork",
            "instructors": "Jemís & Dyanna",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
            "room_id": room["id"],
            "venue_id": venue["id"],
            "level_id": level["id"],
            "activity_type_id": activity_type_id,
        },
    )
    assert first.status_code == 201
    assert first.json()["start"] == "2026-10-16T12:00:00Z"
    assert first.json()["end"] == "2026-10-16T13:00:00Z"
    session_id = first.json()["id"]
    second = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/sessions",
        json={
            "title": "Musicality Lab",
            "start": "2026-10-16T12:30:00Z",
            "end": "2026-10-16T13:30:00Z",
            "room_id": room["id"],
            "venue_id": venue["id"],
            "activity_type_id": activity_type_id,
        },
    )
    assert second.status_code == 201

    draft = client.get("/api/admin/events/back-2-mambo-2026/schedule")
    assert draft.status_code == 200
    assert any(issue["code"] == "room_overlap" for issue in draft.json()["issues"])

    published = client.post("/api/admin/events/back-2-mambo-2026/schedule/publish")
    assert published.status_code == 200
    assert published.json()["version"] == 1

    listed = client.get("/api/events")
    assert listed.status_code == 200
    listed_event = next(
        row for row in listed.json() if row["event_id"] == "back-2-mambo-2026"
    )
    assert listed_event["schedule_published"] is True

    batched = client.post(
        "/api/events/by-ids", json={"event_ids": ["back-2-mambo-2026"]}
    )
    assert batched.status_code == 200
    assert batched.json()[0]["schedule_published"] is True

    changed = client.patch(
        f"/api/admin/events/back-2-mambo-2026/schedule/sessions/{session_id}",
        json={"title": "Draft title"},
    )
    assert changed.status_code == 200
    public = client.get("/api/events/back-2-mambo-2026/schedule")
    assert public.status_code == 200
    public_session = next(
        row for row in public.json()["sessions"] if row["id"] == session_id
    )
    assert public_session["title"] == "Shines / Partnerwork"
    assert public_session["start"] == "2026-10-16T12:00:00Z"

    legacy_export = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/export"
    ).json()
    round_trip = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import",
        json={"mode": "merge", "document": legacy_export},
    )
    assert round_trip.status_code == 200
    assert round_trip.json()["operations"]["created"] == 0
    assert (
        len(
            client.get("/api/admin/events/back-2-mambo-2026/schedule").json()[
                "sessions"
            ]
        )
        == 2
    )

    client.cookies.clear()
    assert client.get("/api/events/back-2-mambo-2026/my-plan").status_code == 401
    _login(client, "dancer@example.com")
    saved = client.put(f"/api/events/back-2-mambo-2026/my-plan/{session_id}")
    assert saved.status_code == 201
    assert saved.json()["status"] == "active"

    _login(client, "admin@example.com")
    assert (
        client.delete(
            f"/api/admin/events/back-2-mambo-2026/schedule/sessions/{session_id}"
        ).status_code
        == 204
    )
    republished = client.post("/api/admin/events/back-2-mambo-2026/schedule/publish")
    assert republished.status_code == 200
    assert republished.json()["notification_summary"] == {
        "impacted_planners": 1,
        "in_app_created": 1,
        "emailed": 1,
        "pushed": 1,
        "going_attendees": 0,
        "remaining_going_attendees": 0,
    }
    assert emailed == ["dancer@example.com"]
    assert len(pushed) == 1

    _login(client, "dancer@example.com")
    plan = client.get("/api/events/back-2-mambo-2026/my-plan")
    assert plan.status_code == 200
    assert plan.json()["entries"][0]["status"] == "removed"
    assert plan.json()["entries"][0]["session"]["title"] == "Shines / Partnerwork"
    notifications = client.get("/api/notifications").json()["items"]
    schedule_notice = next(
        row for row in notifications if row["kind"] == "planned_session_changed"
    )
    assert schedule_notice["schedule_session_id"] == session_id
    assert "removed from the program" in schedule_notice["description"]


def test_schedule_json_import_preview_merge_and_replace(client, schedule_event):
    _login(client, "admin@example.com")
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule",
            json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
        ).status_code
        == 201
    )
    document = {
        "schema_version": 1,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Prague",
        "day_start_hour": 6,
        "days": ["2026-10-16"],
        "venues": [{"external_id": "slovansky", "name": "Slovanský dům"}],
        "rooms": [
            {
                "external_id": "grand",
                "name": "Grand Hall",
                "venue_external_id": "slovansky",
                "color": "amber",
            }
        ],
        "levels": [{"external_id": "open", "label": "Open Level", "notation": "*"}],
        "activity_types": [
            {"external_id": "workshop", "name": "Workshop", "color": "blue"}
        ],
        "sessions": [
            {
                "external_id": "fri-shines",
                "title": "Shines / Partnerwork",
                "instructors": "Jemís & Dyanna",
                "start": "2026-10-16T14:00:00",
                "end": "2026-10-16T15:00:00",
                "room_external_id": "grand",
                "venue_external_id": "slovansky",
                "level_external_id": "open",
                "activity_type_external_id": "workshop",
            }
        ],
    }
    schema_response = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/import-schema"
    )
    assert schema_response.status_code == 200
    example = schema_response.json()["example"]
    assert example["event_id"] == "back-2-mambo-2026"
    assert example["days"] == ["2026-10-16"]
    assert example["sessions"][0]["external_id"] == "sample-welcome-class"
    assert (
        example
        != client.get("/api/admin/events/back-2-mambo-2026/schedule/export").json()
    )
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/import-preview",
            json={"mode": "merge", "document": example},
        ).status_code
        == 200
    )
    preview = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import-preview",
        json={"mode": "merge", "document": document},
    )
    assert preview.status_code == 200
    assert preview.json()["operations"]["created"] == 4
    assert (
        client.get("/api/admin/events/back-2-mambo-2026/schedule").json()["sessions"]
        == []
    )

    applied = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import",
        json={"mode": "merge", "document": document},
    )
    assert applied.status_code == 200
    assert applied.json()["operations"]["created"] == 4
    exported = client.get("/api/admin/events/back-2-mambo-2026/schedule/export")
    assert exported.status_code == 200
    assert exported.json()["sessions"][0]["start"] == "2026-10-16T14:00:00"
    assert exported.json()["sessions"][0]["external_id"] == "fri-shines"

    repeated = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import",
        json={"mode": "merge", "document": document},
    )
    assert repeated.status_code == 200
    assert repeated.json()["operations"]["created"] == 0
    assert repeated.json()["operations"]["updated"] == 0

    without_sessions = {**document, "sessions": []}
    replaced = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import",
        json={"mode": "replace", "document": without_sessions},
    )
    assert replaced.status_code == 200
    assert replaced.json()["operations"]["removed"] == 1
    assert (
        client.get("/api/admin/events/back-2-mambo-2026/schedule").json()["sessions"]
        == []
    )


def test_schedule_json_import_rejects_unknown_reference_without_writes(
    client, schedule_event
):
    _login(client, "admin@example.com")
    client.post(
        "/api/admin/events/back-2-mambo-2026/schedule",
        json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
    )
    document = {
        "schema_version": 1,
        "timezone": "Europe/Prague",
        "days": ["2026-10-16"],
        "sessions": [
            {
                "external_id": "bad",
                "title": "Bad reference",
                "start": "2026-10-16T14:00:00",
                "end": "2026-10-16T15:00:00",
                "room_external_id": "missing-room",
            }
        ],
    }
    response = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import-preview",
        json={"mode": "merge", "document": document},
    )
    assert response.status_code == 422
    assert (
        client.get("/api/admin/events/back-2-mambo-2026/schedule").json()["sessions"]
        == []
    )


def test_dance_taxonomy_preset_is_idempotent_and_preserves_custom_levels(
    client, schedule_event
):
    _login(client, "admin@example.com")
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule",
            json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/levels",
            json={"label": "Beginner", "notation": "Intro", "sort_order": 9},
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/levels",
            json={"label": "Invitational", "notation": None, "sort_order": 10},
        ).status_code
        == 201
    )

    first = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/presets/dance-taxonomy"
    )
    assert first.status_code == 200
    assert first.json() == {"created": 3}
    levels = client.get("/api/admin/events/back-2-mambo-2026/schedule").json()["levels"]
    assert {row["label"] for row in levels} == {
        "Open Level",
        "Beginner",
        "Intermediate",
        "Advanced",
        "Invitational",
    }
    assert (
        next(row for row in levels if row["label"] == "Beginner")["notation"] == "Intro"
    )

    second = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/presets/dance-taxonomy"
    )
    assert second.status_code == 200
    assert second.json() == {"created": 0}


def test_program_announcement_targets_going_users_and_respects_opt_outs(
    client, engine, schedule_event, monkeypatch
):
    emailed: list[str] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count: emailed.append(user.email) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    _login(client, "admin@example.com")
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule",
            json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
        ).status_code
        == 201
    )

    _login(client, "dancer@example.com")
    _login(client, "quiet@example.com")
    with Session(engine) as session:
        dancer = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        quiet = session.exec(
            select(User).where(User.email == "quiet@example.com")
        ).one()
        quiet.email_schedule_updates_enabled = False
        quiet.push_schedule_updates_enabled = False
        session.add(quiet)
        session.add(
            UserEventAttendance(
                device_id="dancer-device",
                event_id="back-2-mambo-2026",
                user_id=dancer.id,
            )
        )
        session.add(
            UserEventAttendance(
                device_id="quiet-device", event_id="back-2-mambo-2026", user_id=quiet.id
            )
        )
        session.commit()
        dancer_id = dancer.id
        quiet_id = quiet.id

    _login(client, "admin@example.com")
    unpublished = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/notify-program",
        json={"user_ids": [str(dancer_id)]},
    )
    assert unpublished.status_code == 409
    assert (
        client.post("/api/admin/events/back-2-mambo-2026/schedule/publish").status_code
        == 200
    )

    candidates = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/notify-program-candidates"
    )
    assert candidates.status_code == 200
    candidate_by_email = {row["email"]: row for row in candidates.json()}
    assert set(candidate_by_email) == {"dancer@example.com", "quiet@example.com"}
    assert candidate_by_email["quiet@example.com"]["email_enabled"] is False

    sent = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/notify-program",
        json={"user_ids": [str(dancer_id), str(quiet_id)]},
    )
    assert sent.status_code == 200, sent.text
    assert sent.json()["in_app_created"] == 2
    assert sent.json()["emailed"] == 1
    result_by_email = {row["email"]: row for row in sent.json()["results"]}
    assert result_by_email["dancer@example.com"]["email_status"] == "sent"
    assert result_by_email["quiet@example.com"]["email_status"] == "disabled"
    assert result_by_email["quiet@example.com"]["push_status"] == "disabled"
    assert emailed == ["dancer@example.com"]

    repeated = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/notify-program",
        json={"user_ids": [str(dancer_id), str(quiet_id)]},
    )
    assert repeated.status_code == 200
    assert repeated.json()["in_app_created"] == 0
    assert repeated.json()["emailed"] == 0

    publication_send = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publications/1/notify-going"
    )
    assert publication_send.status_code == 200
    assert publication_send.json()["in_app_created"] == 2
    assert publication_send.json()["emailed"] == 1
    publication_results = {
        row["email"]: row for row in publication_send.json()["results"]
    }
    assert publication_results["quiet@example.com"]["email_status"] == "disabled"
    assert publication_results["quiet@example.com"]["push_status"] == "disabled"

    publication_repeated = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publications/1/notify-going"
    )
    assert publication_repeated.status_code == 200
    assert publication_repeated.json()["in_app_created"] == 0
    assert publication_repeated.json()["emailed"] == 0

    with Session(engine) as session:
        deliveries = session.exec(select(NotificationDelivery)).all()
        assert [row.channel for row in deliveries].count("app") == 4
        assert [row.channel for row in deliveries].count("email") == 2

    _login(client, "dancer@example.com")
    notifications = client.get("/api/notifications")
    assert notifications.status_code == 200
    item = next(
        row
        for row in notifications.json()["items"]
        if row["kind"] == "schedule_program_available"
    )
    assert item["event_id"] == "back-2-mambo-2026"
    assert (
        item["description"]
        == "The program is live. Browse sessions and build your plan."
    )
