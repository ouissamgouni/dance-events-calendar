"""Changes to public events suggested by users, organizer edits and removal notices."""

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-event-changes")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.deps import require_admin  # noqa: E402
from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import event_changes as changes_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventRevision,
    EventTag,
    Notification,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
    UserSavedEvent,
)

START = (datetime.now(timezone.utc) + timedelta(days=5)).replace(
    hour=20, minute=0, second=0, microsecond=0
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
    auth_module.limiter.reset()
    changes_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _user(session: Session, handle: str) -> User:
    user = User(
        email=f"{handle}@example.com",
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{handle}@example.com",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _login(client: TestClient, handle: str) -> None:
    r = client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": f"{handle}@example.com"},
    )
    assert r.status_code == 200, r.text


def _admin(client: TestClient) -> None:
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}


@pytest.fixture
def world(session):
    riley = _user(session, "riley")
    sam = _user(session, "sam")
    group = TagGroup(slug="dance-style", label="Dance style")
    session.add(group)
    session.commit()
    salsa = Tag(slug="salsa", label="Salsa", group_id=group.id)
    bachata = Tag(slug="bachata", label="Bachata", group_id=group.id)
    event = CachedEvent(
        event_id="ev-1",
        calendar_id="src",
        title="Salsa Friday",
        location="Studio A",
        start=START,
        end=START + timedelta(hours=3),
        review_status="reviewed",
    )
    session.add_all([salsa, bachata, event])
    session.commit()
    session.add(EventTag(event_id="ev-1", tag_id=salsa.id))
    session.add(UserSavedEvent(device_id=str(sam.id), event_id="ev-1", user_id=sam.id))
    session.commit()
    return {"riley": riley, "sam": sam, "salsa": salsa.id, "bachata": bachata.id}


def _later(hours: int) -> str:
    return (START + timedelta(hours=hours)).isoformat()


def test_signed_in_user_suggests_only_what_changed(client, session, world):
    _login(client, "riley")

    r = client.post(
        "/api/events/ev-1/changes",
        json={
            "title": "Salsa Friday",
            "start": _later(1),
            "end": _later(4),
            "tag_ids": [world["salsa"], world["bachata"]],
        },
    )

    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert set(body["changes"]) == {"start", "end", "tag_ids"}
    assert body["changes"]["tag_ids"]["new"] == sorted(
        [world["salsa"], world["bachata"]]
    )
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").start.hour == START.hour


@pytest.mark.parametrize(
    "setup,expected",
    [
        ("signed_out", 401),
        ("nothing_changed", 422),
        ("private", 404),
        ("owner", 409),
    ],
)
def test_suggestions_are_refused(client, session, world, setup, expected):
    event = session.get(CachedEvent, "ev-1")
    if setup == "private":
        event.visibility = "private"
    if setup == "owner":
        event.owner_user_id = world["riley"].id
    session.add(event)
    session.commit()
    if setup != "signed_out":
        _login(client, "riley")
    body = {"title": "Salsa Friday"} if setup == "nothing_changed" else {"title": "New"}

    assert client.post("/api/events/ev-1/changes", json=body).status_code == expected


def test_one_open_suggestion_per_event_and_ten_overall(client, session, world):
    _login(client, "riley")
    assert (
        client.post("/api/events/ev-1/changes", json={"title": "A"}).status_code == 201
    )
    assert (
        client.post("/api/events/ev-1/changes", json={"title": "B"}).status_code == 409
    )

    for i in range(changes_module.MAX_OPEN_CHANGES - 1):
        session.add(
            CachedEvent(
                event_id=f"ev-x{i}",
                calendar_id="src",
                title=f"Other {i}",
                start=START,
                end=START + timedelta(hours=1),
                review_status="reviewed",
            )
        )
    session.add(
        CachedEvent(
            event_id="ev-last",
            calendar_id="src",
            title="Last",
            start=START,
            end=START + timedelta(hours=1),
            review_status="reviewed",
        )
    )
    session.commit()
    for i in range(changes_module.MAX_OPEN_CHANGES - 1):
        r = client.post(f"/api/events/ev-x{i}/changes", json={"title": f"T{i}"})
        assert r.status_code == 201, r.text

    assert (
        client.post("/api/events/ev-last/changes", json={"title": "Z"}).status_code
        == 429
    )


def test_admin_applies_a_suggestion_with_tags_and_everyone_hears(
    client, session, world
):
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes",
        json={"location": "Studio B", "tag_ids": [world["bachata"]]},
    ).json()["id"]
    _admin(client)

    r = client.post(f"/api/admin/revisions/{revision_id}/apply", json={})

    assert r.status_code == 200, r.text
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").location == "Studio B"
    assert set(
        session.exec(select(EventTag.tag_id).where(EventTag.event_id == "ev-1")).all()
    ) == {world["bachata"]}
    kinds = {
        (n.recipient_user_id, n.kind) for n in session.exec(select(Notification)).all()
    }
    assert (world["riley"].id, "event_change_applied") in kinds
    assert (world["sam"].id, "event_changed") in kinds
    assert (world["riley"].id, "event_changed") not in kinds


def test_discarded_suggestion_tells_the_proposer(client, session, world):
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes", json={"description": "Bring water"}
    ).json()["id"]
    _admin(client)

    client.post(f"/api/admin/revisions/{revision_id}/discard")

    [notification] = session.exec(
        select(Notification).where(Notification.recipient_user_id == world["riley"].id)
    ).all()
    assert notification.kind == "event_change_declined"
    assert client.get("/api/me/changes").json()[0]["status"] == "rejected"


def test_user_withdraws_an_open_suggestion(client, session, world):
    _login(client, "riley")
    revision_id = client.post("/api/events/ev-1/changes", json={"title": "A"}).json()[
        "id"
    ]

    r = client.delete(f"/api/me/changes/{revision_id}")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "withdrawn"
    assert (
        client.post("/api/events/ev-1/changes", json={"title": "B"}).status_code == 201
    )


def test_owner_can_only_ask_for_a_cancellation(client, session, world):
    event = session.get(CachedEvent, "ev-1")
    event.owner_user_id = world["riley"].id
    session.add(event)
    session.commit()
    _login(client, "riley")

    assert (
        client.post("/api/events/ev-1/changes", json={"title": "New"}).status_code
        == 409
    )
    r = client.post(
        "/api/events/ev-1/changes",
        json={"is_cancelled": True, "cancellation_note": "Venue closed"},
    )
    assert r.status_code == 201, r.text
    _admin(client)

    moderation = client.get("/api/admin/events/ev-1/moderation").json()
    assert moderation["open_revisions"][0]["changes"]["is_cancelled"]["new"] is True
    r = client.post(
        f"/api/admin/revisions/{r.json()['id']}/apply",
        json={"notify": True, "as_status": "removed"},
    )

    assert r.status_code == 200, r.text
    session.expire_all()
    event = session.get(CachedEvent, "ev-1")
    assert (event.status, event.status_reason) == ("removed", "admin")
    kinds = {n.kind for n in session.exec(select(Notification)).all()}
    assert "event_removed" in kinds


def test_admin_cancels_and_restores_an_event(client, session, world):
    _admin(client)

    r = client.post(
        "/api/admin/events/ev-1/status",
        json={"status": "cancelled", "note": "Rain", "notify": True},
    )
    assert r.status_code == 200, r.text
    session.expire_all()
    event = session.get(CachedEvent, "ev-1")
    assert (event.status, event.cancellation_note) == ("cancelled", "Rain")
    assert any(
        n.kind == "event_cancelled" for n in session.exec(select(Notification)).all()
    )

    assert (
        client.post(
            "/api/admin/events/ev-1/status", json={"status": "removed"}
        ).status_code
        == 200
    )
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").status == "removed"

    assert (
        client.post(
            "/api/admin/events/ev-1/status", json={"status": "published"}
        ).status_code
        == 200
    )
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").status == "new"


def _make_organizer(session, world):
    event = session.get(CachedEvent, "ev-1")
    event.organizer_user_id = world["riley"].id
    session.add(event)
    session.commit()


def test_organizer_edit_waits_for_admin_then_notifies_attendees(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")

    r = client.post(
        "/api/events/ev-1/changes", json={"start": _later(1), "end": _later(4)}
    )

    assert r.status_code == 201, r.text
    assert (r.json()["source"], r.json()["status"]) == ("organizer", "pending")
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").start.hour == START.hour
    assert session.exec(select(Notification)).all() == []

    _admin(client)
    applied = client.post(f"/api/admin/revisions/{r.json()['id']}/apply", json={})
    assert applied.status_code == 200, applied.text
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").start.hour == (START.hour + 1) % 24
    kinds = {
        (n.recipient_user_id, n.kind) for n in session.exec(select(Notification)).all()
    }
    assert (world["sam"].id, "event_changed") in kinds
    assert (world["riley"].id, "event_change_applied") in kinds
    assert (world["riley"].id, "event_changed") not in kinds


def test_organizer_new_proposal_replaces_pending_one(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    first = client.post("/api/events/ev-1/changes", json={"title": "A"}).json()
    second = client.post("/api/events/ev-1/changes", json={"title": "B"})

    assert second.status_code == 201, second.text
    statuses = {c["id"]: c["status"] for c in client.get("/api/me/changes").json()}
    assert statuses[first["id"]] == "superseded"
    assert statuses[second.json()["id"]] == "pending"


def test_admin_reverts_an_organizer_edit(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes", json={"location": "Studio B"}
    ).json()["id"]
    _admin(client)
    client.post(f"/api/admin/revisions/{revision_id}/apply", json={})

    r = client.post(f"/api/admin/revisions/{revision_id}/revert")

    assert r.status_code == 200, r.text
    assert (r.json()["source"], r.json()["status"]) == ("admin", "accepted")
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").location == "Studio A"
    assert session.get(EventRevision, revision_id).status == "reverted"
    assert (
        client.post(f"/api/admin/revisions/{r.json()['id']}/revert").status_code == 409
    )
    assert client.post(f"/api/admin/revisions/{revision_id}/revert").status_code == 409
    kinds = {
        (n.recipient_user_id, n.kind) for n in session.exec(select(Notification)).all()
    }
    assert (world["riley"].id, "event_change_reverted") in kinds


def test_revert_leaves_fields_edited_since_alone(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes",
        json={"location": "Studio B", "description": "Bring water"},
    ).json()["id"]
    _admin(client)
    client.post(f"/api/admin/revisions/{revision_id}/apply", json={})
    event = session.get(CachedEvent, "ev-1")
    event.location = "Studio C"
    session.add(event)
    session.commit()

    r = client.post(f"/api/admin/revisions/{revision_id}/revert", json={})

    assert r.status_code == 200, r.text
    assert set(r.json()["changes"]) == {"description"}
    session.expire_all()
    event = session.get(CachedEvent, "ev-1")
    assert (event.location, event.description) == ("Studio C", None)


def test_revert_with_nothing_left_to_undo_is_refused(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes", json={"location": "Studio B"}
    ).json()["id"]
    _admin(client)
    client.post(f"/api/admin/revisions/{revision_id}/apply", json={})
    event = session.get(CachedEvent, "ev-1")
    event.location = "Studio C"
    session.add(event)
    session.commit()

    r = client.post(f"/api/admin/revisions/{revision_id}/revert")

    assert r.status_code == 409
    session.expire_all()
    assert session.get(EventRevision, revision_id).status == "accepted"


def test_organizer_minor_edit_is_silent(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    revision_id = client.post(
        "/api/events/ev-1/changes", json={"description": "Bring water"}
    ).json()["id"]
    _admin(client)

    client.post(f"/api/admin/revisions/{revision_id}/apply", json={})

    assert {n.kind for n in session.exec(select(Notification)).all()} == {
        "event_change_applied"
    }


def test_organizer_cancellation_is_reviewed_then_announced(client, session, world):
    _make_organizer(session, world)
    _login(client, "riley")
    r = client.post(
        "/api/events/ev-1/changes",
        json={"is_cancelled": True, "cancellation_note": "Venue flooded"},
    )
    assert r.status_code == 201, r.text
    session.expire_all()
    assert session.get(CachedEvent, "ev-1").is_cancelled is False

    _admin(client)
    assert [e["event_id"] for e in client.get("/api/events/search?q=Salsa").json()] == [
        "ev-1"
    ]
    client.post(f"/api/admin/revisions/{r.json()['id']}/apply", json={})

    session.expire_all()
    event = session.get(CachedEvent, "ev-1")
    assert (event.is_cancelled, event.cancellation_note) == (True, "Venue flooded")
    [notification] = session.exec(
        select(Notification).where(Notification.kind == "event_cancelled")
    ).all()
    assert notification.recipient_user_id == world["sam"].id
    assert notification.description == "Cancelled: Venue flooded"
    assert client.get("/api/events/search?q=Salsa").json() == []


def test_only_the_organizer_can_cancel(client, session, world):
    _login(client, "riley")

    r = client.post("/api/events/ev-1/changes", json={"is_cancelled": True})

    assert r.status_code == 403


def test_tags_are_checked_and_new_tags_become_requests(client, session, world):
    bachata = session.get(Tag, world["bachata"])
    bachata.enabled = False
    session.add(bachata)
    session.commit()
    _login(client, "riley")

    disabled = client.post(
        "/api/events/ev-1/changes", json={"tag_ids": [world["salsa"], world["bachata"]]}
    )
    unknown = client.post("/api/events/ev-1/changes", json={"tag_ids": [999]})
    tag_only = client.post(
        "/api/events/ev-1/changes",
        json={
            "suggested_new_tags": [{"free_text": "Cuban", "group_slug": "dance-style"}]
        },
    )

    assert (disabled.status_code, unknown.status_code) == (422, 422)
    assert tag_only.status_code == 202, tag_only.text
    [request] = session.exec(select(TagSuggestion)).all()
    assert (request.event_id, request.free_text, request.submitter_user_id) == (
        "ev-1",
        "Cuban",
        world["riley"].id,
    )
    assert session.exec(select(EventRevision)).all() == []


def test_blocking_an_event_tells_who_saved_it(client, session, world):
    _admin(client)

    client.post("/api/admin/events/ev-1/block")

    [notification] = session.exec(select(Notification)).all()
    assert (notification.recipient_user_id, notification.kind) == (
        world["sam"].id,
        "event_removed",
    )
    assert notification.context == "Salsa Friday"
    assert notification.event_id is None


def test_resolving_a_duplicate_points_to_the_kept_event(client, session, world):
    session.add(
        CachedEvent(
            event_id="ev-2",
            calendar_id="other",
            title="Salsa Friday!",
            start=START,
            end=START + timedelta(hours=3),
            review_status="reviewed",
        )
    )
    session.commit()
    _login(client, "riley")
    _admin(client)
    group_id = client.post(
        "/api/admin/duplicates/manual", json={"event_ids": ["ev-1", "ev-2"]}
    ).json()["id"]

    client.post(
        f"/api/admin/duplicates/{group_id}/keep", json={"keep_event_id": "ev-2"}
    )

    [notification] = session.exec(
        select(Notification).where(Notification.kind == "event_removed")
    ).all()
    assert notification.recipient_user_id == world["sam"].id
    assert notification.event_id == "ev-2"
