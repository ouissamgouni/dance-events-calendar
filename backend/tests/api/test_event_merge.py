"""Admin event merge: preview, moving engagement, removal and redirect."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-event-merge")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")

from backend.api.deps import require_admin  # noqa: E402
from backend.api.main import app  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    EventDuplicateGroup,
    EventDuplicateMember,
    EventRating,
    EventRevision,
    Notification,
    User,
    UserEventAttendance,
    UserSavedEvent,
)

START = (datetime.now(timezone.utc) + timedelta(days=5)).replace(
    hour=20, minute=0, second=0, microsecond=0, tzinfo=None
)


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


def _user(session: Session, handle: str) -> User:
    user = User(
        email=f"{handle}@example.com",
        handle=handle,
        provider="dev",
        provider_subject=handle,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _event(event_id: str, **values) -> CachedEvent:
    return CachedEvent(
        event_id=event_id,
        calendar_id="src",
        title=values.pop("title", "Salsa Night"),
        location=values.pop("location", "Studio A"),
        start=values.pop("start", START),
        end=values.pop("end", START + timedelta(hours=3)),
        review_status="reviewed",
        **values,
    )


@pytest.fixture
def world(session):
    sam = _user(session, "sam")
    lee = _user(session, "lee")
    session.add(CalendarSetting(calendar_id="src", name="Source", enabled=True))
    session.add(_event("keep", title="Salsa Night at Studio A"))
    session.add(_event("dup", title="Salsa Night", location="Studio A, Berlin"))
    session.commit()
    session.add_all(
        [
            # Sam saved both, Lee only the duplicate.
            UserSavedEvent(device_id="d-sam", event_id="keep", user_id=sam.id),
            UserSavedEvent(device_id="d-sam", event_id="dup", user_id=sam.id),
            UserSavedEvent(device_id="d-lee", event_id="dup", user_id=lee.id),
            UserEventAttendance(device_id="d-lee", event_id="dup", user_id=lee.id),
            EventRating(
                event_id="keep",
                user_id=sam.id,
                stars=3,
                overall_sentiment="okay",
                updated_at=datetime(2030, 1, 1),
            ),
            EventRating(
                event_id="dup",
                user_id=sam.id,
                stars=5,
                overall_sentiment="amazing",
                updated_at=datetime(2030, 2, 1),
            ),
        ]
    )
    group = EventDuplicateGroup(status="pending")
    session.add(group)
    session.commit()
    session.add_all(
        [
            EventDuplicateMember(group_id=group.id, event_id="keep"),
            EventDuplicateMember(group_id=group.id, event_id="dup"),
        ]
    )
    session.commit()
    return {"sam": sam, "lee": lee, "group_id": group.id}


def test_preview_lists_differences_and_engagement(client, world):
    r = client.get("/api/admin/event-merge/preview", params={"ids": ["keep", "dup"]})

    assert r.status_code == 200, r.text
    body = r.json()
    differing = {f["key"] for f in body["fields"] if not f["identical"]}
    assert differing == {"title", "location"}
    counts = {e["event_id"]: e["counts"] for e in body["events"]}
    assert counts["dup"]["saved"] == 2 and counts["dup"]["going"] == 1
    assert body["affected_users"] == 2


def test_merge_moves_people_removes_the_duplicate_and_redirects(client, session, world):
    r = client.post(
        "/api/admin/event-merge",
        json={
            "target_event_id": "keep",
            "event_ids": ["dup"],
            "fields": {"location": "dup"},
            "notify": True,
        },
    )

    assert r.status_code == 200, r.text
    session.expire_all()
    keep, dup = session.get(CachedEvent, "keep"), session.get(CachedEvent, "dup")
    assert keep.location == "Studio A, Berlin"
    assert (dup.status, dup.status_reason, dup.merged_into_event_id) == (
        "removed",
        "merged",
        "keep",
    )
    assert session.get(BlockedEvent, "dup").reason == "merged"
    saved = session.exec(
        select(UserSavedEvent).where(UserSavedEvent.event_id == "keep")
    ).all()
    assert {s.user_id for s in saved} == {world["sam"].id, world["lee"].id}
    assert session.exec(
        select(UserEventAttendance.event_id).where(
            UserEventAttendance.user_id == world["lee"].id
        )
    ).all() == ["keep"]
    [rating] = session.exec(select(EventRating)).all()
    assert (rating.event_id, rating.stars) == ("keep", 5)
    assert session.get(EventDuplicateGroup, world["group_id"]).kept_event_id == "keep"
    applied = session.exec(
        select(EventRevision).where(EventRevision.event_id == "keep")
    ).one()
    assert applied.status == "accepted" and "location" in applied.changes
    # Lee only followed the duplicate: one "moved" notice pointing at the kept event.
    lee_kinds = [
        (n.kind, n.event_id)
        for n in session.exec(
            select(Notification).where(
                Notification.recipient_user_id == world["lee"].id
            )
        ).all()
    ]
    assert lee_kinds == [("event_removed", "keep")]

    page = client.get("/api/events/dup")
    assert page.status_code == 410
    assert page.json()["detail"]["merged_into"] == "keep"


def test_dates_of_one_series_cannot_be_merged(client, session, world):
    from uuid import uuid4

    series = uuid4()
    for event_id in ("keep", "dup"):
        event = session.get(CachedEvent, event_id)
        event.suggestion_id = series
        session.add(event)
    session.commit()

    r = client.post(
        "/api/admin/event-merge", json={"target_event_id": "keep", "event_ids": ["dup"]}
    )

    assert r.status_code == 422
