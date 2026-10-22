import os
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

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
    Notification,
    NotificationDelivery,
    SchedulePublication,
    SiteSetting,
    User,
    UserEventAttendance,
    UserFollow,
    UserPlanAudience,
    UserPlanSession,
)
from backend.services.notifications import reconcile_plan_activity_notifications  # noqa: E402
from backend.services.schedules import compute_change_details  # noqa: E402


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
def run_jobs(engine, monkeypatch):
    """Capture queued publication jobs; calling the fixture runs them on the test DB."""
    from backend.api.routes import schedules as schedules_module
    from backend.db import database
    from backend.services import job_queue

    queued: list = []

    def _enqueue(name, key, delay=0):
        if name == schedules_module.PUBLICATION_DELIVERY_JOB:
            queued.append((name, key))

    monkeypatch.setattr(job_queue, "enqueue", _enqueue)
    monkeypatch.setattr(database, "_engine", engine)

    def _run() -> list:
        ran = list(queued)
        queued.clear()
        for name, key in ran:
            job_queue.run_job(name, key)
        return ran

    return _run


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


def test_plan_activity_reconciles_attending_followers(engine, schedule_event):
    with Session(engine) as session:
        # Plan activity is only fanned out for upcoming events; keep this one in the future.
        event = session.get(CachedEvent, "back-2-mambo-2026")
        event.start = datetime.now(timezone.utc) + timedelta(days=5)
        event.end = event.start + timedelta(days=5)
        session.add(event)
        users = {
            handle: User(
                email=f"{handle}@example.com",
                display_name=handle.title(),
                handle=handle,
            )
            for handle in ("alice", "bob", "carol", "erin", "frank")
        }
        session.add_all(users.values())
        session.flush()
        session.add_all(
            [
                UserFollow(
                    follower_id=users["bob"].id,
                    followee_id=users["alice"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["carol"].id,
                    followee_id=users["alice"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["alice"].id,
                    followee_id=users["carol"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["erin"].id,
                    followee_id=users["alice"].id,
                    status="pending",
                ),
                UserFollow(
                    follower_id=users["frank"].id,
                    followee_id=users["alice"].id,
                    status="approved",
                ),
            ]
        )
        session.add_all(
            [
                UserEventAttendance(
                    device_id=f"device-{handle}",
                    event_id="back-2-mambo-2026",
                    user_id=users[handle].id,
                )
                for handle in ("bob", "carol", "erin")
            ]
        )
        first_session_id = uuid4()
        session.add(
            UserPlanSession(
                user_id=users["alice"].id,
                session_id=first_session_id,
                event_id="back-2-mambo-2026",
                last_known_session={"id": str(first_session_id), "title": "Shines"},
            )
        )
        audience = UserPlanAudience(
            user_id=users["alice"].id,
            event_id="back-2-mambo-2026",
            audience="followers",
        )
        session.add(audience)
        session.flush()

        rows = reconcile_plan_activity_notifications(
            session, users["alice"], "back-2-mambo-2026", alert=True
        )
        assert {row.recipient_user_id for row in rows} == {
            users["bob"].id,
            users["carol"].id,
        }
        original_ids = {row.recipient_user_id: row.id for row in rows}

        second_session_id = uuid4()
        session.add(
            UserPlanSession(
                user_id=users["alice"].id,
                session_id=second_session_id,
                event_id="back-2-mambo-2026",
                last_known_session={
                    "id": str(second_session_id),
                    "title": "Musicality Lab",
                },
            )
        )
        session.flush()
        updated = reconcile_plan_activity_notifications(
            session, users["alice"], "back-2-mambo-2026", alert=True
        )
        assert {row.recipient_user_id: row.id for row in updated} == original_ids
        assert {row.context for row in updated} == {"Musicality Lab"}
        assert {row.description for row in updated} == {"2 sessions planned"}

        audience.audience = "friends"
        session.add(audience)
        session.flush()
        friends = reconcile_plan_activity_notifications(
            session, users["alice"], "back-2-mambo-2026", alert=False
        )
        assert [row.recipient_user_id for row in friends] == [users["carol"].id]

        audience.audience = "private"
        session.add(audience)
        session.flush()
        assert not reconcile_plan_activity_notifications(
            session, users["alice"], "back-2-mambo-2026", alert=False
        )
        assert not session.exec(
            select(Notification).where(Notification.kind == "plan_session_added")
        ).all()


def test_session_attendance_is_filtered_by_plan_audience(
    client, engine, schedule_event
):
    session_id = uuid4()
    cancelled_session_id = uuid4()
    with Session(engine) as session:
        from backend.db.models import EventSchedule

        schedule = EventSchedule(
            event_id="back-2-mambo-2026",
            timezone="Europe/Prague",
            day_start_hour=6,
            days=["2026-10-16"],
        )
        session.add(schedule)
        session.flush()
        session.add(
            SchedulePublication(
                schedule_id=schedule.id,
                version=1,
                snapshot={
                    "sessions": [
                        {
                            "id": str(session_id),
                            "title": "Musicality",
                            "is_cancelled": False,
                        },
                        {
                            "id": str(cancelled_session_id),
                            "title": "Cancelled",
                            "is_cancelled": True,
                        },
                    ]
                },
            )
        )
        users = {
            handle: User(
                email=f"{handle}@example.com",
                display_name=handle.title(),
                handle=handle,
            )
            for handle in (
                "viewer",
                "follower",
                "follower2",
                "follower3",
                "friend",
                "private",
            )
        }
        session.add_all(users.values())
        session.flush()
        session.add_all(
            [
                UserFollow(
                    follower_id=users["viewer"].id,
                    followee_id=users["follower"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["viewer"].id,
                    followee_id=users["follower2"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["viewer"].id,
                    followee_id=users["follower3"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["viewer"].id,
                    followee_id=users["friend"].id,
                    status="approved",
                ),
                UserFollow(
                    follower_id=users["friend"].id,
                    followee_id=users["viewer"].id,
                    status="approved",
                ),
            ]
        )
        for user in users.values():
            session.add(
                UserPlanSession(
                    user_id=user.id,
                    session_id=session_id,
                    event_id="back-2-mambo-2026",
                    last_known_session={"id": str(session_id), "title": "Musicality"},
                )
            )
        session.add_all(
            [
                UserPlanAudience(
                    user_id=users["viewer"].id,
                    event_id="back-2-mambo-2026",
                    audience="private",
                ),
                UserPlanAudience(
                    user_id=users["follower"].id,
                    event_id="back-2-mambo-2026",
                    audience="followers",
                ),
                UserPlanAudience(
                    user_id=users["follower2"].id,
                    event_id="back-2-mambo-2026",
                    audience="followers",
                ),
                UserPlanAudience(
                    user_id=users["follower3"].id,
                    event_id="back-2-mambo-2026",
                    audience="followers",
                ),
                UserPlanAudience(
                    user_id=users["friend"].id,
                    event_id="back-2-mambo-2026",
                    audience="friends",
                ),
                UserPlanAudience(
                    user_id=users["private"].id,
                    event_id="back-2-mambo-2026",
                    audience="private",
                ),
            ]
        )
        session.commit()

    _login(client, "viewer@example.com")
    summary = client.get("/api/events/back-2-mambo-2026/schedule/attendance-summary")
    assert summary.status_code == 200
    assert summary.headers["cache-control"] == "private, no-store"
    assert summary.json()["sessions"][0]["visible_count"] == 5
    assert [
        row["handle"] for row in summary.json()["sessions"][0]["preview_attendees"]
    ] == [
        "viewer",
        "friend",
        "follower",
    ]

    session_summary = client.get(
        f"/api/events/back-2-mambo-2026/schedule/sessions/{session_id}/attendance-summary"
    )
    assert session_summary.status_code == 200
    assert [row["handle"] for row in session_summary.json()["preview_attendees"]] == [
        "viewer",
        "friend",
        "follower",
        "follower2",
        "follower3",
    ]

    attendees = client.get(
        f"/api/events/back-2-mambo-2026/schedule/sessions/{session_id}/attendees"
    )
    assert attendees.status_code == 200
    assert len(attendees.json()) == 5
    assert (
        client.get(
            f"/api/events/back-2-mambo-2026/schedule/sessions/{cancelled_session_id}/attendees"
        ).status_code
        == 404
    )


def test_event_organizer_edits_the_program_without_a_grant(
    client, engine, schedule_event
):
    _login(client, "organizer@example.com")
    with Session(engine) as session:
        organizer = session.exec(
            select(User).where(User.email == "organizer@example.com")
        ).one()
        event = session.get(CachedEvent, "back-2-mambo-2026")
        event.organizer_user_id = organizer.id
        session.add(event)
        session.commit()

    base = "/api/admin/events/back-2-mambo-2026/schedule"
    access_url = "/api/events/back-2-mambo-2026/schedule/editor-access"
    assert client.get(access_url).json() == {"can_edit": True}
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    assert client.post(f"{base}/publish", json={}).status_code == 200
    assert client.post(f"{base}/unpublish").status_code == 200
    assert client.get(access_url).json() == {"can_edit": True}
    assert client.get(f"{base}/editors").status_code == 403

    _login(client, "admin@example.com")
    [listed] = client.get(f"{base}/editors").json()
    assert listed["email"] == "organizer@example.com"
    assert listed["is_organizer"] is True

    _login(client, "outsider@example.com")
    assert client.get(access_url).json() == {"can_edit": False}


def test_admin_deletes_program_after_typing_the_event_title(
    client, engine, schedule_event
):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    room = client.post(f"{base}/rooms", json={"name": "Hall"}).json()
    created = client.post(
        f"{base}/sessions",
        json={
            "title": "Workshop",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
            "room_id": room["id"],
        },
    ).json()
    assert client.post(f"{base}/publish", json={}).status_code == 200
    with Session(engine) as session:
        admin = session.exec(
            select(User).where(User.email == "admin@example.com")
        ).one()
        session.add(
            UserPlanSession(
                user_id=admin.id,
                session_id=UUID(created["id"]),
                event_id="back-2-mambo-2026",
                last_known_session={"id": created["id"], "title": "Workshop"},
            )
        )
        session.commit()

    assert client.delete(base, params={"confirm_title": "wrong"}).status_code == 422
    assert (
        client.delete(base, params={"confirm_title": " back 2 mambo 2026 "}).status_code
        == 204
    )
    assert client.get(base).status_code == 404
    assert client.get("/api/events/back-2-mambo-2026").status_code == 200
    with Session(engine) as session:
        assert not session.exec(select(UserPlanSession)).all()
        assert not session.exec(select(SchedulePublication)).all()


def test_event_schedule_editor_grants_are_scoped_and_revocable(
    client, engine, schedule_event
):
    with Session(engine) as session:
        session.add(
            CachedEvent(
                event_id="other-festival-2026",
                calendar_id="festivals",
                title="Other Festival 2026",
                location="Vienna, Austria",
                start=datetime(2026, 11, 1, 8),
                end=datetime(2026, 11, 2, 3),
                review_status="reviewed",
            )
        )
        session.commit()

    for email in (
        "editor@example.com",
        "second-editor@example.com",
        "outsider@example.com",
    ):
        _login(client, email)
    with Session(engine) as session:
        users = {
            user.email: user.id
            for user in session.exec(
                select(User).where(
                    User.email.in_(
                        [
                            "editor@example.com",
                            "second-editor@example.com",
                            "outsider@example.com",
                        ]
                    )
                )
            ).all()
        }

    client.cookies.clear()
    assert client.get(
        "/api/events/back-2-mambo-2026/schedule/editor-access"
    ).json() == {"can_edit": False}
    assert client.get("/api/admin/events/back-2-mambo-2026/schedule").status_code == 401

    _login(client, "admin@example.com")
    for event_id in ("back-2-mambo-2026", "other-festival-2026"):
        assert (
            client.post(
                f"/api/admin/events/{event_id}/schedule",
                json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
            ).status_code
            == 201
        )
    assert client.get(
        "/api/events/back-2-mambo-2026/schedule/editor-access"
    ).json() == {"can_edit": True}

    for email in ("editor@example.com", "second-editor@example.com"):
        granted = client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/editors",
            json={"user_id": str(users[email])},
        )
        assert granted.status_code == 201
        assert granted.json()["email"] == email
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/editors",
            json={"user_id": str(users["editor@example.com"])},
        ).status_code
        == 409
    )
    listed = client.get("/api/admin/events/back-2-mambo-2026/schedule/editors")
    assert [row["email"] for row in listed.json()] == [
        "editor@example.com",
        "second-editor@example.com",
    ]
    assert (
        client.delete(
            "/api/admin/events/back-2-mambo-2026/schedule/editors/"
            f"{users['second-editor@example.com']}"
        ).status_code
        == 204
    )

    _login(client, "editor@example.com")
    assert client.get(
        "/api/events/back-2-mambo-2026/schedule/editor-access"
    ).json() == {"can_edit": True}
    assert client.get("/api/admin/events/back-2-mambo-2026/schedule").status_code == 200
    assert (
        client.get("/api/admin/events/back-2-mambo-2026/schedule/editors").status_code
        == 403
    )
    assert (
        client.get("/api/admin/events/other-festival-2026/schedule").status_code == 403
    )
    created_session = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/sessions",
        json={
            "title": "Delegated workshop",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
        },
    )
    assert created_session.status_code == 201
    published = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publish", json={}
    )
    assert published.status_code == 200
    assert (
        client.get(
            "/api/admin/events/back-2-mambo-2026/schedule/published-export"
        ).status_code
        == 200
    )
    with Session(engine) as session:
        publication = session.exec(select(SchedulePublication)).one()
        assert publication.published_by_user_id == users["editor@example.com"]

    _login(client, "outsider@example.com")
    assert client.get(
        "/api/events/back-2-mambo-2026/schedule/editor-access"
    ).json() == {"can_edit": False}
    assert client.get("/api/admin/events/back-2-mambo-2026/schedule").status_code == 403
    assert (
        client.get(
            "/api/admin/events/back-2-mambo-2026/schedule/published-export/ics"
        ).status_code
        == 403
    )

    _login(client, "admin@example.com")
    assert (
        client.delete(
            "/api/admin/events/back-2-mambo-2026/schedule/editors/"
            f"{users['editor@example.com']}"
        ).status_code
        == 204
    )
    _login(client, "editor@example.com")
    assert client.get(
        "/api/events/back-2-mambo-2026/schedule/editor-access"
    ).json() == {"can_edit": False}
    assert client.get("/api/admin/events/back-2-mambo-2026/schedule").status_code == 403


def test_schedule_publish_and_my_plan_lifecycle(
    client, engine, schedule_event, monkeypatch, run_jobs
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
    assert [row["label"] for row in created.json()["levels"]] == [
        "Open Level",
        "Beginner",
        "Intermediate",
        "Advanced",
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
    level = created.json()["levels"][0]
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
    published_export = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/published-export",
        params={"days": "2026-10-16"},
    )
    assert published_export.status_code == 200
    exported_session = next(
        row for row in published_export.json()["sessions"] if row["id"] == session_id
    )
    assert exported_session["title"] == "Shines / Partnerwork"
    assert exported_session["room_id"] is not None
    assert published_export.json()["rooms"]
    assert published_export.json()["timezone"] == "Europe/Prague"
    filtered_params = {
        "days": "2026-10-16",
        "instructor": "missing instructor",
        "level_ids": exported_session["level_id"],
        "activity_type_ids": exported_session["activity_type_id"],
        "include_cancelled": False,
    }
    assert (
        client.get(
            "/api/admin/events/back-2-mambo-2026/schedule/published-export",
            params=filtered_params,
        ).json()["sessions"]
        == []
    )
    program_ics = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/published-export/ics",
        params=filtered_params,
    )
    assert program_ics.status_code == 200
    assert program_ics.headers["content-type"].startswith("text/calendar")
    assert "BEGIN:VEVENT" not in program_ics.text
    assert "back-2-mambo-2026-program.ics" in program_ics.headers["content-disposition"]
    program_csv = client.get(
        "/api/admin/events/back-2-mambo-2026/schedule/published-export/csv",
        params=filtered_params,
    )
    assert program_csv.status_code == 200
    assert program_csv.content.startswith(b"\xef\xbb\xbf")
    assert b"Shines / Partnerwork" not in program_csv.content
    assert (
        client.get(
            "/api/admin/events/back-2-mambo-2026/schedule/published-export",
            params={"days": "2026-10-20"},
        ).status_code
        == 422
    )

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
    assert client.get("/api/events/back-2-mambo-2026/my-plan/ics").status_code == 401
    assert (
        client.post(
            "/api/my-plan/counts",
            json={"event_ids": ["back-2-mambo-2026"]},
        ).status_code
        == 401
    )
    _login(client, "dancer@example.com")
    saved = client.put(f"/api/events/back-2-mambo-2026/my-plan/{session_id}")
    assert saved.status_code == 201
    assert saved.json()["status"] == "active"
    plan_counts = client.post(
        "/api/my-plan/counts",
        json={
            "event_ids": [
                "back-2-mambo-2026",
                "event-without-a-plan",
                "back-2-mambo-2026",
            ]
        },
    )
    assert plan_counts.status_code == 200
    assert plan_counts.headers["cache-control"] == "private, no-store"
    assert plan_counts.json() == [
        {"event_id": "back-2-mambo-2026", "plan_count": 1},
        {"event_id": "event-without-a-plan", "plan_count": 0},
    ]
    assert (
        client.get("/api/events/back-2-mambo-2026/my-plan").json()["audience"] is None
    )
    audience = client.put(
        "/api/events/back-2-mambo-2026/my-plan/audience",
        json={"audience": "followers"},
    )
    assert audience.status_code == 200
    assert audience.json()["audience"] == "followers"
    my_plan_ics = client.get("/api/events/back-2-mambo-2026/my-plan/ics")
    assert my_plan_ics.status_code == 200
    assert f"UID:{session_id}@program.joinmovida.com" in my_plan_ics.text
    assert "STATUS:CANCELLED" not in my_plan_ics.text
    assert my_plan_ics.headers["cache-control"] == "private, no-store"
    assert "back-2-mambo-2026-my-plan.ics" in my_plan_ics.headers["content-disposition"]
    assert client.get("/api/events/back-2-mambo-2026/my-plan/share").json() is None
    shared = client.post("/api/events/back-2-mambo-2026/my-plan/share")
    assert shared.status_code == 201
    token = shared.json()["token"]
    assert client.post("/api/events/back-2-mambo-2026/my-plan/share").json() == {
        "token": token
    }
    with Session(engine) as session:
        owner = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        owner.display_name = None
        session.add(owner)
        session.commit()

    client.cookies.clear()
    public_plan = client.get(f"/api/share/plan/{token}")
    assert public_plan.status_code == 200
    assert public_plan.headers["cache-control"] == "no-store"
    assert public_plan.json()["event_title"] == "Back 2 Mambo 2026"
    assert public_plan.json()["owner_display_name"] is None
    assert public_plan.json()["entries"][0]["session_id"] == str(session_id)
    assert "email" not in public_plan.text

    _login(client, "dancer@example.com")
    assert (
        client.delete("/api/events/back-2-mambo-2026/my-plan/share").status_code == 204
    )
    client.cookies.clear()
    assert client.get(f"/api/share/plan/{token}").status_code == 404

    _login(client, "admin@example.com")
    planners = client.get("/api/admin/events/back-2-mambo-2026/schedule/planners")
    assert planners.status_code == 200
    assert planners.json()[0]["email"] == "dancer@example.com"
    assert planners.json()[0]["going"] is False
    assert planners.json()[0]["planned_session_count"] == 1
    assert planners.json()[0]["sessions"][0]["title"] == "Shines / Partnerwork"
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
        "going_attendees_notified": 0,
        "in_app_created": 1,
        "going_attendees": 0,
    }
    assert emailed == [] and pushed == []
    assert ("schedule_publication", "back-2-mambo-2026:2") in run_jobs()
    assert emailed == ["dancer@example.com"]
    assert len(pushed) == 1
    # Re-running the job skips channels already stamped.
    from backend.services import job_queue

    job_queue.run_job("schedule_publication", "back-2-mambo-2026:2")
    assert emailed == ["dancer@example.com"]
    assert len(pushed) == 1

    _login(client, "dancer@example.com")
    plan = client.get("/api/events/back-2-mambo-2026/my-plan")
    assert plan.status_code == 200
    assert plan.json()["entries"][0]["status"] == "removed"
    assert plan.json()["entries"][0]["session"]["title"] == "Shines / Partnerwork"
    assert client.post(
        "/api/my-plan/counts",
        json={"event_ids": ["back-2-mambo-2026"]},
    ).json() == [{"event_id": "back-2-mambo-2026", "plan_count": 0}]
    removed_plan_ics = client.get("/api/events/back-2-mambo-2026/my-plan/ics")
    assert removed_plan_ics.status_code == 200
    assert f"UID:{session_id}@program.joinmovida.com" in removed_plan_ics.text
    assert "STATUS:CANCELLED" in removed_plan_ics.text
    notifications = client.get("/api/notifications").json()["items"]
    schedule_notice = next(
        row for row in notifications if row["kind"] == "planned_session_changed"
    )
    assert schedule_notice["schedule_session_id"] == session_id
    assert "removed from the program" in schedule_notice["description"]

    _login(client, "other-dancer@example.com")
    empty_plan_ics = client.get("/api/events/back-2-mambo-2026/my-plan/ics")
    assert empty_plan_ics.status_code == 200
    assert "BEGIN:VEVENT" not in empty_plan_ics.text
    assert session_id not in empty_plan_ics.text
    assert client.post("/api/events/back-2-mambo-2026/my-plan/share").status_code == 409


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
    assert {
        "entity_type": "session",
        "operation": "create",
        "label": "Shines / Partnerwork",
    }.items() <= next(
        change
        for change in preview.json()["changes"]
        if change["entity_type"] == "session"
    ).items()
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
    removed_changes = [
        change
        for change in replaced.json()["changes"]
        if change["operation"] == "remove"
    ]
    # Replace drops the unused seeded taxonomy too; the room stays (a removed session still references it).
    assert {change["entity_type"] for change in removed_changes} <= {
        "session",
        "activity_type",
        "level",
    }
    removed_change = next(
        change for change in removed_changes if change["entity_type"] == "session"
    )
    assert removed_change["entity_type"] == "session"
    assert removed_change["label"] == "Shines / Partnerwork"
    assert (
        client.get("/api/admin/events/back-2-mambo-2026/schedule").json()["sessions"]
        == []
    )


def test_schedule_import_preview_hides_generated_external_id_backfill(
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
            "/api/admin/events/back-2-mambo-2026/schedule/venues",
            json={"name": "Slovanský dům", "address": "Na Příkopě 22"},
        ).status_code
        == 201
    )
    document = client.get("/api/admin/events/back-2-mambo-2026/schedule/export").json()

    preview = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import-preview",
        json={"mode": "merge", "document": document},
    )

    assert preview.status_code == 200
    assert preview.json()["operations"]["updated"] == 0
    assert preview.json()["changes"] == []


def test_schedule_change_details_render_contributor_names_and_roles():
    previous = {
        "contributors": [{"id": 1, "display_name": "Maya Chen"}],
        "sessions": [
            {
                "id": "session-1",
                "title": "Workshop",
                "contributors": [
                    {"contributor_id": 1, "role": "instructor", "position": 0}
                ],
            }
        ],
    }
    current = {
        "contributors": [{"id": 2, "display_name": "DJ Marta"}],
        "sessions": [
            {
                "id": "session-1",
                "title": "Workshop",
                "contributors": [{"contributor_id": 2, "role": "dj", "position": 0}],
            }
        ],
    }

    session_change = next(
        change
        for change in compute_change_details(current, previous)
        if change["entity_type"] == "session"
    )

    assert session_change["fields"] == [
        {
            "field": "contributors",
            "before": "Maya Chen (instructor)",
            "after": "DJ Marta (dj)",
        }
    ]


def test_schedule_json_import_v2_round_trips_session_contributors(
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
    document = {
        "schema_version": 2,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Prague",
        "day_start_hour": 6,
        "days": ["2026-10-16"],
        "venues": [],
        "rooms": [],
        "levels": [],
        "activity_types": [],
        "contributors": [
            {"external_id": "maya", "display_name": "Maya Chen"},
            {"external_id": "leo", "display_name": "Leo Cruz", "sort_order": 1},
            {"external_id": "dj-marta", "display_name": "DJ Marta", "sort_order": 2},
        ],
        "sessions": [
            {
                "external_id": "social",
                "title": "Afternoon Social",
                "contributors": [],
                "start": "2026-10-16T14:00:00",
                "end": "2026-10-16T15:00:00",
            },
            {
                "external_id": "workshop",
                "title": "Partnerwork",
                "contributors": [
                    {"contributor_external_id": "maya", "role": "instructor"},
                    {"contributor_external_id": "leo", "role": "instructor"},
                ],
                "start": "2026-10-16T15:00:00",
                "end": "2026-10-16T16:00:00",
            },
            {
                "external_id": "party",
                "title": "Evening Party",
                "contributors": [{"contributor_external_id": "dj-marta", "role": "dj"}],
                "start": "2026-10-16T20:00:00",
                "end": "2026-10-16T23:00:00",
            },
        ],
    }

    applied = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/import",
        json={"mode": "replace", "document": document},
    )

    assert applied.status_code == 200
    exported = client.get("/api/admin/events/back-2-mambo-2026/schedule/export").json()
    assert exported["schema_version"] == 2
    assert [row["external_id"] for row in exported["contributors"]] == [
        "maya",
        "leo",
        "dj-marta",
    ]
    sessions = {row["external_id"]: row for row in exported["sessions"]}
    assert sessions["social"]["contributors"] == []
    assert sessions["workshop"]["contributors"] == [
        {"contributor_external_id": "maya", "role": "instructor"},
        {"contributor_external_id": "leo", "role": "instructor"},
    ]
    assert sessions["workshop"]["instructors"] == "Maya Chen & Leo Cruz"
    assert sessions["party"]["contributors"] == [
        {"contributor_external_id": "dj-marta", "role": "dj"}
    ]
    assert sessions["party"]["instructors"] is None


def test_schedule_room_details_descriptions_and_multi_room_sessions(
    client, schedule_event
):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Zagreb", "days": ["2026-11-27"]}
        ).status_code
        == 201
    )
    document = {
        "schema_version": 2,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Zagreb",
        "day_start_hour": 7,
        "days": ["2026-11-27"],
        "rooms": [
            {
                "external_id": "salsa",
                "name": "Salsa Room",
                "details": "Ground floor · Grand Pass only",
                "sort_order": 0,
            },
            {"external_id": "mambo", "name": "Mambo Room", "sort_order": 1},
            {"external_id": "seminar", "name": "Seminar Room", "sort_order": 2},
        ],
        "sessions": [
            {
                "external_id": "social",
                "title": "Afternoon Social",
                "description": "Open floor for everyone.",
                "start": "2026-11-27T17:00:00",
                "end": "2026-11-27T20:00:00",
                "room_external_ids": ["mambo", "salsa"],
            },
            {
                "external_id": "talk",
                "title": "Community Talk",
                "start": "2026-11-27T18:00:00",
                "end": "2026-11-27T19:00:00",
                "room_external_id": "seminar",
            },
        ],
    }
    assert (
        client.post(
            f"{base}/import", json={"mode": "replace", "document": document}
        ).status_code
        == 200
    )

    draft = client.get(base).json()
    rooms = {row["name"]: row for row in draft["rooms"]}
    assert rooms["Salsa Room"]["details"] == "Ground floor · Grand Pass only"
    salsa, mambo, seminar = (
        rooms["Salsa Room"]["id"],
        rooms["Mambo Room"]["id"],
        rooms["Seminar Room"]["id"],
    )
    sessions = {row["title"]: row for row in draft["sessions"]}
    social = sessions["Afternoon Social"]
    assert social["room_ids"] == [salsa, mambo]
    assert social["room_id"] == salsa
    assert social["description"] == "Open floor for everyone."
    assert sessions["Community Talk"]["room_ids"] == [seminar]

    exported = client.get(f"{base}/export").json()
    exported_social = next(
        row for row in exported["sessions"] if row["external_id"] == "social"
    )
    assert exported_social["room_external_ids"] == ["salsa", "mambo"]
    assert exported["rooms"][0]["details"] == "Ground floor · Grand Pass only"
    repeated = client.post(
        f"{base}/import", json={"mode": "merge", "document": exported}
    )
    assert repeated.json()["operations"]["updated"] == 0

    overlapping = client.post(
        f"{base}/sessions",
        json={
            "title": "Mambo Bootcamp",
            "start": "2026-11-27T17:30:00Z",
            "end": "2026-11-27T18:30:00Z",
            "room_ids": [mambo],
        },
    )
    assert overlapping.status_code == 201
    assert overlapping.json()["room_ids"] == [mambo]
    overlap_issues = [
        issue
        for issue in client.get(base).json()["issues"]
        if issue["code"] == "room_overlap"
    ]
    assert len(overlap_issues) == 1
    assert set(overlap_issues[0]["session_ids"]) == {
        social["id"],
        overlapping.json()["id"],
    }

    assert client.delete(f"{base}/rooms/{mambo}").status_code == 409

    legacy = client.patch(f"{base}/sessions/{social['id']}", json={"room_id": seminar})
    assert legacy.status_code == 200
    assert legacy.json()["room_ids"] == [seminar]
    widened = client.patch(
        f"{base}/sessions/{social['id']}", json={"room_ids": [seminar, salsa]}
    )
    assert widened.json()["room_ids"] == [salsa, seminar]
    assert widened.json()["room_id"] == salsa
    assert (
        client.patch(
            f"{base}/sessions/{social['id']}", json={"room_ids": [999999]}
        ).status_code
        == 422
    )

    assert client.post(f"{base}/publish", json={}).status_code == 200
    public = client.get("/api/events/back-2-mambo-2026/schedule").json()
    public_social = next(row for row in public["sessions"] if row["id"] == social["id"])
    assert public_social["room_ids"] == [salsa, seminar]
    assert public_social["description"] == "Open floor for everyone."
    assert public["rooms"][0]["details"] == "Ground floor · Grand Pass only"


def test_schedule_flags_sessions_longer_than_twelve_hours(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    long_session = client.post(
        f"{base}/sessions",
        json={
            "title": "Marathon Social",
            "start": "2026-10-16T20:00:00Z",
            "end": "2026-10-17T14:00:00Z",
        },
    )
    assert long_session.status_code == 201
    short_session = client.post(
        f"{base}/sessions",
        json={
            "title": "Short Workshop",
            "start": "2026-10-16T10:00:00Z",
            "end": "2026-10-16T12:00:00Z",
        },
    )
    assert short_session.status_code == 201

    issues = [
        issue
        for issue in client.get(base).json()["issues"]
        if issue["code"] == "long_duration"
    ]
    assert len(issues) == 1
    assert issues[0]["severity"] == "warning"
    assert issues[0]["session_ids"] == [long_session.json()["id"]]


def test_room_overlap_ignores_cancelled_sessions(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-18"]}
        ).status_code
        == 201
    )
    room = client.post(f"{base}/rooms", json={"name": "Room 5"}).json()
    ids = {}
    for title, start, end in (
        ("Mambo Fusion", "2026-10-18T09:00:00Z", "2026-10-18T11:00:00Z"),
        ("Body Movement", "2026-10-18T10:00:00Z", "2026-10-18T11:00:00Z"),
    ):
        ids[title] = client.post(
            f"{base}/sessions",
            json={"title": title, "start": start, "end": end, "room_id": room["id"]},
        ).json()["id"]

    def overlaps():
        return [
            i for i in client.get(base).json()["issues"] if i["code"] == "room_overlap"
        ]

    assert len(overlaps()) == 1
    assert (
        client.patch(
            f"{base}/sessions/{ids['Mambo Fusion']}", json={"is_cancelled": True}
        ).status_code
        == 200
    )
    assert overlaps() == []


def test_unpublish_hides_program_and_republish_restores_it(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"{base}/sessions",
            json={
                "title": "Workshop",
                "start": "2026-10-16T12:00:00Z",
                "end": "2026-10-16T13:00:00Z",
            },
        ).status_code
        == 201
    )

    # Nothing published yet: there is nothing to unpublish or republish.
    assert client.post(f"{base}/unpublish").status_code == 409
    assert client.post(f"{base}/republish").status_code == 409

    assert client.post(f"{base}/publish", json={}).status_code == 200
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 200

    unpublished = client.post(f"{base}/unpublish")
    assert unpublished.status_code == 200
    assert unpublished.json()["unpublished_at"] is not None
    assert client.get(base).json()["unpublished_at"] is not None
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 404

    event = client.get("/api/events/back-2-mambo-2026").json()
    assert event["schedule_published"] is False
    assert event["schedule_under_work"] is True
    listed = next(
        row
        for row in client.get("/api/events").json()
        if row["event_id"] == "back-2-mambo-2026"
    )
    assert listed["schedule_published"] is False

    assert client.post(f"{base}/republish").status_code == 200
    assert client.get(base).json()["unpublished_at"] is None
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 200
    event = client.get("/api/events/back-2-mambo-2026").json()
    assert event["schedule_published"] is True
    assert event["schedule_under_work"] is False


def test_publishing_while_unpublished_makes_program_live_again(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    assert client.post(f"{base}/publish", json={}).status_code == 200
    assert client.post(f"{base}/unpublish").status_code == 200
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 404

    republished = client.post(f"{base}/publish", json={})
    assert republished.status_code == 200
    assert republished.json()["version"] == 2
    assert client.get("/api/events/back-2-mambo-2026/schedule").status_code == 200
    assert client.get(base).json()["unpublished_at"] is None


def _change(payload: dict, entity_type: str, operation: str) -> dict:
    return next(
        change
        for change in payload["diff"]["changes"]
        if change["entity_type"] == entity_type and change["operation"] == operation
    )


def test_import_rename_onto_an_existing_name_is_resolved_or_explained(
    client, schedule_event
):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    document = {
        "schema_version": 1,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Prague",
        "days": ["2026-10-16"],
        "activity_types": [{"external_id": "party", "name": "Social & Party"}],
    }
    assert (
        client.post(
            f"{base}/import", json={"mode": "merge", "document": document}
        ).status_code
        == 200
    )

    # The seeded, unused "Party" type makes way for the renamed imported one.
    document["activity_types"][0]["name"] = "Party"
    renamed = client.post(
        f"{base}/import", json={"mode": "merge", "document": document}
    )
    assert renamed.status_code == 200
    names = [row["name"] for row in client.get(base).json()["activity_types"]]
    assert names.count("Party") == 1

    # A used duplicate is explained instead of crashing.
    social = next(
        row
        for row in client.get(base).json()["activity_types"]
        if row["name"] == "Social"
    )
    assert (
        client.post(
            f"{base}/sessions",
            json={
                "title": "Social night",
                "start": "2026-10-16T20:00:00Z",
                "end": "2026-10-16T23:00:00Z",
                "activity_type_id": social["id"],
            },
        ).status_code
        == 201
    )
    document["activity_types"][0]["name"] = "Social"
    conflict = client.post(
        f"{base}/import-preview", json={"mode": "merge", "document": document}
    )
    assert conflict.status_code == 422
    assert "already has that name" in conflict.json()["detail"]


def test_revert_change_restores_published_session_state(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    kept = client.post(
        f"{base}/sessions",
        json={
            "title": "Keys for Social Dancing",
            "start": "2026-10-16T20:00:00Z",
            "end": "2026-10-16T22:00:00Z",
        },
    ).json()
    removed = client.post(
        f"{base}/sessions",
        json={
            "title": "Body Movement",
            "start": "2026-10-16T10:00:00Z",
            "end": "2026-10-16T11:00:00Z",
        },
    ).json()
    assert client.post(f"{base}/publish", json={}).status_code == 200

    assert (
        client.patch(
            f"{base}/sessions/{kept['id']}", json={"end": "2026-10-17T21:00:00Z"}
        ).status_code
        == 200
    )
    assert client.delete(f"{base}/sessions/{removed['id']}").status_code == 204
    added = client.post(
        f"{base}/sessions",
        json={
            "title": "Late addition",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
        },
    ).json()
    draft = client.get(base).json()
    update = _change(draft, "session", "update")

    stale = {**update, "fields": [{"field": "end", "before": "x", "after": "y"}]}
    assert client.post(f"{base}/revert-change", json=stale).status_code == 409

    reverted = client.post(f"{base}/revert-change", json=update)
    assert reverted.status_code == 200
    restored = next(
        row for row in reverted.json()["sessions"] if row["id"] == kept["id"]
    )
    assert restored["end"].startswith("2026-10-16T22:00:00")

    reverted = client.post(
        f"{base}/revert-change", json=_change(reverted.json(), "session", "remove")
    )
    assert reverted.status_code == 200
    assert removed["id"] in {row["id"] for row in reverted.json()["sessions"]}

    reverted = client.post(
        f"{base}/revert-change", json=_change(reverted.json(), "session", "create")
    )
    assert reverted.status_code == 200
    assert added["id"] not in {row["id"] for row in reverted.json()["sessions"]}
    assert reverted.json()["diff"]["changes"] == []


def test_import_apply_skips_excluded_changes(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    document = {
        "schema_version": 1,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Prague",
        "day_start_hour": 6,
        "days": ["2026-10-16"],
        "rooms": [{"external_id": "grand", "name": "Grand Hall"}],
        "sessions": [
            {
                "external_id": "keep",
                "title": "Keep me",
                "start": "2026-10-16T14:00:00",
                "end": "2026-10-16T15:00:00",
            },
            {
                "external_id": "skip",
                "title": "Skip me",
                "start": "2026-10-16T16:00:00",
                "end": "2026-10-16T17:00:00",
                "room_external_id": "grand",
            },
        ],
    }
    preview = client.post(
        f"{base}/import-preview", json={"mode": "merge", "document": document}
    ).json()
    skipped = [
        change
        for change in preview["changes"]
        if change["external_id"] in {"skip", "grand"}
    ]
    assert len(skipped) == 2

    applied = client.post(
        f"{base}/import",
        json={"mode": "merge", "document": document, "exclude": skipped},
    )
    assert applied.status_code == 200
    assert (
        applied.json()["operations"]["created"] == preview["operations"]["created"] - 2
    )
    draft = client.get(base).json()
    assert [row["title"] for row in draft["sessions"]] == ["Keep me"]
    assert draft["rooms"] == []

    # A room that a kept session still uses cannot be skipped on its own.
    only_room = [change for change in skipped if change["external_id"] == "grand"]
    document["sessions"][0]["room_external_id"] = "grand"
    conflict = client.post(
        f"{base}/import",
        json={"mode": "merge", "document": document, "exclude": only_room},
    )
    assert conflict.status_code == 409


def test_schedule_diff_ignores_fields_missing_from_older_publications():
    previous = {
        "rooms": [{"id": 1, "name": "Grand Hall"}],
        "sessions": [{"id": "session-1", "title": "Workshop", "room_id": 1}],
    }
    current = {
        "session_color_mode": "room",
        "rooms": [{"id": 1, "name": "Grand Hall", "details": None}],
        "sessions": [
            {
                "id": "session-1",
                "title": "Workshop",
                "room_id": 1,
                "room_ids": [1],
                "description": None,
            }
        ],
        "overview_items": [],
    }

    assert compute_change_details(current, previous) == []


def _overview_document(overview_items):
    document = {
        "schema_version": 2,
        "event_id": "back-2-mambo-2026",
        "timezone": "Europe/Zagreb",
        "day_start_hour": 7,
        "days": ["2026-11-27"],
        "rooms": [{"external_id": "salsa", "name": "Salsa Room", "sort_order": 0}],
        "activity_types": [
            {"external_id": "registration", "name": "Registration"},
            {"external_id": "workshop", "name": "Workshop"},
            {"external_id": "party", "name": "Party"},
            {"external_id": "show", "name": "Show"},
        ],
        "sessions": [
            {
                "external_id": "fri-turns",
                "title": "Turn Technique",
                "start": "2026-11-27T14:00:00",
                "end": "2026-11-27T15:00:00",
                "room_external_ids": ["salsa"],
                "activity_type_external_id": "workshop",
            }
        ],
    }
    if overview_items is not None:
        document["overview_items"] = overview_items
    return document


FRIDAY_OVERVIEW = [
    {
        "external_id": "fri-registration",
        "title": "Registration & Open Office Hours",
        "start": "2026-11-27T13:00:00",
        "end": "2026-11-27T20:30:00",
        "activity_type_external_id": "registration",
    },
    {
        "external_id": "fri-workshops",
        "title": "Workshops",
        "start": "2026-11-27T13:00:00",
        "end": "2026-11-27T17:00:00",
        "activity_type_external_id": "workshop",
        "url": "https://example.com/workshops",
        "opens_detail": True,
    },
    {
        "external_id": "fri-party",
        "title": "Friday Party",
        "subtitle": "All I want for Christmas is ... Salsa!",
        "start": "2026-11-27T22:30:00",
        "end": "2026-11-28T05:00:00",
        "activity_type_external_id": "party",
        "room_external_ids": ["salsa"],
        "opens_detail": True,
    },
    {
        "external_id": "fri-shows",
        "parent_external_id": "fri-party",
        "title": "Artists presentation & Shows",
        "start": "2026-11-28T00:00:00",
        "end": "2026-11-28T00:30:00",
        "activity_type_external_id": "show",
    },
    {
        "external_id": "fri-artist-hour",
        "parent_external_id": "fri-party",
        "title": "Artist hour",
        "start": "2026-11-28T04:30:00",
        "end": "2026-11-28T05:30:00",
    },
]


def test_schedule_overview_items_import_export_and_publish(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    client.post(base, json={"timezone": "Europe/Zagreb", "days": ["2026-11-27"]})

    imported = client.post(
        f"{base}/import",
        json={"mode": "replace", "document": _overview_document(FRIDAY_OVERVIEW)},
    )
    assert imported.status_code == 200, imported.text

    draft = client.get(base).json()
    items = {row["external_id"]: row for row in draft["overview_items"]}
    assert len(items) == 5
    assert items["fri-shows"]["parent_id"] == items["fri-party"]["id"]
    assert items["fri-party"]["room_ids"] == [draft["rooms"][0]["id"]]
    assert items["fri-workshops"]["start"] == "2026-11-27T12:00:00Z"
    issues = {
        (issue["code"], tuple(issue["overview_item_ids"])) for issue in draft["issues"]
    }
    assert ("overview_no_sessions_in_window", (items["fri-party"]["id"],)) in issues
    assert (
        "overview_moment_outside_parent",
        (items["fri-artist-hour"]["id"],),
    ) in issues
    assert not any(
        code == "overview_no_sessions_in_window" and items["fri-workshops"]["id"] in ids
        for code, ids in issues
    )

    exported = client.get(f"{base}/export").json()
    assert exported["overview_items"][3]["parent_external_id"] == "fri-party"
    repeated = client.post(
        f"{base}/import", json={"mode": "merge", "document": exported}
    )
    assert repeated.json()["operations"]["updated"] == 0

    untouched = client.post(
        f"{base}/import",
        json={"mode": "replace", "document": _overview_document(None)},
    )
    assert untouched.json()["operations"]["removed"] == 0
    assert len(client.get(base).json()["overview_items"]) == 5

    publish = client.post(f"{base}/publish", json={})
    assert publish.status_code == 200
    public = client.get("/api/events/back-2-mambo-2026/schedule").json()
    assert [row["title"] for row in public["overview_items"]][:2] == [
        "Registration & Open Office Hours",
        "Workshops",
    ]

    cleared = client.post(
        f"{base}/import",
        json={"mode": "replace", "document": _overview_document([])},
    )
    assert cleared.json()["operations"]["removed"] == 5
    changes = client.get(base).json()["diff"]["changes"]
    assert {
        change["operation"]
        for change in changes
        if change["entity_type"] == "overview_item"
    } == {"remove"}

    nested_too_deep = _overview_document(
        [
            {**FRIDAY_OVERVIEW[2]},
            {**FRIDAY_OVERVIEW[3]},
            {
                **FRIDAY_OVERVIEW[4],
                "parent_external_id": "fri-shows",
            },
        ]
    )
    assert (
        client.post(
            f"{base}/import-preview",
            json={"mode": "merge", "document": nested_too_deep},
        ).status_code
        == 422
    )


def test_schedule_overview_item_admin_crud_and_validation(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    schedule = client.post(
        base, json={"timezone": "Europe/Zagreb", "days": ["2026-11-27"]}
    ).json()
    party_type = next(
        row["id"] for row in schedule["activity_types"] if row["name"] == "Party"
    )
    party = client.post(
        f"{base}/overview-items",
        json={
            "title": "Friday Party",
            "start": "2026-11-27T21:30:00Z",
            "end": "2026-11-28T04:00:00Z",
            "activity_type_id": party_type,
            "opens_detail": True,
        },
    )
    assert party.status_code == 201, party.text
    party_id = party.json()["id"]
    moment = client.post(
        f"{base}/overview-items",
        json={
            "parent_id": party_id,
            "title": "Show performances",
            "start": "2026-11-27T22:30:00Z",
            "end": "2026-11-27T23:15:00Z",
        },
    )
    assert moment.status_code == 201
    moment_id = moment.json()["id"]

    def body(**overrides):
        return {
            "title": "Bad",
            "start": "2026-11-27T22:30:00Z",
            "end": "2026-11-27T23:00:00Z",
            **overrides,
        }

    assert (
        client.post(
            f"{base}/overview-items", json=body(parent_id=moment_id)
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{base}/overview-items", json=body(parent_id=party_id, opens_detail=True)
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{base}/overview-items", json=body(url="javascript:alert(1)")
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"{base}/overview-items/{party_id}",
            json=body(parent_id=moment_id),
        ).status_code
        == 422
    )
    assert client.delete(f"{base}/activity-types/{party_type}").status_code == 409

    renamed = client.put(
        f"{base}/overview-items/{party_id}",
        json={**party.json(), "title": "Friday Gala"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Friday Gala"

    assert client.delete(f"{base}/overview-items/{party_id}").status_code == 204
    assert client.get(base).json()["overview_items"] == []


def test_overview_item_my_plan_lifecycle_and_color_mode(client, schedule_event):
    _login(client, "admin@example.com")
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    schedule = client.post(
        base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
    ).json()
    bootcamp_type = next(
        row["id"] for row in schedule["activity_types"] if row["name"] == "Bootcamp"
    )
    assert (
        client.post(
            f"{base}/rooms", json={"name": "Hall", "color": "chartreuse"}
        ).status_code
        == 422
    )
    assert client.patch(base, json={"session_color_mode": "rainbow"}).status_code == 422
    patched = client.patch(base, json={"session_color_mode": "activity_type_stripe"})
    assert patched.json()["session_color_mode"] == "activity_type_stripe"

    workshop = client.post(
        f"{base}/sessions",
        json={
            "title": "Turn Technique",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
        },
    ).json()

    def overview(**overrides):
        return {
            "title": "Partnerwork Bootcamp",
            "start": "2026-10-16T12:30:00Z",
            "end": "2026-10-16T14:00:00Z",
            "activity_type_id": bootcamp_type,
            "allow_plan": True,
            **overrides,
        }

    bootcamp = client.post(f"{base}/overview-items", json=overview()).json()
    registration = client.post(
        f"{base}/overview-items",
        json=overview(title="Registration", allow_plan=False),
    ).json()
    assert (
        client.post(
            f"{base}/overview-items",
            json=overview(parent_id=bootcamp["id"], title="Break"),
        ).status_code
        == 422
    )
    assert client.post(f"{base}/publish", json={}).status_code == 200
    public = client.get("/api/events/back-2-mambo-2026/schedule").json()
    assert public["session_color_mode"] == "activity_type_stripe"

    _login(client, "dancer@example.com")
    plan_base = "/api/events/back-2-mambo-2026/my-plan"
    assert (
        client.put(f"{plan_base}/overview-items/{registration['id']}").status_code
        == 409
    )
    assert client.put(f"{plan_base}/overview-items/{uuid4()}").status_code == 404
    added = client.put(f"{plan_base}/overview-items/{bootcamp['id']}")
    assert added.status_code == 201
    assert added.json()["kind"] == "overview_item"
    assert added.json()["overview_item"]["title"] == "Partnerwork Bootcamp"
    assert client.put(f"{plan_base}/{workshop['id']}").status_code == 201
    entries = client.get(plan_base).json()["entries"]
    assert [entry["kind"] for entry in entries] == ["overview_item", "session"]
    assert client.post(
        "/api/my-plan/counts", json={"event_ids": ["back-2-mambo-2026"]}
    ).json() == [{"event_id": "back-2-mambo-2026", "plan_count": 2}]
    assert f"UID:{bootcamp['id']}@program.joinmovida.com" in (
        client.get(f"{plan_base}/ics").text
    )
    summary = client.get(
        "/api/events/back-2-mambo-2026/schedule/attendance-summary"
    ).json()
    assert summary["overview_items"] == [
        {
            "overview_item_id": bootcamp["id"],
            "visible_count": 1,
            "preview_attendees": summary["overview_items"][0]["preview_attendees"],
        }
    ]
    assert (
        client.get(
            f"/api/events/back-2-mambo-2026/schedule/overview-items/{bootcamp['id']}/attendance-summary"
        ).json()["visible_count"]
        == 1
    )

    _login(client, "admin@example.com")
    planners = client.get(f"{base}/planners").json()
    assert planners[0]["planned_session_count"] == 2
    assert planners[0]["sessions"][1]["overview_item_id"] == bootcamp["id"]
    moved = client.put(
        f"{base}/overview-items/{bootcamp['id']}",
        json={**bootcamp, "start": "2026-10-16T13:00:00Z"},
    )
    assert moved.status_code == 200
    assert client.post(f"{base}/publish", json={}).status_code == 200

    _login(client, "dancer@example.com")
    notice = next(
        row
        for row in client.get("/api/notifications").json()["items"]
        if row["kind"] == "planned_session_changed"
    )
    assert notice["schedule_overview_item_id"] == bootcamp["id"]
    assert notice["schedule_session_id"] is None
    assert "has a new time" in notice["description"]

    _login(client, "admin@example.com")
    assert client.delete(f"{base}/overview-items/{bootcamp['id']}").status_code == 204
    assert client.post(f"{base}/publish", json={}).status_code == 200

    _login(client, "dancer@example.com")
    entries = client.get(plan_base).json()["entries"]
    assert entries[0]["status"] == "removed"
    assert entries[0]["overview_item"]["title"] == "Partnerwork Bootcamp"
    assert (
        client.delete(f"{plan_base}/overview-items/{bootcamp['id']}").status_code == 204
    )
    assert [entry["kind"] for entry in client.get(plan_base).json()["entries"]] == [
        "session"
    ]


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


def test_publish_announces_first_program_and_optionally_broadcasts_updates(
    client, engine, schedule_event, monkeypatch, run_jobs
):
    emailed: list[str] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count: emailed.append(user.email) or True,
    )
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_updated_email",
        lambda user, event: emailed.append(user.email) or True,
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
    first_publish = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publish", json={}
    )
    assert first_publish.status_code == 200
    assert first_publish.json()["notification_summary"] == {
        "impacted_planners": 0,
        "going_attendees_notified": 2,
        "in_app_created": 2,
        "going_attendees": 2,
    }
    assert emailed == []
    assert run_jobs() == [("schedule_publication", "back-2-mambo-2026:1")]
    assert emailed == ["dancer@example.com"]

    silent_update = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publish", json={}
    )
    assert silent_update.status_code == 200
    assert silent_update.json()["notification_summary"]["going_attendees_notified"] == 0
    assert silent_update.json()["notification_summary"]["in_app_created"] == 0
    assert run_jobs() == []

    broad_update = client.post(
        "/api/admin/events/back-2-mambo-2026/schedule/publish",
        json={"notify_all_going": True},
    )
    assert broad_update.status_code == 200
    assert broad_update.json()["notification_summary"]["going_attendees_notified"] == 2
    assert broad_update.json()["notification_summary"]["in_app_created"] == 2
    assert run_jobs() == [("schedule_publication", "back-2-mambo-2026:3")]
    assert emailed == ["dancer@example.com", "dancer@example.com"]

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
    assert any(
        row["kind"] == "schedule_program_updated"
        for row in notifications.json()["items"]
    )


def test_publish_preview_and_opting_out_of_plan_change_messages(
    client, engine, schedule_event, monkeypatch, run_jobs
):
    pushed: list[dict] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_plan_changed_email",
        lambda user, event, changes: True,
    )
    monkeypatch.setattr(
        "backend.services.push_service.send_push",
        lambda user_id, **kwargs: pushed.append(kwargs) or 1,
    )
    base = "/api/admin/events/back-2-mambo-2026/schedule"
    _login(client, "admin@example.com")
    client.post(base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]})
    session_id = client.post(
        f"{base}/sessions",
        json={
            "title": "Musicality",
            "start": "2026-10-16T12:00:00Z",
            "end": "2026-10-16T13:00:00Z",
        },
    ).json()["id"]
    assert client.get(f"{base}/publish-preview").json() == {
        "impacted_user_ids": [],
        "sample_message": None,
    }
    assert client.post(f"{base}/publish", json={}).status_code == 200

    _login(client, "dancer@example.com")
    assert (
        client.put(f"/api/events/back-2-mambo-2026/my-plan/{session_id}").status_code
        == 201
    )
    with Session(engine) as session:
        dancer_id = session.exec(
            select(User.id).where(User.email == "dancer@example.com")
        ).one()

    _login(client, "admin@example.com")
    client.patch(
        f"{base}/sessions/{session_id}",
        json={"start": "2026-10-16T14:00:00Z", "end": "2026-10-16T15:00:00Z"},
    )
    preview = client.get(f"{base}/publish-preview")
    assert preview.status_code == 200
    assert preview.json() == {
        "impacted_user_ids": [str(dancer_id)],
        "sample_message": "Musicality: has a new time.",
    }

    quiet = client.post(f"{base}/publish", json={"notify_impacted_planners": False})
    assert quiet.json()["notification_summary"]["impacted_planners"] == 0
    with Session(engine) as session:
        assert not session.exec(
            select(Notification).where(Notification.kind == "planned_session_changed")
        ).all()
        plan = session.exec(
            select(UserPlanSession).where(UserPlanSession.user_id == dancer_id)
        ).one()
        assert plan.last_known_session["start"] == "2026-10-16T14:00:00Z"
    assert client.get(f"{base}/publish-preview").json()["impacted_user_ids"] == []

    client.patch(f"{base}/sessions/{session_id}", json={"title": "Musicality Lab"})
    loud = client.post(f"{base}/publish", json={})
    assert loud.json()["notification_summary"]["impacted_planners"] == 1
    run_jobs()
    assert pushed[-1]["title"] == "Your plan changed · Back 2 Mambo 2026"
    assert pushed[-1]["body"] == "Musicality: has updated details."


def test_notify_program_uses_custom_title_and_message(
    client, engine, schedule_event, monkeypatch
):
    sent: list[dict] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count, headline=None, note=None: (
            sent.append({"email": user.email, "headline": headline, "note": note})
            or True
        ),
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    base = "/api/admin/events/back-2-mambo-2026/schedule"
    _login(client, "admin@example.com")
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"{base}/sessions",
            json={
                "title": "Workshop",
                "start": "2026-10-16T12:00:00Z",
                "end": "2026-10-16T13:00:00Z",
            },
        ).status_code
        == 201
    )
    assert client.post(f"{base}/publish", json={}).status_code == 200

    _login(client, "dancer@example.com")
    with Session(engine) as session:
        dancer = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        session.add(
            UserEventAttendance(
                device_id="dancer-device",
                event_id="back-2-mambo-2026",
                user_id=dancer.id,
            )
        )
        session.commit()
        dancer_id = str(dancer.id)

    _login(client, "admin@example.com")
    notify_url = f"{base}/notify-program"
    assert (
        client.post(
            notify_url, json={"user_ids": [dancer_id], "title": "x" * 121}
        ).status_code
        == 422
    )

    response = client.post(
        notify_url,
        json={
            "user_ids": [dancer_id],
            "title": "  Keys open  ",
            "message": "Line one\nLine <b>two</b>",
        },
    )
    assert response.status_code == 200
    assert response.json()["emailed"] == 1
    assert sent == [
        {
            "email": "dancer@example.com",
            "headline": "Keys open",
            "note": "Line one\nLine <b>two</b>",
        }
    ]
    with Session(engine) as session:
        row = session.exec(
            select(Notification).where(
                Notification.kind == "schedule_program_available"
            )
        ).one()
        assert row.description == "Line one\nLine <b>two</b>"

    assert client.post(f"{base}/unpublish").status_code == 200
    assert client.post(notify_url, json={"user_ids": [dancer_id]}).status_code == 409
    assert client.post(f"{base}/republish").status_code == 200


def test_notify_program_includes_plan_holders_who_are_not_going(
    client, engine, schedule_event, monkeypatch
):
    sent: list[dict] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count, headline=None, note=None: (
            sent.append(user.email) or True
        ),
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    base = "/api/admin/events/back-2-mambo-2026/schedule"
    _login(client, "admin@example.com")
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    assert client.post(f"{base}/publish", json={}).status_code == 200

    _login(client, "dancer@example.com")
    overview_item_id = uuid4()
    with Session(engine) as session:
        dancer = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        session.add(
            UserPlanSession(
                user_id=dancer.id,
                overview_item_id=overview_item_id,
                event_id="back-2-mambo-2026",
                last_known_session={"id": str(overview_item_id), "title": "Keys"},
            )
        )
        session.commit()
        dancer_id = str(dancer.id)

    _login(client, "admin@example.com")
    candidates = client.get(f"{base}/notify-program-candidates")
    assert candidates.status_code == 200
    [candidate] = [c for c in candidates.json() if c["user_id"] == dancer_id]
    assert candidate["has_plan"] is True
    assert candidate["is_going"] is False

    response = client.post(f"{base}/notify-program", json={"user_ids": [dancer_id]})
    assert response.status_code == 200
    assert response.json()["emailed"] == 1
    assert sent == ["dancer@example.com"]


def test_notify_dialog_reasons_create_a_fresh_notification_per_send(
    client, engine, schedule_event, monkeypatch
):
    sent: list[dict] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count, **kwargs: sent.append(kwargs) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 0)

    base = "/api/admin/events/back-2-mambo-2026/schedule"
    _login(client, "admin@example.com")
    assert (
        client.post(
            base, json={"timezone": "Europe/Prague", "days": ["2026-10-16"]}
        ).status_code
        == 201
    )
    _login(client, "dancer@example.com")
    with Session(engine) as session:
        dancer = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        session.add(
            UserEventAttendance(
                device_id="dancer-device",
                event_id="back-2-mambo-2026",
                user_id=dancer.id,
            )
        )
        session.commit()
        dancer_id = str(dancer.id)

    _login(client, "admin@example.com")
    assert (
        client.post(f"{base}/publish", json={"auto_announce": False}).status_code == 200
    )
    with Session(engine) as session:
        assert not session.exec(select(Notification)).all()

    notify_url = f"{base}/notify-program"
    for _ in range(2):
        response = client.post(
            notify_url, json={"user_ids": [dancer_id], "reason": "updated"}
        )
        assert response.status_code == 200
        assert response.json()["emailed"] == 1
    assert (
        client.post(
            notify_url, json={"user_ids": [dancer_id], "reason": "under_work"}
        ).status_code
        == 409
    )

    assert client.post(f"{base}/unpublish").status_code == 200
    response = client.post(
        notify_url,
        json={
            "user_ids": [dancer_id],
            "reason": "under_work",
            "title": "Program under work",
        },
    )
    assert response.status_code == 200
    assert sent[-1]["program_live"] is False
    assert sent[-1]["headline"] == "Program under work"

    with Session(engine) as session:
        rows = session.exec(
            select(Notification).where(Notification.kind == "schedule_program_updated")
        ).all()
        assert len(rows) == 3
        assert len({row.subject_key for row in rows}) == 3
        assert {row.context for row in rows} == {
            "Program updated",
            "Program under work",
        }


def test_tick_sweep_delivers_a_lost_publication_job_once(
    client, engine, schedule_event, monkeypatch, run_jobs
):
    from datetime import timedelta, timezone

    from backend.services.scheduler import sweep_fanout_jobs

    emailed: list[str] = []
    monkeypatch.setattr(
        "backend.services.email.send_schedule_program_available_email",
        lambda user, event, session_count: emailed.append(user.email) or True,
    )
    monkeypatch.setattr("backend.services.push_service.send_push", lambda *a, **k: 1)

    _login(client, "admin@example.com")
    client.post(
        "/api/admin/events/back-2-mambo-2026/schedule",
        json={"timezone": "Europe/Prague", "days": ["2026-10-16"]},
    )
    _login(client, "dancer@example.com")
    with Session(engine) as session:
        dancer = session.exec(
            select(User).where(User.email == "dancer@example.com")
        ).one()
        session.add(
            UserEventAttendance(
                device_id="dancer-device",
                event_id="back-2-mambo-2026",
                user_id=dancer.id,
            )
        )
        session.commit()

    _login(client, "admin@example.com")
    assert (
        client.post(
            "/api/admin/events/back-2-mambo-2026/schedule/publish", json={}
        ).status_code
        == 200
    )

    assert sweep_fanout_jobs() == {"jobs": 1, "failed": 0}
    assert emailed == ["dancer@example.com"]
    assert sweep_fanout_jobs() == {"jobs": 0, "failed": 0}
    run_jobs()  # the debounced job arriving late finds nothing left to send
    assert emailed == ["dancer@example.com"]

    with Session(engine) as session:
        row = session.exec(
            select(Notification).where(
                Notification.kind == "schedule_program_available"
            )
        ).one()
        row.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
        row.emailed_at = None
        session.add(row)
        session.commit()
    assert sweep_fanout_jobs() == {"jobs": 0, "failed": 0}
