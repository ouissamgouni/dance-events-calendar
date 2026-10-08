"""Revisions of published events: source edits, admin drafts, apply/discard."""

import os
from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-event-revisions")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")

from backend.api.deps import require_admin  # noqa: E402
from backend.api.main import app  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    CalendarSetting,
    EventRevision,
    Notification,
    User,
    UserSavedEvent,
)
from backend.services.calendar.base import CalendarEvent, SyncResult  # noqa: E402
from backend.services.sync_service import SyncService  # noqa: E402

START = datetime(2030, 10, 4, 20, 0)


def _naive(value: datetime) -> datetime:
    return value.replace(tzinfo=None)


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng
    SQLModel.metadata.drop_all(eng)


@pytest.fixture
def session(engine):
    with Session(engine) as s:
        yield s


@pytest.fixture
def client(engine):
    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def seeded(session):
    calendar = CalendarSetting(calendar_id="src", name="Source", enabled=True)
    event = CachedEvent(
        event_id="ev-1",
        calendar_id="src",
        title="Salsa Friday",
        location="Studio A",
        start=START,
        end=START + timedelta(hours=3),
        review_status="reviewed",
    )
    sam = User(
        email="sam@example.com", handle="sam", provider="dev", provider_subject="sam"
    )
    session.add_all([calendar, event, sam])
    session.commit()
    session.add(UserSavedEvent(device_id=str(sam.id), event_id="ev-1", user_id=sam.id))
    session.commit()
    return calendar, sam


def _sync(session: Session, **overrides) -> None:
    values = {
        "title": "Salsa Friday",
        "description": None,
        "location": "Studio A",
        "start": START,
        "end": START + timedelta(hours=3),
        **overrides,
    }
    calendar_service = MagicMock()
    calendar_service.get_events.return_value = SyncResult(
        events=[CalendarEvent(event_id="ev-1", calendar_id="src", **values)],
        deleted_event_ids=[],
        next_sync_token=None,
    )
    calendar = session.get(CalendarSetting, "src")
    SyncService(calendar_service).sync_calendar(session, calendar)
    session.commit()
    session.expire_all()


def _revisions(session: Session) -> list[EventRevision]:
    session.expire_all()
    return list(session.exec(select(EventRevision).order_by(EventRevision.id)).all())


def test_source_edit_of_published_event_waits_for_admin(client, session, seeded):
    _, sam = seeded

    _sync(session, start=START + timedelta(hours=1), end=START + timedelta(hours=4))
    _sync(session, start=START + timedelta(hours=1), end=START + timedelta(hours=4))

    event = session.get(CachedEvent, "ev-1")
    assert _naive(event.start) == START
    assert event.review_status == "reviewed"
    [revision] = _revisions(session)
    assert (revision.source, revision.status) == ("sync", "pending")
    assert set(revision.changes) == {"start", "end"}

    r = client.get("/api/admin/events?flags=changes")
    assert [item["event_id"] for item in r.json()["items"]] == ["ev-1"]
    assert r.json()["items"][0]["has_pending_changes"] is True

    r = client.post(f"/api/admin/revisions/{revision.id}/apply", json={"notify": True})

    assert r.status_code == 200, r.text
    assert r.json()["notified_count"] == 1
    session.expire_all()
    assert _naive(session.get(CachedEvent, "ev-1").start) == START + timedelta(hours=1)
    [notification] = session.exec(select(Notification)).all()
    assert notification.recipient_user_id == sam.id
    assert notification.kind == "event_changed"
    assert notification.description == "Time: Fri 04 Oct 20:00 → 21:00"


@pytest.mark.parametrize("deliver_via", ["job", "sweep"])
def test_applied_revision_queues_change_emails(
    client, session, engine, seeded, monkeypatch, deliver_via
):
    from backend.db import database
    from backend.db.models import NotificationDelivery
    from backend.services import email, event_revisions, job_queue
    from backend.services.scheduler import sweep_fanout_jobs

    _, sam = seeded
    queued: list = []
    monkeypatch.setattr(
        job_queue, "enqueue", lambda name, key, delay=0: queued.append((name, key))
    )
    monkeypatch.setattr(database, "_engine", engine)
    sent: list = []
    monkeypatch.setattr(
        email,
        "send_event_changed_email",
        lambda user, event, changes: sent.append(user.id) or True,
    )
    _sync(session, location="Studio B")
    [revision] = _revisions(session)

    r = client.post(f"/api/admin/revisions/{revision.id}/apply", json={"notify": True})

    assert r.status_code == 200, r.text
    assert sent == []
    assert queued == [(event_revisions.CHANGE_EMAILS_JOB, str(revision.id))]
    for _ in range(2):  # a re-run must not re-send
        if deliver_via == "job":
            job_queue.run_job(*queued[0])
        else:
            sweep_fanout_jobs()
    assert sent == [sam.id]
    assert sweep_fanout_jobs() == {"jobs": 0, "failed": 0}
    session.expire_all()
    [notification] = session.exec(select(Notification)).all()
    assert notification.emailed_at is not None
    assert [d.channel for d in session.exec(select(NotificationDelivery)).all()] == [
        "app",
        "email",
    ]


def test_discarded_source_edit_is_not_proposed_again(client, session, seeded):
    _sync(session, location="Studio B")
    [revision] = _revisions(session)

    r = client.post(f"/api/admin/revisions/{revision.id}/discard")
    assert r.status_code == 200, r.text
    _sync(session, location="Studio B")

    assert [r.status for r in _revisions(session)] == ["rejected"]
    assert session.get(CachedEvent, "ev-1").location == "Studio A"


def test_unpublished_event_is_overwritten_directly(session, seeded):
    event = session.get(CachedEvent, "ev-1")
    event.review_status = "pending"
    session.add(event)
    session.commit()

    _sync(session, title="Salsa Saturday")

    assert session.get(CachedEvent, "ev-1").title == "Salsa Saturday"
    # Only its first review waits; the source edit is not staged.
    assert [(r.kind, r.status) for r in _revisions(session)] == [("create", "pending")]


def _new_event(session: Session, event_id: str) -> None:
    session.add(
        CachedEvent(
            event_id=event_id,
            calendar_id="src",
            title=event_id,
            start=START,
            end=START + timedelta(hours=2),
            review_status="pending",
        )
    )
    session.commit()


def test_review_queue_publishes_or_rejects_new_events(client, session, seeded):
    from backend.db.models import BlockedEvent

    _new_event(session, "ev-new")
    _new_event(session, "ev-spam")

    queue = client.get("/api/admin/changes").json()
    assert queue["total"] == 2
    assert {o["value"]: o["count"] for o in queue["kinds"]}["create"] == 2
    ids = {c["event"]["event_id"]: c["id"] for c in queue["items"]}

    r = client.post(
        f"/api/admin/changes/{ids['ev-new']}/decide", json={"decision": "accept"}
    )
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["event"]["status"]) == (
        "accepted",
        "published",
    )

    r = client.post(
        f"/api/admin/changes/{ids['ev-spam']}/decide",
        json={"decision": "reject", "note": "Not a dance event"},
    )
    assert r.status_code == 200, r.text
    session.expire_all()
    spam = session.get(CachedEvent, "ev-spam")
    assert (spam.status, spam.status_reason) == ("removed", "rejected")
    assert session.get(BlockedEvent, "ev-spam").reason == "rejected"
    assert client.get("/api/admin/changes").json()["total"] == 0
    decided = client.get("/api/admin/changes", params={"state": "decided"}).json()
    assert {c["status"] for c in decided["items"]} == {"accepted", "rejected"}


def test_review_queue_filters_by_upcoming_or_past_events(client, session, seeded):
    _new_event(session, "ev-upcoming")
    past = START - timedelta(days=365 * 10)
    session.add(
        CachedEvent(
            event_id="ev-past",
            calendar_id="src",
            title="ev-past",
            start=past,
            end=past + timedelta(hours=2),
            review_status="pending",
        )
    )
    session.add(
        EventRevision(
            kind="edit", source="admin", status="pending", changes={"title": {}}
        )
    )
    session.commit()

    def queue(when: str) -> tuple[set, int, int]:
        body = client.get("/api/admin/changes", params={"when": when}).json()
        kinds = {o["value"]: o["count"] for o in body["kinds"]}
        events = {c["event"]["event_id"] if c["event"] else None for c in body["items"]}
        return events, kinds["create"], kinds["edit"]

    assert queue("upcoming") == ({"ev-upcoming", None}, 1, 1)
    assert queue("past") == ({"ev-past"}, 1, 0)
    assert queue("all") == ({"ev-upcoming", "ev-past", None}, 2, 1)


def test_review_queue_applies_a_source_edit(client, session, seeded):
    _sync(session, location="Studio B")
    change = client.get("/api/admin/changes", params={"kind": "edit"}).json()["items"][
        0
    ]
    assert (change["source"], change["event"]["title"]) == ("sync", "Salsa Friday")
    assert change["affected_attendees"] == 1

    r = client.post(
        f"/api/admin/changes/{change['id']}/decide",
        json={"decision": "accept", "notify": True},
    )

    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["notified_count"]) == ("accepted", 1)
    assert r.json()["affected_attendees"] == 0
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").location == "Studio B"


def _make_series(session: Session, sam: User) -> User:
    from backend.db.models import EventSeries, EventSeriesMember

    for week in (1, 2):
        session.add(
            CachedEvent(
                event_id=f"ev-{week + 1}",
                calendar_id="src",
                title="Salsa Friday",
                location="Studio A",
                start=START + timedelta(weeks=week),
                end=START + timedelta(weeks=week, hours=3),
                review_status="reviewed",
            )
        )
    lea = User(
        email="lea@example.com", handle="lea", provider="dev", provider_subject="lea"
    )
    series = EventSeries(status="resolved", canonical_title="Salsa Friday")
    session.add_all([lea, series])
    session.commit()
    session.add_all(
        [EventSeriesMember(series_id=series.id, event_id=f"ev-{n}") for n in (1, 2, 3)]
        + [
            UserSavedEvent(device_id=str(lea.id), event_id="ev-2", user_id=lea.id),
            UserSavedEvent(device_id=str(sam.id), event_id="ev-3", user_id=sam.id),
        ]
    )
    session.commit()
    return lea


def _sync_series(session: Session, shift: timedelta) -> None:
    calendar_service = MagicMock()
    calendar_service.get_events.return_value = SyncResult(
        events=[
            CalendarEvent(
                event_id=f"ev-{n + 1}",
                calendar_id="src",
                title="Salsa Friday",
                description=None,
                location="Studio A",
                start=START + timedelta(weeks=n) + shift,
                end=START + timedelta(weeks=n, hours=3) + shift,
            )
            for n in range(3)
        ],
        deleted_event_ids=[],
        next_sync_token=None,
    )
    SyncService(calendar_service).sync_calendar(
        session, session.get(CalendarSetting, "src")
    )
    session.commit()
    session.expire_all()


def test_admin_change_can_go_to_every_upcoming_date(client, session, seeded):
    _, sam = seeded
    lea = _make_series(session, sam)
    r = client.put(
        "/api/admin/events/ev-1/draft", json={"changes": {"location": "Studio B"}}
    )
    body = r.json()
    assert (
        body["affected_attendees"],
        body["series_dates"],
        body["series_affected_attendees"],
    ) == (1, 3, 2)

    r = client.post(
        "/api/admin/events/ev-1/draft/publish",
        json={"notify": True, "scope": "series"},
    )

    assert r.status_code == 200, r.text
    session.expire_all()
    assert {session.get(CachedEvent, f"ev-{n}").location for n in (1, 2, 3)} == {
        "Studio B"
    }
    # Sam saved two dates but hears once.
    told = {
        (n.recipient_user_id, n.event_id) for n in session.exec(select(Notification))
    }
    assert told == {(sam.id, "ev-1"), (lea.id, "ev-2")}


def test_a_time_change_stays_on_its_date(client, session, seeded):
    _make_series(session, seeded[1])
    client.put(
        "/api/admin/events/ev-1/draft",
        json={
            "changes": {
                "start": (START + timedelta(hours=1)).isoformat(),
                "end": (START + timedelta(hours=4)).isoformat(),
            }
        },
    )

    r = client.post("/api/admin/events/ev-1/draft/publish", json={"scope": "series"})

    assert r.status_code == 422
    session.expire_all()
    assert _naive(session.get(CachedEvent, "ev-1").start) == START


def test_the_same_google_change_on_every_date_is_one_review_row(
    client, session, seeded
):
    _make_series(session, seeded[1])
    _sync_series(session, timedelta(hours=1))

    queue = client.get("/api/admin/changes").json()
    assert queue["total"] == 1
    assert {o["value"]: o["count"] for o in queue["kinds"]}["edit"] == 1
    [change] = queue["items"]
    assert change["group_size"] == 3

    r = client.post(
        f"/api/admin/changes/{change['id']}/decide",
        json={"decision": "accept", "notify": False, "scope": "series"},
    )

    assert r.status_code == 200, r.text
    session.expire_all()
    assert [
        _naive(session.get(CachedEvent, f"ev-{n + 1}").start) for n in range(3)
    ] == [START + timedelta(weeks=n, hours=1) for n in range(3)]
    assert client.get("/api/admin/changes").json()["total"] == 0


def test_admin_draft_publishes_with_optional_notification(client, session, seeded):
    r = client.put(
        "/api/admin/events/ev-1/draft",
        json={"changes": {"title": "Salsa Friday!", "description": "Bring water"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft"
    assert r.json()["affected_attendees"] == 1
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").title == "Salsa Friday"

    r = client.post("/api/admin/events/ev-1/draft/publish", json={"notify": False})

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    session.expire_all()
    event = session.get(CachedEvent, "ev-1")
    assert (event.title, event.description) == ("Salsa Friday!", "Bring water")
    assert session.exec(select(Notification)).all() == []


def test_admin_publish_supersedes_the_same_field_from_the_source(
    client, session, seeded
):
    _sync(session, title="From Google", location="Studio B")
    client.put("/api/admin/events/ev-1/draft", json={"changes": {"title": "Admin"}})

    client.post("/api/admin/events/ev-1/draft/publish", json={"notify": False})

    sync_revision = _revisions(session)[0]
    assert sync_revision.status == "pending"
    assert set(sync_revision.changes) == {"location"}
    assert session.get(CachedEvent, "ev-1").title == "Admin"


def test_draft_edited_back_to_live_value_is_dropped(client, session, seeded):
    client.put("/api/admin/events/ev-1/draft", json={"changes": {"title": "X"}})

    r = client.put(
        "/api/admin/events/ev-1/draft", json={"changes": {"title": "Salsa Friday"}}
    )

    assert r.status_code == 200
    assert r.json() is None
    assert _revisions(session) == []


def test_admin_draft_counts_as_a_pending_change(client, session, seeded):
    client.put("/api/admin/events/ev-1/draft", json={"changes": {"title": "Draft"}})

    r = client.get("/api/admin/events?flags=changes")

    assert [item["event_id"] for item in r.json()["items"]] == ["ev-1"]
    assert r.json()["items"][0]["has_pending_changes"] is True
    options = client.get("/api/admin/events/filter-options").json()["flags"]
    assert {o["value"]: o["count"] for o in options}["changes"] == 1


def test_minor_change_notifies_only_when_the_admin_asks(client, session, seeded):
    _sync(session, description="Bring water")
    [revision] = _revisions(session)

    r = client.post(f"/api/admin/revisions/{revision.id}/apply", json={})
    assert r.json()["notified_count"] == 0

    _sync(session, description="Bring water and shoes")
    revision = _revisions(session)[-1]
    r = client.post(f"/api/admin/revisions/{revision.id}/apply", json={"notify": True})

    assert r.json()["notified_count"] == 1
    [notification] = session.exec(select(Notification)).all()
    assert notification.description == "Updated: description"


def test_edit_at_mock_source_stages_a_revision(
    client, session, seeded, tmp_path, monkeypatch
):
    (tmp_path / "mock-sync-events.yaml").write_text(
        f"""
events:
  - id: ev-1
    calendar_id: src
    title: Salsa Friday
    location: Studio A
    start: "{START.isoformat()}"
    end: "{(START + timedelta(hours=3)).isoformat()}"
"""
    )
    monkeypatch.setenv("SCENARIO_DIR", str(tmp_path))
    monkeypatch.setattr(
        "backend.config.loader.get_calendar_service_type", lambda: "mock"
    )
    assert client.get("/api/admin/mock-source/events/ev-1").json()["edited"] is False

    r = client.patch(
        "/api/admin/mock-source/events/ev-1", json={"location": "Studio B"}
    )

    assert r.status_code == 200, r.text
    assert r.json()["synced"] is True
    assert r.json()["source"]["location"] == "Studio B"
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").location == "Studio A"
    [revision] = _revisions(session)
    assert (revision.source, set(revision.changes)) == ("sync", {"location"})


def test_mock_source_endpoints_are_hidden_outside_mock_mode(client, monkeypatch):
    monkeypatch.setattr(
        "backend.config.loader.get_calendar_service_type", lambda: "google"
    )
    assert client.get("/api/admin/mock-source/events/ev-1").status_code == 404


def _apply_local_title(session: Session, title: str) -> None:
    """A published local edit the source never had."""
    _sync(session)  # records the source baseline
    event = session.get(CachedEvent, "ev-1")
    event.title = title
    session.add(event)
    session.commit()


def test_unchanged_source_does_not_revert_a_local_edit(client, session, seeded):
    _apply_local_title(session, "Salsa Friday at Studio A")

    _sync(session)

    assert session.get(CachedEvent, "ev-1").title == "Salsa Friday at Studio A"
    assert _revisions(session) == []


def test_source_change_proposes_only_what_the_source_changed(client, session, seeded):
    _apply_local_title(session, "Salsa Friday at Studio A")

    _sync(session, start=START + timedelta(hours=1), end=START + timedelta(hours=4))

    event = session.get(CachedEvent, "ev-1")
    assert event.title == "Salsa Friday at Studio A"
    assert _naive(event.start) == START
    [revision] = _revisions(session)
    assert set(revision.changes) == {"start", "end"}


def test_source_change_to_a_locally_edited_field_is_proposed(client, session, seeded):
    _apply_local_title(session, "Salsa Friday at Studio A")

    _sync(session, title="Salsa Friday (new DJ)")

    [revision] = _revisions(session)
    assert revision.changes == {
        "title": {"old": "Salsa Friday at Studio A", "new": "Salsa Friday (new DJ)"}
    }


def test_an_open_source_proposal_survives_an_unchanged_sync(client, session, seeded):
    _sync(session)
    _sync(session, location="Studio B")
    _sync(session, location="Studio B")

    [revision] = _revisions(session)
    assert (revision.status, set(revision.changes)) == ("pending", {"location"})
