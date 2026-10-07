import os
from datetime import datetime
from uuid import uuid4

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
    assert replaced.json()["operations"]["removed"] == 1
    removed_change = next(
        change
        for change in replaced.json()["changes"]
        if change["operation"] == "remove"
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
