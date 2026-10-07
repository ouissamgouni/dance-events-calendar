"""Submitter editing of their own suggestions (pending phase)."""

import os
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-suggestion-edits")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.deps import require_admin  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import suggestions as suggestions_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventSuggestion,
    SuggestionAuditLog,
    TagSuggestion,
    User,
    UserEventAttendance,
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
    suggestions_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        suggestions_module.limiter.reset()


def _make_user(session: Session, email: str, handle: str) -> User:
    user = User(
        email=email,
        display_name=handle.title(),
        handle=handle,
        provider="google",
        provider_subject=f"mock|{email}",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _login(client: TestClient, email: str) -> None:
    r = client.post(
        "/api/auth/google", json={"credential": "ignored", "mock_email": email}
    )
    assert r.status_code == 200, r.text


def _submit(client: TestClient, **overrides) -> str:
    start = (datetime.now(timezone.utc) + timedelta(days=2)).replace(
        hour=20, minute=0, second=0, microsecond=0
    )
    body = {
        "title": "Salsa Socail",
        "start": start.isoformat(),
        "end": (start + timedelta(hours=3)).isoformat(),
        **overrides,
    }
    r = client.post("/api/suggestions", json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _rows(session: Session, suggestion_id: str) -> list[CachedEvent]:
    session.expire_all()
    return list(
        session.exec(
            select(CachedEvent)
            .where(CachedEvent.suggestion_id == UUID(suggestion_id))
            .order_by(CachedEvent.start)
        ).all()
    )


def test_owner_fixes_a_typo_and_it_is_audited(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}", json={"title": "Salsa Social"}
    )

    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Salsa Social"
    assert r.json()["can_edit"] is True
    assert [row.title for row in _rows(session, suggestion_id)] == ["Salsa Social"]
    audit = session.exec(select(SuggestionAuditLog)).all()
    assert [entry.action for entry in audit] == ["owner_edit"]
    assert audit[0].changes == {"title": ["Salsa Socail", "Salsa Social"]}


def test_new_tags_are_requested_at_submit_and_on_edit(client, session):
    olivia = _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(
        client, suggested_new_tags=[{"free_text": "Cuban", "group_slug": "style"}]
    )

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}",
        json={"suggested_new_tags": [{"free_text": "Rooftop", "group_slug": "venue"}]},
    )

    assert r.status_code == 200, r.text
    [row] = _rows(session, suggestion_id)
    requests = session.exec(select(TagSuggestion).order_by(TagSuggestion.id)).all()
    assert [(t.event_id, t.free_text, t.submitter_user_id) for t in requests] == [
        (row.event_id, "Cuban", olivia.id),
        (row.event_id, "Rooftop", olivia.id),
    ]
    assert (
        client.patch(
            f"/api/me/suggestions/{suggestion_id}", json={"suggested_tag_ids": [999]}
        ).status_code
        == 422
    )


def test_removing_a_submission_picture_clears_every_date(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=2")
    key = "suggestions/olivia/pic"
    suggestion = session.get(EventSuggestion, UUID(suggestion_id))
    suggestion.image_key = key
    session.add(suggestion)
    rows = _rows(session, suggestion_id)
    for row in rows:
        row.image_key = key
        session.add(row)
    session.commit()
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.delete(f"/api/admin/events/{rows[0].event_id}/image")

    assert r.status_code == 200, r.text
    session.expire_all()
    assert session.get(EventSuggestion, UUID(suggestion_id)).image_key is None
    assert [row.image_key for row in _rows(session, suggestion_id)] == [None, None]


def test_moving_a_weekly_series_keeps_ids_and_rsvps(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    gina = _make_user(session, "gina@example.com", "gina")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4")
    before = _rows(session, suggestion_id)
    assert len(before) == 4
    before_ids = [row.event_id for row in before]
    before_starts = [row.start for row in before]
    session.add(
        UserEventAttendance(
            device_id=str(gina.id), event_id=before_ids[2], user_id=gina.id
        )
    )
    session.commit()

    new_start = before_starts[0] + timedelta(days=1, hours=1)
    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}",
        json={
            "start": new_start.isoformat(),
            "end": (new_start + timedelta(hours=3)).isoformat(),
        },
    )

    assert r.status_code == 200, r.text
    after = _rows(session, suggestion_id)
    assert [row.event_id for row in after] == before_ids
    assert after[2].start == before_starts[2] + timedelta(days=1, hours=1)
    assert not any(row.is_hidden for row in after)
    going = session.exec(
        select(UserEventAttendance).where(UserEventAttendance.user_id == gina.id)
    ).one()
    assert going.event_id == after[2].event_id


def test_shrinking_a_pending_series_hides_the_extra_dates(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=4")

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}",
        json={"recurrence_rule": "RRULE:FREQ=WEEKLY;COUNT=2"},
    )

    assert r.status_code == 200, r.text
    rows = _rows(session, suggestion_id)
    assert len(rows) == 4
    assert [row.is_hidden for row in rows] == [False, False, True, True]


def test_owner_can_edit_a_single_day_all_day_event(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    day = (datetime.now(timezone.utc) + timedelta(days=3)).date().isoformat()
    suggestion_id = _submit(client, start=day, end=day, all_day=True)

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}",
        json={"title": "Salsa Day", "start": day, "end": day},
    )

    assert r.status_code == 200, r.text
    row = _rows(session, suggestion_id)[0]
    assert row.start.date().isoformat() == day
    assert row.end - row.start == timedelta(days=1)


def test_submission_takes_the_venue_time_zone_over_the_browser(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(
        client, latitude=38.7223, longitude=-9.1393, timezone="Europe/Paris"
    )

    assert _rows(session, suggestion_id)[0].timezone == "Europe/Lisbon"

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}", json={"event_timezone": "Europe/Madrid"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["timezone"] == "Europe/Madrid"
    assert _rows(session, suggestion_id)[0].timezone == "Europe/Madrid"


def test_non_owner_gets_404(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _make_user(session, "sam@example.com", "sam")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    event_id = _rows(session, suggestion_id)[0].event_id

    _login(client, "sam@example.com")
    assert client.get(f"/api/me/suggestions/{suggestion_id}").status_code == 404
    r = client.patch(f"/api/me/suggestions/{suggestion_id}", json={"title": "Mine"})
    assert r.status_code == 404
    assert client.get(f"/api/me/suggestions/for-event/{event_id}").json() is None


def test_for_event_returns_the_owners_suggestion(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    event_id = _rows(session, suggestion_id)[0].event_id

    r = client.get(f"/api/me/suggestions/for-event/{event_id}")

    assert r.status_code == 200
    assert r.json()["id"] == suggestion_id


def test_locked_suggestion_cannot_be_edited(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)

    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    r = client.patch(
        f"/api/admin/suggestions/{suggestion_id}", json={"edit_locked": True}
    )
    assert r.status_code == 200, r.text
    assert r.json()["edit_locked"] is True

    r = client.patch(f"/api/me/suggestions/{suggestion_id}", json={"title": "New"})
    assert r.status_code == 409
    assert (
        client.get(f"/api/me/suggestions/{suggestion_id}").json()["can_edit"] is False
    )


def _approve(client: TestClient, session: Session, suggestion_id: str) -> None:
    from backend.db.models import CalendarSetting

    if session.get(CalendarSetting, "movida") is None:
        session.add(CalendarSetting(calendar_id="movida", name="Movida"))
        session.commit()
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    r = client.post(
        f"/api/admin/suggestions/{suggestion_id}/approve",
        json={"calendar_id": "movida"},
    )
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("verified,expected", [(True, True), (False, False)])
def test_organizer_submission_is_attributed_on_approval(
    client, session, verified, expected
):
    olivia = _make_user(session, "olivia@example.com", "olivia")
    olivia.is_verified_organizer = verified
    session.add(olivia)
    session.commit()
    _login(client, "olivia@example.com")
    suggestion_id = _submit(
        client,
        share_publicly=True,
        is_organizer=True,
        recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=2",
    )
    assert all(row.organizer_user_id is None for row in _rows(session, suggestion_id))

    _approve(client, session, suggestion_id)

    rows = _rows(session, suggestion_id)
    assert len(rows) == 2
    assert all((row.organizer_user_id == olivia.id) is expected for row in rows)


def test_approved_edit_waits_for_review_then_notifies_attendees(client, session):
    from backend.db.models import EventRevision, Notification

    olivia = _make_user(session, "olivia@example.com", "olivia")
    gina = _make_user(session, "gina@example.com", "gina")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, location="Club Havana")
    _approve(client, session, suggestion_id)
    live_id = _rows(session, suggestion_id)[0].event_id
    session.add(
        UserEventAttendance(device_id=str(gina.id), event_id=live_id, user_id=gina.id)
    )
    session.add(
        UserEventAttendance(
            device_id=str(olivia.id), event_id=live_id, user_id=olivia.id
        )
    )
    session.commit()

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}", json={"location": "Studio B"}
    )

    assert r.status_code == 200, r.text
    assert r.json()["pending_changes"] == {
        "location": {"old": "Club Havana", "new": "Studio B"}
    }
    assert [row.location for row in _rows(session, suggestion_id)] == ["Club Havana"]

    moderation = client.get(f"/api/admin/events/{live_id}/moderation").json()
    assert moderation["visibility"] == "public"
    assert moderation["submission"]["submitter"]["handle"] == "olivia"
    [revision] = moderation["open_revisions"]
    assert revision["source"] == "submitter"
    assert revision["affected_attendees"] == 1
    [change] = client.get("/api/admin/changes", params={"kind": "edit"}).json()["items"]
    assert change["affected_attendees"] == 1

    r = client.post(f"/api/admin/revisions/{revision['id']}/apply", json={})

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    assert r.json()["notified_count"] == 1
    assert [row.location for row in _rows(session, suggestion_id)] == ["Studio B"]
    changed = session.exec(
        select(Notification).where(Notification.kind == "event_changed")
    ).all()
    assert [(n.recipient_user_id, n.description) for n in changed] == [
        (gina.id, "Venue: Club Havana → Studio B")
    ]
    assert session.exec(
        select(Notification).where(
            Notification.recipient_user_id == olivia.id,
            Notification.kind == "suggestion_change_applied",
        )
    ).first()
    assert session.get(EventRevision, revision["id"]).decided_by == "admin@example.com"


def test_admin_change_to_every_date_survives_the_owners_next_edit(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(
        client, location="Club Havana", recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3"
    )
    _approve(client, session, suggestion_id)
    first, second, _ = _rows(session, suggestion_id)

    r = client.put(
        f"/api/admin/events/{second.event_id}/draft",
        json={"changes": {"location": "Studio B"}},
    )
    assert r.json()["series_dates"] == 3
    r = client.post(
        f"/api/admin/events/{second.event_id}/draft/publish",
        json={"notify": False, "scope": "series"},
    )
    assert r.status_code == 200, r.text
    assert [row.location for row in _rows(session, suggestion_id)] == ["Studio B"] * 3

    client.patch(f"/api/me/suggestions/{suggestion_id}", json={"title": "Salsa Social"})
    [revision] = client.get(f"/api/admin/events/{first.event_id}/moderation").json()[
        "open_revisions"
    ]
    client.post(f"/api/admin/revisions/{revision['id']}/apply", json={})

    rows = _rows(session, suggestion_id)
    assert {(row.title, row.location) for row in rows} == {("Salsa Social", "Studio B")}


def test_discarded_submitter_change_keeps_the_live_event(client, session):
    from backend.db.models import Notification

    olivia = _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    _approve(client, session, suggestion_id)
    client.patch(f"/api/me/suggestions/{suggestion_id}", json={"title": "Renamed"})
    live_id = _rows(session, suggestion_id)[0].event_id
    [revision] = client.get(f"/api/admin/events/{live_id}/moderation").json()[
        "open_revisions"
    ]

    r = client.post(f"/api/admin/revisions/{revision['id']}/discard")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"
    assert [row.title for row in _rows(session, suggestion_id)] == ["Salsa Socail"]
    assert (
        client.get(f"/api/me/suggestions/{suggestion_id}").json()["pending_changes"]
        is None
    )
    assert session.exec(
        select(Notification).where(
            Notification.recipient_user_id == olivia.id,
            Notification.kind == "suggestion_change_discarded",
        )
    ).first()


def test_withdrawing_a_request_keeps_the_event_and_delete_hides_it(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3")

    r = client.post(f"/api/me/suggestions/{suggestion_id}/withdraw")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "private"
    assert not any(row.is_hidden for row in _rows(session, suggestion_id))
    assert (
        client.post(f"/api/me/suggestions/{suggestion_id}/withdraw").status_code == 409
    )

    r = client.delete(f"/api/me/suggestions/{suggestion_id}")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "withdrawn"
    assert all(row.is_hidden for row in _rows(session, suggestion_id))


def test_private_event_can_be_sent_for_review_later(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, share_publicly=False)
    assert (
        client.get(f"/api/me/suggestions/{suggestion_id}").json()["status"] == "private"
    )

    r = client.post(f"/api/me/suggestions/{suggestion_id}/request-public")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"
    assert (
        client.post(f"/api/me/suggestions/{suggestion_id}/request-public").status_code
        == 409
    )


def test_open_public_requests_are_capped(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    ids = []
    for _ in range(suggestions_module.MAX_PENDING_PUBLIC_REQUESTS + 1):
        suggestions_module.limiter.reset()
        ids.append(_submit(client, share_publicly=False))

    statuses = [
        client.post(f"/api/me/suggestions/{sid}/request-public").status_code
        for sid in ids
    ]

    assert statuses == [200] * suggestions_module.MAX_PENDING_PUBLIC_REQUESTS + [429]


def test_declined_event_stays_with_its_owner_only(client, session):
    from backend.db.models import Notification

    olivia = _make_user(session, "olivia@example.com", "olivia")
    _make_user(session, "sam@example.com", "sam")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    event_id = _rows(session, suggestion_id)[0].event_id
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.post(
        f"/api/admin/suggestions/{suggestion_id}/decline",
        json={"admin_notes": "Not a dance event"},
    )

    assert r.status_code == 200, r.text
    assert client.get(f"/api/events/{event_id}").status_code == 200
    own = client.get(f"/api/me/suggestions/{suggestion_id}").json()
    assert own["status"] == "declined"
    assert own["rejection_reason"] == "Not a dance event"
    assert own["can_edit"] is True
    assert (
        client.get(f"/api/admin/events/{event_id}/moderation").json()["visibility"]
        == "private"
    )
    notification = session.exec(
        select(Notification).where(Notification.recipient_user_id == olivia.id)
    ).one()
    assert notification.kind == "suggestion_declined"
    assert notification.event_id == event_id

    _login(client, "sam@example.com")
    assert client.get(f"/api/events/{event_id}").status_code == 404


@pytest.mark.parametrize("deliver_via", ["job", "sweep"])
def test_decline_queues_the_decision_email(
    client, session, engine, monkeypatch, deliver_via
):
    from backend.db import database
    from backend.db.models import Notification
    from backend.services import job_queue
    from backend.services.scheduler import sweep_fanout_jobs

    olivia = _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    queued: list = []
    monkeypatch.setattr(
        job_queue, "enqueue", lambda name, key, delay=0: queued.append((name, key))
    )
    monkeypatch.setattr(database, "_engine", engine)
    sent: list = []
    monkeypatch.setattr(
        suggestions_module,
        "send_suggestion_decision_email",
        lambda user, title, **kw: sent.append((user.id, kw)) or True,
    )

    r = client.post(
        f"/api/admin/suggestions/{suggestion_id}/decline",
        json={"admin_notes": "Not a dance event"},
    )

    assert r.status_code == 200, r.text
    assert sent == []
    assert queued == [
        (
            suggestions_module.SUGGESTION_DECISION_JOB,
            f"{suggestion_id}:suggestion_declined",
        )
    ]
    for _ in range(2):  # a re-run must not re-send
        if deliver_via == "job":
            job_queue.run_job(*queued[0])
        else:
            sweep_fanout_jobs()
    assert [(uid, kw["approved"], kw["reason"]) for uid, kw in sent] == [
        (olivia.id, False, "Not a dance event")
    ]
    assert sweep_fanout_jobs() == {"jobs": 0, "failed": 0}
    assert sent[0][1]["kept_private"] is True
    session.expire_all()
    notification = session.exec(
        select(Notification).where(Notification.recipient_user_id == olivia.id)
    ).one()
    assert notification.emailed_at is not None


def test_blocked_event_is_gone_for_its_owner_too(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, share_publicly=False)
    event_id = _rows(session, suggestion_id)[0].event_id
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.post(f"/api/admin/suggestions/{suggestion_id}/block", json={})

    assert r.status_code == 200, r.text
    assert client.get(f"/api/events/{event_id}").status_code == 404
    assert (
        client.get(f"/api/me/suggestions/{suggestion_id}").json()["can_edit"] is False
    )


def test_admin_filters_events_by_audience_status_and_flags(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    _submit(client, title="Mine", share_publicly=False)
    requested_id = _submit(client, title="Ours")
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    def titles(**params):
        r = client.get("/api/admin/events", params=params)
        assert r.status_code == 200, r.text
        return {
            (e["title"], e["visibility_state"], e["wants_public"])
            for e in r.json()["items"]
        }

    assert titles(audience="private") == {
        ("Mine", "private", False),
        ("Ours", "private", True),
    }
    assert titles(flags="wants_public") == {("Ours", "private", True)}
    assert titles(audience="private", status="published", flags="wants_public") == {
        ("Ours", "private", True)
    }
    assert titles(audience="public") == set()
    _approve(client, session, requested_id)
    assert titles(audience="public") == {("Ours", "public", False)}
    assert titles(flags="submitted") == {
        ("Mine", "private", False),
        ("Ours", "public", False),
    }
    assert titles(status="new") == set()
    assert (
        client.get("/api/admin/events", params={"audience": "blocked"}).status_code
        == 422
    )


def test_admin_groups_series_and_returns_the_organizer(client, session):
    from backend.db.models import CalendarSetting, EventSeries, EventSeriesMember

    olivia = _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    _submit(client, title="Weekly", recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3")
    _submit(client, title="Once")
    session.add(CalendarSetting(calendar_id="movida", name="Movida"))
    start = datetime.now(timezone.utc) + timedelta(days=3)
    for n in range(2):
        session.add(
            CachedEvent(
                event_id=f"rueda-{n}",
                calendar_id="movida",
                title="Rueda",
                start=start + timedelta(weeks=n),
                end=start + timedelta(weeks=n, hours=2),
                organizer_user_id=olivia.id if n == 0 else None,
            )
        )
    series = EventSeries(status="resolved", canonical_title="Rueda")
    session.add(series)
    session.commit()
    for n in range(2):
        session.add(EventSeriesMember(series_id=series.id, event_id=f"rueda-{n}"))
    session.commit()
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    def rows(**params):
        r = client.get("/api/admin/events", params=params)
        assert r.status_code == 200, r.text
        return sorted(
            (e["title"], e["in_series"], e["occurrence_count"])
            for e in r.json()["items"]
        )

    assert rows(group="series") == [
        ("Once", False, 1),
        ("Rueda", True, 2),
        ("Weekly", True, 3),
    ]
    assert ("Rueda", True, None) in rows()
    organizer = client.get("/api/admin/events/rueda-0").json()["organizer"]
    assert organizer["handle"] == "olivia"
    assert client.get("/api/admin/events/rueda-1").json()["organizer"] is None


def test_filter_options_count_each_group_against_the_others(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    _submit(client, title="Mine", share_publicly=False)
    _submit(client, title="Ours")
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.get(
        "/api/admin/events/filter-options",
        params={"audience": "private", "flags": "wants_public"},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    counts = lambda group: {o["value"]: o["count"] for o in body[group]}  # noqa: E731
    # Audience counts ignore the audience pick but keep the wants_public flag.
    assert counts("audiences") == {"public": 0, "private": 1}
    assert counts("statuses") == {
        "new": 0,
        "published": 1,
        "unpublished": 0,
        "cancelled": 0,
        "removed": 0,
    }
    assert counts("flags") == {"submitted": 2, "wants_public": 1, "changes": 0}
    assert body["total_count"] == 1


def test_admin_marks_a_private_submission_reviewed(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(
        client, share_publicly=False, recurrence_rule="RRULE:FREQ=WEEKLY;COUNT=3"
    )
    rows = _rows(session, suggestion_id)
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.patch(
        f"/api/admin/events/{rows[0].event_id}", json={"review_status": "reviewed"}
    )

    assert r.status_code == 200, r.text
    assert r.json()["visibility_state"] == "private"
    session.expire_all()
    assert {row.review_status for row in _rows(session, suggestion_id)} == {"reviewed"}
    assert {row.visibility for row in _rows(session, suggestion_id)} == {"private"}


def test_submissions_need_no_event_review(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    private_id = _submit(client, title="Mine", share_publicly=False)
    requested_id = _submit(client, title="Ours")
    event_ids = [_rows(session, sid)[0].event_id for sid in (private_id, requested_id)]
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.post("/api/admin/events/bulk-review", json={"event_ids": event_ids})

    assert r.json() == {"marked_reviewed": 0, "skipped_submissions": 0}
    assert {_rows(session, sid)[0].status for sid in (private_id, requested_id)} == {
        "published"
    }
    changes = client.get("/api/admin/changes").json()
    assert [(c["kind"], c["event"]["title"]) for c in changes["items"]] == [
        ("go_public", "Ours")
    ]


def test_decline_closes_the_request_and_a_new_request_reopens_it(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    client.post(f"/api/admin/suggestions/{suggestion_id}/decline", json={})
    session.expire_all()
    assert {r.review_status for r in _rows(session, suggestion_id)} == {"reviewed"}
    assert {r.visibility for r in _rows(session, suggestion_id)} == {"private"}
    decided = client.get("/api/admin/changes", params={"state": "decided"}).json()
    assert [(c["kind"], c["status"]) for c in decided["items"]] == [
        ("go_public", "rejected")
    ]

    r = client.post(f"/api/me/suggestions/{suggestion_id}/request-public")
    assert r.status_code == 200, r.text
    session.expire_all()
    assert {r.review_status for r in _rows(session, suggestion_id)} == {"reviewed"}
    assert client.get("/api/admin/changes").json()["total"] == 1


def test_owner_edit_keeps_a_reviewed_private_event_reviewed(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client, share_publicly=False)
    event_id = _rows(session, suggestion_id)[0].event_id
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}
    client.patch(f"/api/admin/events/{event_id}", json={"review_status": "reviewed"})

    r = client.patch(f"/api/me/suggestions/{suggestion_id}", json={"title": "Renamed"})

    assert r.status_code == 200, r.text
    session.expire_all()
    assert {r.review_status for r in _rows(session, suggestion_id)} == {"reviewed"}


def test_similar_events_offers_public_lookalikes_only(client, session):
    start = (datetime.now(timezone.utc) + timedelta(days=5)).replace(microsecond=0)
    for event_id, title, visibility in (
        ("public-1", "Salsa Social Havana", "public"),
        ("private-1", "Salsa Social Havana", "private"),
        ("other-1", "Bachata Workshop", "public"),
    ):
        session.add(
            CachedEvent(
                event_id=event_id,
                calendar_id="movida",
                title=title,
                start=start,
                end=start + timedelta(hours=3),
                review_status="reviewed",
                visibility=visibility,
            )
        )
    session.commit()

    r = client.get(
        "/api/suggestions/similar",
        params={"title": "Salsa Social at Havana", "start": start.isoformat()},
    )

    assert r.status_code == 200, r.text
    assert [e["event_id"] for e in r.json()] == ["public-1"]


def test_end_before_start_is_rejected(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    start = _rows(session, suggestion_id)[0].start

    r = client.patch(
        f"/api/me/suggestions/{suggestion_id}",
        json={"end": (start - timedelta(hours=1)).isoformat()},
    )

    assert r.status_code == 422


def test_pending_submission_is_visible_to_its_submitter_only(client, session):
    from backend.db.models import SiteSetting

    _make_user(session, "olivia@example.com", "olivia")
    _make_user(session, "sam@example.com", "sam")
    # The toggle releases unreviewed synced events, never user submissions.
    session.add(SiteSetting(key="show_pending_events", value="true"))
    session.commit()
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    event_id = _rows(session, suggestion_id)[0].event_id

    r = client.get(f"/api/events/{event_id}")
    assert r.status_code == 200, r.text
    assert r.json()["owner_preview"] is True
    assert r.headers["cache-control"] == "private, no-store"
    r = client.post("/api/events/by-ids", json={"event_ids": [event_id]})
    assert [e["event_id"] for e in r.json()] == [event_id]

    _login(client, "sam@example.com")
    assert client.get(f"/api/events/{event_id}").status_code == 404
    r = client.post("/api/events/by-ids", json={"event_ids": [event_id]})
    assert r.json() == []
    assert event_id not in [e["event_id"] for e in client.get("/api/events").json()]


def test_admin_cannot_flip_a_submissions_review_status(client, session):
    _make_user(session, "olivia@example.com", "olivia")
    _login(client, "olivia@example.com")
    suggestion_id = _submit(client)
    event_id = _rows(session, suggestion_id)[0].event_id
    app.dependency_overrides[require_admin] = lambda: {"email": "admin@example.com"}

    r = client.patch(f"/api/admin/events/{event_id}", json={"review_status": "pending"})
    assert r.status_code == 409
    r = client.post("/api/admin/events/bulk-review", json={"event_ids": [event_id]})
    assert r.json() == {"marked_reviewed": 0, "skipped_submissions": 0}
    assert _rows(session, suggestion_id)[0].review_status == "reviewed"
