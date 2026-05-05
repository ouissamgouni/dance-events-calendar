"""Tests for the Rate Event feature: ratings + unified feedback envelope.

Mirrors the in-memory SQLite + DEV_AUTH approach used by test_auth_routes.py.
Covers:
- Auth gates (anonymous gets 401)
- Submit feedback envelope creates rating + linked TagSuggestion rows sharing
  feedback_submission_id
- Edit (re-submit) updates row in place and resets status="pending"
- Validation: low-stars require min 30-char comment; honeypot silently accepted
- Anonymity: reviewer_label is "Anonymous" when is_anonymous=True
- Aggregate excludes non-approved rows
- Profanity service auto-flags admin_notes
- User per-hour rate limit
- Account deletion soft-anonymises ratings (preserves aggregate)
- Batch aggregate cap (200)
- Admin pagination + status filter
- Admin approve/reject and linked tag-suggestion approve/reject independence
"""

import os
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

os.environ.setdefault("SESSION_SECRET", "test-secret-for-ratings")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ["DEV_AUTH"] = "true"

from backend.api.main import app  # noqa: E402
from backend.api.routes import auth as auth_module  # noqa: E402
from backend.api.routes import ratings as ratings_module  # noqa: E402
from backend.db.database import get_session  # noqa: E402
from backend.db.models import (  # noqa: E402
    CachedEvent,
    EventRating,
    EventTag,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
)
# EventTag is imported only to assert that approving a rating does *not* mutate
# the event's first-class tags (review tags stay attached to the review row).


# ── Fixtures ──────────────────────────────────────────────────────────


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
    ratings_module.limiter.reset()
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def event(session):
    """Insert a cached event the rating routes can attach to."""
    ev = CachedEvent(
        event_id="evt-test-1",
        calendar_id="cal-1",
        title="Test Event",
        description=None,
        location=None,
        latitude=None,
        longitude=None,
        start=datetime(2099, 1, 1, 20, 0, 0),
        end=datetime(2099, 1, 2, 1, 0, 0),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


@pytest.fixture
def review_tag_group(session):
    """Insert the review-tags TagGroup with a couple of starter tags."""
    grp = TagGroup(
        slug="review-tags",
        label="Review tags",
        ordinal=100,
        allow_multiple=True,
        color="#f59e0b",
        scope="review",
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    t1 = Tag(group_id=grp.id, slug="great-music", label="Great music", ordinal=0)
    t2 = Tag(group_id=grp.id, slug="friendly-crowd", label="Friendly crowd", ordinal=1)
    session.add(t1)
    session.add(t2)
    session.commit()
    session.refresh(t1)
    session.refresh(t2)
    return grp, t1, t2


@pytest.fixture
def other_tag(session):
    """Tag in a non-review group (to make sure feedback also creates a TagSuggestion)."""
    grp = TagGroup(
        slug="format", label="Format", ordinal=10, allow_multiple=True, color="#f472b6"
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    t = Tag(group_id=grp.id, slug="social", label="Social", ordinal=0)
    session.add(t)
    session.commit()
    session.refresh(t)
    return t


def _login(client: TestClient, *, email: str):
    return client.post(
        "/api/auth/google",
        json={"credential": "ignored", "mock_email": email},
    )


# ── Tests ─────────────────────────────────────────────────────────────


@pytest.mark.unit
def test_submit_feedback_requires_auth(client, event):
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    assert resp.status_code == 401


@pytest.mark.unit
def test_submit_feedback_creates_rating_and_linked_suggestion(
    client, session, event, review_tag_group, other_tag
):
    _, t1, t2 = review_tag_group
    assert _login(client, email="user@example.com").status_code == 200

    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "comment": "Loved it!",
            "review_tag_ids": [t1.id, t2.id],
            "is_anonymous": False,
            "tag_suggestions": [{"tag_id": other_tag.id}],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    fsid = body["feedback_submission_id"]
    assert body["rating"]["stars"] == 5
    assert body["rating"]["status"] == "pending"
    assert sorted(body["rating"]["review_tag_ids"]) == sorted([t1.id, t2.id])
    assert len(body["tag_suggestion_ids"]) == 1

    # DB state
    rating = session.exec(select(EventRating)).one()
    assert str(rating.feedback_submission_id) == fsid
    sug = session.exec(select(TagSuggestion)).one()
    assert str(sug.feedback_submission_id) == fsid
    assert sug.tag_id == other_tag.id


@pytest.mark.unit
def test_edit_resets_status_to_pending(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200

    body = {
        "stars": 5,
        "comment": None,
        "review_tag_ids": [],
        "is_anonymous": False,
        "tag_suggestions": [],
    }
    r1 = client.post(f"/api/events/{event.event_id}/feedback", json=body)
    assert r1.status_code == 201

    # Approve via direct DB write
    rating = session.exec(select(EventRating)).one()
    rating.status = "approved"
    session.add(rating)
    session.commit()

    # Re-submit should reset to pending
    body["stars"] = 4
    r2 = client.post(f"/api/events/{event.event_id}/feedback", json=body)
    assert r2.status_code == 201
    assert r2.json()["rating"]["status"] == "pending"
    session.refresh(rating)
    assert rating.status == "pending"
    assert rating.stars == 4


@pytest.mark.unit
def test_low_stars_require_min_comment(client, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 1,
            "comment": "bad",
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_honeypot_silent_accept(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
            "website": "spam-bot.example.com",
        },
    )
    assert resp.status_code == 201
    # No real row written
    assert session.exec(select(EventRating)).first() is None


@pytest.mark.unit
def test_aggregate_excludes_non_approved(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    # pending rating → aggregate empty
    assert agg["count"] == 0
    assert agg["average"] == 0.0

    # Approve and re-check
    rating = session.exec(select(EventRating)).one()
    rating.status = "approved"
    session.add(rating)
    session.commit()
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    assert agg["average"] == 5.0
    assert agg["distribution"]["5"] == 1


@pytest.mark.unit
def test_profanity_auto_flags(client, session, event, monkeypatch):
    monkeypatch.setattr(ratings_module, "contains_profanity", lambda s: True)
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "comment": "anything",
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    rating = session.exec(select(EventRating)).one()
    assert rating.admin_notes and "auto-flagged" in rating.admin_notes


@pytest.mark.unit
def test_anonymity_reviewer_label(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": True,
            "tag_suggestions": [],
        },
    )
    rating = session.exec(select(EventRating)).one()
    rating.status = "approved"
    session.add(rating)
    session.commit()
    reviews = client.get(f"/api/events/{event.event_id}/reviews").json()
    assert reviews["items"][0]["reviewer_label"] == "Anonymous"


@pytest.mark.unit
def test_user_rate_limit(client, session, event):
    """The per-user hourly cap should kick in well before slowapi's IP cap."""
    # Lower the limit to make the test fast.
    ratings_module._HOUR_LIMIT = 2
    try:
        assert _login(client, email="user@example.com").status_code == 200
        body = {
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        }
        # Need separate events since (user_id, event_id) is unique → make 3 events.
        for i in range(3):
            ev = CachedEvent(
                event_id=f"evt-rl-{i}",
                calendar_id="cal-1",
                title=f"Event {i}",
                start=datetime(2099, 1, 1, 20, 0, 0),
                end=datetime(2099, 1, 1, 22, 0, 0),
            )
            session.add(ev)
        session.commit()
        assert (
            client.post("/api/events/evt-rl-0/feedback", json=body).status_code == 201
        )
        assert (
            client.post("/api/events/evt-rl-1/feedback", json=body).status_code == 201
        )
        assert (
            client.post("/api/events/evt-rl-2/feedback", json=body).status_code == 429
        )
    finally:
        ratings_module._HOUR_LIMIT = 5


@pytest.mark.unit
def test_account_deletion_preserves_aggregate(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 4,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    rating = session.exec(select(EventRating)).one()
    rating.status = "approved"
    session.add(rating)
    session.commit()

    # Delete the account
    resp = client.delete("/api/auth/me")
    assert resp.status_code in (200, 204)

    # Aggregate unchanged
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    assert agg["average"] == 4.0

    # Row anonymised
    session.expire_all()
    rating = session.exec(select(EventRating)).one()
    assert rating.user_id is None
    assert rating.is_anonymous is True


@pytest.mark.unit
def test_batch_aggregate_cap(client):
    too_many = [str(uuid4()) for _ in range(201)]
    resp = client.post("/api/events/ratings/aggregate", json={"event_ids": too_many})
    assert resp.status_code == 422


@pytest.mark.unit
def test_admin_pagination_and_status_filter(client, session, event):
    # Submit 3 ratings as 3 users
    body = {
        "stars": 5,
        "review_tag_ids": [],
        "is_anonymous": False,
        "tag_suggestions": [],
    }
    # Need more events because of unique (user_id, event_id)
    for i in range(2):
        ev = CachedEvent(
            event_id=f"evt-extra-{i}",
            calendar_id="cal-1",
            title=f"Extra {i}",
            start=datetime(2099, 1, 1, 20, 0, 0),
            end=datetime(2099, 1, 1, 22, 0, 0),
        )
        session.add(ev)
    session.commit()

    targets = [event.event_id, "evt-extra-0", "evt-extra-1"]
    for i, eid in enumerate(targets):
        assert _login(client, email=f"u{i}@example.com").status_code == 200
        assert client.post(f"/api/events/{eid}/feedback", json=body).status_code == 201

    # Become admin
    assert _login(client, email="admin@example.com").status_code == 200

    # Approve one row directly
    rating = session.exec(select(EventRating)).first()
    rating.status = "approved"
    session.add(rating)
    session.commit()

    pending = client.get(
        "/api/admin/feedback?status=pending&page=1&page_size=10"
    ).json()
    approved = client.get(
        "/api/admin/feedback?status=approved&page=1&page_size=10"
    ).json()
    assert pending["total"] == 2
    assert approved["total"] == 1

    # Pagination
    page1 = client.get("/api/admin/feedback?page=1&page_size=2").json()
    page2 = client.get("/api/admin/feedback?page=2&page_size=2").json()
    assert page1["total"] == 3
    assert len(page1["items"]) == 2
    assert len(page2["items"]) == 1


@pytest.mark.unit
def test_admin_approve_rating_independent_of_suggestions(
    client, session, event, other_tag
):
    # Submit feedback envelope with one linked tag suggestion
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [],
            "is_anonymous": False,
            "tag_suggestions": [{"tag_id": other_tag.id}],
        },
    )
    assert resp.status_code == 201
    rating_id = resp.json()["rating"]["id"]

    # Become admin and approve the rating
    assert _login(client, email="admin@example.com").status_code == 200
    approve = client.post(f"/api/admin/ratings/{rating_id}/approve", json={})
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    # The linked TagSuggestion should still be pending (independent moderation)
    sug = session.exec(select(TagSuggestion)).one()
    session.refresh(sug)
    assert sug.status == "pending"


@pytest.mark.unit
def test_admin_approve_does_not_propagate_review_tags_to_event_tags(
    client, session, event, review_tag_group
):
    """Approving a rating must NOT attach its review tags to the event.

    Review tags describe subjective experience ("loud", "friendly crowd") and
    are surfaced as filter chips inside the reviews list only, mirroring how
    Google/Yelp/TripAdvisor handle aspect tags. They must not become
    first-class taxonomy tags or one anonymous reviewer could pollute the
    explorer filters for everyone.
    """
    _, t1, t2 = review_tag_group
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "stars": 5,
            "review_tag_ids": [t1.id, t2.id],
            "is_anonymous": False,
            "tag_suggestions": [],
        },
    )
    assert resp.status_code == 201
    rating_id = resp.json()["rating"]["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    approve = client.post(f"/api/admin/ratings/{rating_id}/approve", json={})
    assert approve.status_code == 200

    # Event tags must remain untouched by review-tag approval.
    assert (
        session.exec(select(EventTag).where(EventTag.event_id == event.event_id)).all()
        == []
    )

    # The review row itself still carries the tags for review-list filtering.
    rating = session.exec(
        select(EventRating).where(EventRating.event_id == event.event_id)
    ).one()
    assert sorted(rating.review_tag_ids or []) == sorted([t1.id, t2.id])


# ── Tag-group scope separation ────────────────────────────────────────
#
# Review tags live in their own namespace (TagGroup.scope='review') so
# they cannot leak into the event-classification surfaces:
#   - the public `/api/tags` listing (explorer filter)
#   - the public `/api/tags/suggestions` form
#   - the admin event-tag PUT
# Mirrors the Google/Yelp/Airbnb separation between place attributes and
# review aspects.


@pytest.fixture
def event_tag_group(session):
    """Create an event-scope group so the public tag list has something to return."""
    grp = TagGroup(
        slug="format",
        label="Format",
        ordinal=10,
        allow_multiple=True,
        color="#f472b6",
        scope="event",
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    t = Tag(group_id=grp.id, slug="social", label="Social", ordinal=0)
    session.add(t)
    session.commit()
    session.refresh(t)
    return grp, t


@pytest.mark.unit
def test_public_tag_list_excludes_review_scope_groups(
    client, event_tag_group, review_tag_group
):
    resp = client.get("/api/tags")
    assert resp.status_code == 200
    slugs = {g["slug"] for g in resp.json()}
    assert "format" in slugs
    assert "review-tags" not in slugs


@pytest.mark.unit
def test_public_tag_list_scope_review_returns_review_groups(
    client, event_tag_group, review_tag_group
):
    resp = client.get("/api/tags?scope=review")
    assert resp.status_code == 200
    payload = resp.json()
    slugs = {g["slug"] for g in payload}
    assert slugs == {"review-tags"}
    # Scope is echoed so the client can sanity-check.
    assert payload[0]["scope"] == "review"


@pytest.mark.unit
def test_public_tag_list_scope_invalid_rejected(client):
    resp = client.get("/api/tags?scope=bogus")
    assert resp.status_code == 422


@pytest.mark.unit
def test_tag_suggestion_rejects_review_scope_tag(client, event, review_tag_group):
    """A reviewer-vocabulary tag must not be suggestable as an event tag."""
    _, t1, _ = review_tag_group
    resp = client.post(
        "/api/tags/suggestions",
        json={
            "event_id": event.event_id,
            "tag_id": t1.id,
            "device_id": "dev-1",
        },
    )
    assert resp.status_code == 400
    assert "review" in resp.json()["detail"].lower()


@pytest.mark.unit
def test_tag_suggestion_rejects_review_scope_group_slug(
    client, event, review_tag_group
):
    """Free-text suggestions targeting the review-tags group are rejected too."""
    resp = client.post(
        "/api/tags/suggestions",
        json={
            "event_id": event.event_id,
            "free_text": "loud-bar",
            "group_slug": "review-tags",
            "device_id": "dev-1",
        },
    )
    assert resp.status_code == 400


@pytest.mark.unit
def test_admin_event_tag_assignment_rejects_review_scope_tag(
    client, session, event, event_tag_group, review_tag_group
):
    """Defence-in-depth: even an admin cannot attach a review-scope tag to an event."""
    _, social = event_tag_group
    _, rt1, _ = review_tag_group

    assert _login(client, email="admin@example.com").status_code == 200

    # Mixing one valid event-scope id and one review-scope id must reject the whole call.
    resp = client.put(
        f"/api/admin/events/{event.event_id}/tags",
        json={"tag_ids": [social.id, rt1.id]},
    )
    assert resp.status_code == 400
    assert "review" in resp.json()["detail"].lower()

    # Single-tag POST endpoint is also guarded.
    resp2 = client.post(
        f"/api/admin/events/{event.event_id}/tags/{rt1.id}",
    )
    assert resp2.status_code == 400

    # Sanity: the event still has no tags after the rejected calls.
    assert (
        session.exec(select(EventTag).where(EventTag.event_id == event.event_id)).all()
        == []
    )
