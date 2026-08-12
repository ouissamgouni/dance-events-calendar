"""Tests for the event message board (Q&A / requests).

Mirrors the in-memory SQLite + DEV_AUTH approach used by test_ratings.py.
Covers auth gates, posting + flattened replies (reply-to-reply with an
"@name" mention), listing with inline replies, author/admin delete
(soft-delete), reporting + admin notification, and fan-out to engaged
(Going) users.
"""

import os
from datetime import datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-event-messages")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import event_messages as em_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventMessage,
    EventMessageReport,
    Notification,
    User,
    UserEventAttendance,
    UserEventMute,
    UserSavedEvent,
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
    em_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def event(session):
    ev = CachedEvent(
        event_id="evt-msg-1",
        calendar_id="cal-1",
        title="Salsa Social",
        start=datetime(2099, 1, 1, 20, 0, 0),
        end=datetime(2099, 1, 2, 1, 0, 0),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


def _login(client: TestClient, *, email: str):
    return client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )


def _user(session, email: str) -> User:
    return session.exec(select(User).where(User.email == email)).one()


@pytest.mark.unit
def test_post_requires_auth(client, event):
    resp = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "accommodation", "body": "Anyone need a roommate?"},
    )
    assert resp.status_code == 401


@pytest.mark.unit
def test_anon_can_read_empty(client, event):
    resp = client.get(f"/api/events/{event.event_id}/messages")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0, "muted": False}


@pytest.mark.unit
def test_post_and_list_with_reply(client, session, event):
    assert _login(client, email="alice@example.com").status_code == 200
    post = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "ride", "body": "Sharing a ride from Lyon?"},
    )
    assert post.status_code == 201
    data = post.json()
    assert data["category"] == "ride"
    assert data["is_own"] is True
    assert data["can_delete"] is True
    parent_id = data["id"]

    # A second user replies; reply inherits the parent category.
    assert _login(client, email="bob@example.com").status_code == 200
    reply = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "other", "body": "I'm in!", "parent_id": parent_id},
    )
    assert reply.status_code == 201
    assert reply.json()["parent_id"] == parent_id
    assert reply.json()["category"] == "ride"

    listing = client.get(f"/api/events/{event.event_id}/messages").json()
    assert listing["total"] == 1
    top = listing["items"][0]
    assert top["id"] == parent_id
    assert top["reply_count"] == 1
    assert top["replies"][0]["body"] == "I'm in!"


@pytest.mark.unit
def test_reply_to_reply_flattened_with_mention(client, session, event):
    """Flattened threading: a reply to a reply is allowed and surfaces under
    the top-level post (chronological) with ``reply_to`` set for the "@name"."""
    assert _login(client, email="alice@example.com").status_code == 200
    parent = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "What time does it start?"},
    ).json()

    assert _login(client, email="bob@example.com").status_code == 200
    reply = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"body": "9pm", "parent_id": parent["id"]},
    ).json()

    # Alice replies to Bob's reply (reply-to-reply) — now accepted.
    assert _login(client, email="alice@example.com").status_code == 200
    nested = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"body": "thanks", "parent_id": reply["id"]},
    )
    assert nested.status_code == 201

    listing = client.get(f"/api/events/{event.event_id}/messages").json()
    top = listing["items"][0]
    assert top["id"] == parent["id"]
    # Both descendants are flattened under the top post, chronological.
    assert top["reply_count"] == 2
    bodies = [r["body"] for r in top["replies"]]
    assert bodies == ["9pm", "thanks"]
    # Direct reply to the top post carries no @mention…
    assert top["replies"][0]["reply_to"] is None
    # …but the reply-to-reply mentions the addressed author (Bob).
    assert top["replies"][1]["reply_to"] is not None


@pytest.mark.unit
def test_delete_permissions_and_soft_delete(client, session, event):
    assert _login(client, email="alice@example.com").status_code == 200
    msg = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "other", "body": "Lost my jacket"},
    ).json()

    # A different (non-admin) user cannot delete it.
    assert _login(client, email="mallory@example.com").status_code == 200
    assert (
        client.delete(f"/api/events/{event.event_id}/messages/{msg['id']}").status_code
        == 403
    )

    # The author can, and it disappears from the public listing.
    assert _login(client, email="alice@example.com").status_code == 200
    assert (
        client.delete(f"/api/events/{event.event_id}/messages/{msg['id']}").status_code
        == 204
    )
    assert client.get(f"/api/events/{event.event_id}/messages").json()["total"] == 0
    row = session.get(EventMessage, UUID(msg["id"]))
    assert row is not None and row.deleted_at is not None


@pytest.mark.unit
def test_report_notifies_admin_and_is_idempotent(client, session, event):
    # Create the admin account so it can receive the report notification.
    assert _login(client, email="admin@example.com").status_code == 200
    assert _login(client, email="alice@example.com").status_code == 200
    msg = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "other", "body": "spammy content"},
    ).json()

    assert _login(client, email="bob@example.com").status_code == 200
    r1 = client.post(
        f"/api/events/{event.event_id}/messages/{msg['id']}/report",
        json={"reason": "spam"},
    )
    assert r1.status_code == 204
    # Duplicate report from the same user is a no-op.
    r2 = client.post(
        f"/api/events/{event.event_id}/messages/{msg['id']}/report",
        json={"reason": "spam again"},
    )
    assert r2.status_code == 204
    assert len(session.exec(select(EventMessageReport)).all()) == 1

    admin = _user(session, "admin@example.com")
    admin_notifs = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == admin.id)
        .where(Notification.kind == "event_message_reported")
    ).all()
    assert len(admin_notifs) == 1


@pytest.mark.unit
def test_post_fans_out_to_going_user(client, session, event):
    # Bob is going to the event (engaged) before Alice posts.
    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    session.add(
        UserEventAttendance(
            device_id="dev-bob",
            event_id=event.event_id,
            user_id=bob.id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()

    assert _login(client, email="alice@example.com").status_code == 200
    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "accommodation", "body": "Looking for a roommate"},
    )
    assert posted.status_code == 201

    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.kind == "event_message")
    ).first()
    assert notif is not None
    assert notif.event_id == event.event_id
    assert notif.context == "accommodation"


@pytest.mark.unit
def test_post_auto_engages_author(client, session, event):
    # Alice is not engaged with the event before posting.
    assert _login(client, email="alice@example.com").status_code == 200
    alice = _user(session, "alice@example.com")
    before = session.exec(
        select(UserSavedEvent)
        .where(UserSavedEvent.event_id == event.event_id)
        .where(UserSavedEvent.user_id == alice.id)
    ).first()
    assert before is None

    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "Is there a beginner lesson?"},
    )
    assert posted.status_code == 201

    # Posting auto-saves the event (private audience) so the author is engaged.
    saved = session.exec(
        select(UserSavedEvent)
        .where(UserSavedEvent.event_id == event.event_id)
        .where(UserSavedEvent.user_id == alice.id)
    ).all()
    assert len(saved) == 1
    assert saved[0].audience == "private"

    # Posting again does not create a second engagement row (idempotent).
    again = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "ride", "body": "Driving in around 7?"},
    )
    assert again.status_code == 201
    saved_after = session.exec(
        select(UserSavedEvent)
        .where(UserSavedEvent.event_id == event.event_id)
        .where(UserSavedEvent.user_id == alice.id)
    ).all()
    assert len(saved_after) == 1


@pytest.mark.unit
def test_post_does_not_auto_engage_when_already_going(client, session, event):
    # Bob is already Going → no extra saved row is created on post.
    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    session.add(
        UserEventAttendance(
            device_id="dev-bob",
            event_id=event.event_id,
            user_id=bob.id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()

    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "What time do doors open?"},
    )
    assert posted.status_code == 201
    saved = session.exec(
        select(UserSavedEvent)
        .where(UserSavedEvent.event_id == event.event_id)
        .where(UserSavedEvent.user_id == bob.id)
    ).all()
    assert saved == []


@pytest.mark.unit
def test_post_blocked_on_past_event(client, session):
    ev = CachedEvent(
        event_id="evt-past-1",
        calendar_id="cal-1",
        title="Last Week's Social",
        start=datetime(2000, 1, 1, 20, 0, 0),
        end=datetime(2000, 1, 1, 23, 0, 0),
    )
    session.add(ev)
    session.commit()

    assert _login(client, email="alice@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{ev.event_id}/messages",
        json={"category": "accommodation", "body": "Any roommates left?"},
    )
    assert resp.status_code == 409
    # Reading the (empty) past-event board is still allowed.
    read = client.get(f"/api/events/{ev.event_id}/messages")
    assert read.status_code == 200
    assert read.json()["total"] == 0


@pytest.mark.unit
def test_instant_delivery_fires_at_post_time(client, session, event, monkeypatch):
    """When the admin has enabled instant email for event messages, posting a
    message delivers the email immediately (no scheduler tick) with a
    content-aware subject, stamping ``instant_emailed_at`` on the recipient's
    notification so the digest scheduler skips it."""
    from backend.db.models import SiteSetting
    from backend.services import event_message_instant as em_instant

    # Admin routes event messages to instant email.
    session.add(SiteSetting(key="event_messages_email_instant", value="true"))
    session.commit()

    # Capture the content-aware email instead of really sending it.
    sent: list = []
    monkeypatch.setattr(
        em_instant,
        "send_event_message_instant_email",
        lambda user, actor, ev, kind, category, snippet: (
            sent.append((user.email, actor.display_name, kind, category, snippet))
            or True
        ),
    )
    monkeypatch.setattr(em_instant, "webpush_configured", lambda: False)

    # Bob is engaged (Going) before Alice posts, and has an email on file.
    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    session.add(
        UserEventAttendance(
            device_id="dev-bob",
            event_id=event.event_id,
            user_id=bob.id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()

    assert _login(client, email="alice@example.com").status_code == 200
    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "Is parking available nearby?"},
    )
    assert posted.status_code == 201

    # Email was dispatched instantly to the engaged recipient.
    assert len(sent) == 1
    assert sent[0][0] == "bob@example.com"
    assert sent[0][2] == "event_message"
    assert sent[0][3] == "question"

    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.kind == "event_message")
    ).first()
    assert notif is not None
    assert notif.instant_emailed_at is not None


@pytest.mark.unit
def test_instant_delivery_skipped_when_admin_toggle_off(
    client, session, event, monkeypatch
):
    """With instant email disabled (default), posting does not deliver an
    instant email — the notification stays pending for the digest scheduler."""
    from backend.services import event_message_instant as em_instant

    sent: list = []
    monkeypatch.setattr(
        em_instant,
        "send_event_message_instant_email",
        lambda *a, **k: sent.append(1) or True,
    )
    monkeypatch.setattr(em_instant, "webpush_configured", lambda: False)

    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    session.add(
        UserEventAttendance(
            device_id="dev-bob",
            event_id=event.event_id,
            user_id=bob.id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()

    assert _login(client, email="alice@example.com").status_code == 200
    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "Any beginner lesson first?"},
    )
    assert posted.status_code == 201

    assert sent == []
    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.kind == "event_message")
    ).first()
    assert notif is not None
    assert notif.instant_emailed_at is None


@pytest.mark.unit
def test_mute_suppresses_fan_out(client, session, event):
    """A Going user who muted the event receives no ``event_message``
    notification when someone else posts, and the mute is idempotent."""
    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    session.add(
        UserEventAttendance(
            device_id="dev-bob",
            event_id=event.event_id,
            user_id=bob.id,
            attending_since=datetime.utcnow(),
        )
    )
    session.commit()

    # Bob mutes the event (idempotent: a second PUT is still 204).
    assert client.put(f"/api/events/{event.event_id}/mute").status_code == 204
    assert client.put(f"/api/events/{event.event_id}/mute").status_code == 204
    assert (
        len(
            session.exec(
                select(UserEventMute).where(UserEventMute.user_id == bob.id)
            ).all()
        )
        == 1
    )

    assert _login(client, email="alice@example.com").status_code == 200
    posted = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "Beginner friendly?"},
    )
    assert posted.status_code == 201

    notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.kind == "event_message")
    ).first()
    assert notif is None

    # The muted flag is reflected in the board listing for the muter.
    assert _login(client, email="bob@example.com").status_code == 200
    listing = client.get(f"/api/events/{event.event_id}/messages").json()
    assert listing["muted"] is True

    # Unmuting is idempotent and clears the row + flag.
    assert client.delete(f"/api/events/{event.event_id}/mute").status_code == 204
    assert client.delete(f"/api/events/{event.event_id}/mute").status_code == 204
    assert (
        session.exec(select(UserEventMute).where(UserEventMute.user_id == bob.id)).all()
        == []
    )
    listing = client.get(f"/api/events/{event.event_id}/messages").json()
    assert listing["muted"] is False


@pytest.mark.unit
def test_message_counts_batch(client, session, event):
    """The batch counts endpoint returns top-level (non-reply) message counts
    per event, is open to anonymous visitors, and reports 0 for empty events."""
    assert _login(client, email="alice@example.com").status_code == 200
    parent = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "ride", "body": "Sharing a ride?"},
    ).json()
    client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "question", "body": "Doors at 8?"},
    )
    # A reply does not increment the top-level count.
    client.post(
        f"/api/events/{event.event_id}/messages",
        json={"body": "Yes!", "parent_id": parent["id"]},
    )

    # A second event with no messages returns 0.
    ev2 = CachedEvent(
        event_id="evt-msg-2",
        calendar_id="cal-1",
        title="Bachata Night",
        start=datetime(2099, 2, 1, 20, 0, 0),
        end=datetime(2099, 2, 2, 1, 0, 0),
    )
    session.add(ev2)
    session.commit()

    # Anonymous read is allowed.
    client.cookies.clear()
    resp = client.post(
        "/api/events/messages/counts",
        json={"event_ids": [event.event_id, ev2.event_id]},
    )
    assert resp.status_code == 200
    counts = {row["event_id"]: row["count"] for row in resp.json()}
    assert counts[event.event_id] == 2
    assert counts[ev2.event_id] == 0


@pytest.mark.unit
def test_reply_copy_personalized_for_root_author(client, session, event):
    """When a thread gets a reply, the root author's notification carries the
    ``root`` context sentinel (drives "replied to your message" copy), while
    other thread participants get the plain category context."""
    # Alice starts the thread; Bob replies (so both are participants).
    assert _login(client, email="alice@example.com").status_code == 200
    alice = _user(session, "alice@example.com")
    parent = client.post(
        f"/api/events/{event.event_id}/messages",
        json={"category": "ride", "body": "Ride from downtown?"},
    ).json()

    assert _login(client, email="bob@example.com").status_code == 200
    bob = _user(session, "bob@example.com")
    client.post(
        f"/api/events/{event.event_id}/messages",
        json={"body": "I can drive", "parent_id": parent["id"]},
    )

    # Carol replies to the thread → both Alice (root author) and Bob are notified.
    assert _login(client, email="carol@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/messages",
        json={"body": "Room for one more?", "parent_id": parent["id"]},
    )

    alice_reply_notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == alice.id)
        .where(Notification.kind == "event_message_reply")
    ).first()
    assert alice_reply_notif is not None
    assert alice_reply_notif.context == "root"

    bob_reply_notif = session.exec(
        select(Notification)
        .where(Notification.recipient_user_id == bob.id)
        .where(Notification.kind == "event_message_reply")
    ).first()
    assert bob_reply_notif is not None
    assert bob_reply_notif.context != "root"
