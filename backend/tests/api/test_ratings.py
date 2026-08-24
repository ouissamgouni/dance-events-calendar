"""Tests for the adaptive review feature: reviews + unified feedback envelope.

Mirrors the in-memory SQLite + DEV_AUTH approach used by test_auth_routes.py.
Covers:
- Auth gates (anonymous gets 401)
- Submit feedback envelope creates review + aspect scores/tags + linked
  TagSuggestion rows sharing feedback_submission_id
- Structured signals count live (status defaults to "approved"); only the
  free-text comment is moderated (comment_status)
- Edit (re-submit) updates the row in place; a new comment resets
  comment_status to "pending"
- Validation: invalid sentiment rejected; honeypot silently accepted; unknown
  aspect slugs / out-of-range scores dropped
- Anonymity: reviewer_label is "Anonymous" when is_anonymous=True
- Aggregate: sentiment distribution, per-aspect averages, polarity-split tags,
  audience tags; excludes rejected rows
- Comment stays hidden until comment_status == "approved"
- Profanity service auto-flags admin_notes
- User per-hour rate limit
- Account deletion soft-anonymises reviews (preserves aggregate)
- Batch aggregate cap (200)
- Admin comment-moderation queue + approve/reject
- Tag-group scope separation (aspect / audience vs event)
"""

import os
from datetime import datetime, timedelta
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
    EventRatingAspectScore,
    EventRatingAspectTag,
    EventSeries,
    EventSeriesMember,
    EventTag,
    SiteSetting,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
    UserEventAttendance,
    UserFollow,
)
# EventTag is imported only to assert that approving a review does *not* mutate
# the event's first-class tags.


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
    """Insert a cached event the review routes can attach to."""
    ev = CachedEvent(
        event_id="evt-test-1",
        calendar_id="cal-1",
        title="Test Event",
        description=None,
        location=None,
        latitude=None,
        longitude=None,
        start=datetime(2020, 1, 1, 20, 0, 0),
        end=datetime(2020, 1, 2, 1, 0, 0),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


@pytest.fixture
def aspect_group(session):
    """Insert a scope='aspect' group ("music") with a positive + negative tag."""
    grp = TagGroup(
        slug="music",
        label="Music",
        ordinal=100,
        allow_multiple=True,
        color="#f59e0b",
        scope="aspect",
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    pos = Tag(
        group_id=grp.id,
        slug="great-dj",
        label="Great DJ",
        ordinal=0,
        polarity="positive",
    )
    neg = Tag(
        group_id=grp.id,
        slug="too-loud",
        label="Too loud",
        ordinal=1,
        polarity="negative",
    )
    session.add(pos)
    session.add(neg)
    session.commit()
    session.refresh(pos)
    session.refresh(neg)
    return grp, pos, neg


@pytest.fixture
def audience_group(session):
    """Insert a scope='audience' group with a couple of neutral tags."""
    grp = TagGroup(
        slug="audience",
        label="Recommended for",
        ordinal=110,
        allow_multiple=True,
        color="#0ea5e9",
        scope="audience",
    )
    session.add(grp)
    session.commit()
    session.refresh(grp)
    a1 = Tag(group_id=grp.id, slug="beginners", label="Beginners", ordinal=0)
    a2 = Tag(group_id=grp.id, slug="advanced", label="Advanced", ordinal=1)
    session.add(a1)
    session.add(a2)
    session.commit()
    session.refresh(a1)
    session.refresh(a2)
    return grp, a1, a2


@pytest.fixture
def other_tag(session):
    """Event-scope tag (used to assert feedback also creates a TagSuggestion)."""
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
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    assert resp.status_code == 401


@pytest.mark.unit
def test_submit_feedback_rejected_for_upcoming_event(client, session):
    """Upcoming editions can't be reviewed — reviews open only after the event."""
    ev = CachedEvent(
        event_id="evt-upcoming",
        calendar_id="cal-1",
        title="Future Social",
        start=datetime(2099, 1, 1, 20, 0, 0),
        end=datetime(2099, 1, 2, 1, 0, 0),
    )
    session.add(ev)
    session.commit()
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{ev.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    assert resp.status_code == 400
    assert session.exec(select(EventRating)).first() is None


@pytest.mark.unit
def test_read_endpoints_require_auth(client, event, series_events):
    """Reading full aggregates, review content and series roll-ups requires
    sign-in — anonymous callers get 401. The count-only batch aggregate is the
    exception (open to anon so signed-out cards/headers can show "N reviews")."""
    series, ev1, _ = series_events
    assert client.get(f"/api/events/{event.event_id}/rating").status_code == 401
    assert client.get(f"/api/events/{event.event_id}/reviews").status_code == 401
    assert client.get(f"/api/events/{event.event_id}/series").status_code == 401
    assert client.get(f"/api/series/{series.id}").status_code == 401
    # Count-only batch aggregate is open to anonymous visitors.
    assert (
        client.post(
            "/api/events/ratings/aggregate", json={"event_ids": [event.event_id]}
        ).status_code
        == 200
    )


@pytest.mark.unit
def test_batch_aggregate_returns_counts_for_anon(client, session, event):
    """A signed-out visitor can read review counts (only) via the batch
    aggregate endpoint — the content stays behind the auth-gated endpoints."""
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    # Drop the session cookie → subsequent requests are anonymous.
    client.cookies.clear()

    resp = client.post(
        "/api/events/ratings/aggregate", json={"event_ids": [event.event_id]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["event_id"] == event.event_id
    assert body[0]["count"] == 1
    # Full aggregate + review content remain gated for the same anon caller.
    assert client.get(f"/api/events/{event.event_id}/rating").status_code == 401
    assert client.get(f"/api/events/{event.event_id}/reviews").status_code == 401


@pytest.mark.unit
def test_submit_feedback_creates_review_and_linked_suggestion(
    client, session, event, aspect_group, audience_group, other_tag
):
    _, pos, neg = aspect_group
    _, aud1, _ = audience_group
    assert _login(client, email="user@example.com").status_code == 200

    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "aspect_scores": {"music": 5},
            "aspect_tag_ids": [pos.id],
            "audience_tag_ids": [aud1.id],
            "comment": "Loved it!",
            "is_anonymous": False,
            "tag_suggestions": [{"tag_id": other_tag.id}],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    fsid = body["feedback_submission_id"]
    assert body["rating"]["overall_sentiment"] == "amazing"
    assert body["rating"]["aspect_scores"] == {"music": 5}
    assert body["rating"]["aspect_tag_ids"] == [pos.id]
    assert body["rating"]["audience_tag_ids"] == [aud1.id]
    # Structured data counts live; only the comment is pending moderation.
    assert body["rating"]["status"] == "approved"
    assert body["rating"]["comment_status"] == "pending"
    assert len(body["tag_suggestion_ids"]) == 1

    # DB state
    rating = session.exec(select(EventRating)).one()
    assert str(rating.feedback_submission_id) == fsid
    assert rating.stars == 5  # derived from sentiment=amazing
    aspect_rows = session.exec(select(EventRatingAspectScore)).all()
    assert {(r.aspect_slug, r.score) for r in aspect_rows} == {("music", 5)}
    tag_rows = session.exec(select(EventRatingAspectTag)).all()
    assert {(r.aspect_slug, r.tag_id) for r in tag_rows} == {("music", pos.id)}
    sug = session.exec(select(TagSuggestion)).one()
    assert str(sug.feedback_submission_id) == fsid
    assert sug.tag_id == other_tag.id


@pytest.mark.unit
def test_unknown_aspect_and_out_of_range_scores_are_dropped(
    client, session, event, aspect_group
):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "great",
            # music is valid; parking unknown; venue out-of-range → dropped.
            "aspect_scores": {"music": 5, "parking": 3, "venue": 9},
            "tag_suggestions": [],
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["rating"]["aspect_scores"] == {"music": 5}


@pytest.mark.unit
def test_aspect_tag_from_wrong_scope_is_dropped(
    client, session, event, aspect_group, other_tag
):
    """Only scope='aspect' tags may be used as aspect tags."""
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "great",
            "aspect_tag_ids": [other_tag.id],  # event-scope → rejected
            "tag_suggestions": [],
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["rating"]["aspect_tag_ids"] == []


@pytest.mark.unit
def test_edit_updates_in_place_and_resets_comment_status(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200

    r1 = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    assert r1.status_code == 201
    assert r1.json()["rating"]["comment_status"] == "none"

    # Re-submit with a comment → in place, comment now pending.
    r2 = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "great",
            "comment": "Actually pretty good",
            "tag_suggestions": [],
        },
    )
    assert r2.status_code == 201
    assert r2.json()["rating"]["overall_sentiment"] == "great"
    assert r2.json()["rating"]["comment_status"] == "pending"
    assert session.exec(select(EventRating)).one().stars == 4  # sentiment=great


@pytest.mark.unit
def test_no_min_comment_rule_for_negative_sentiment(client, event):
    """The old min-30-char rule is gone; a short/absent comment is accepted."""
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "bad", "tag_suggestions": []},
    )
    assert resp.status_code == 201


@pytest.mark.unit
def test_invalid_sentiment_rejected(client, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "meh", "tag_suggestions": []},
    )
    assert resp.status_code == 422


@pytest.mark.unit
def test_honeypot_silent_accept(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "tag_suggestions": [],
            "website": "spam-bot.example.com",
        },
    )
    assert resp.status_code == 201
    # No real row written
    assert session.exec(select(EventRating)).first() is None


@pytest.mark.unit
def test_aggregate_counts_live_and_excludes_rejected(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    # Structured data counts immediately (no moderation gate).
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    assert agg["sentiment_distribution"]["amazing"] == 1

    # Reject the whole review → excluded from aggregate.
    rating = session.exec(select(EventRating)).one()
    rating.status = "rejected"
    session.add(rating)
    session.commit()
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 0


@pytest.mark.unit
def test_aggregate_includes_experience_breakdown(
    client, session, event, aspect_group, audience_group
):
    _, pos, neg = aspect_group
    _, aud1, aud2 = audience_group
    neutral = Tag(
        group_id=pos.group_id,
        slug="international-crowd",
        label="International crowd",
        ordinal=2,
        polarity="neutral",
    )
    session.add(neutral)
    session.commit()
    session.refresh(neutral)

    assert _login(client, email="alice@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "aspect_scores": {"music": 5},
            "aspect_tag_ids": [pos.id],
            "audience_tag_ids": [aud1.id],
            "tag_suggestions": [],
        },
    )
    assert _login(client, email="bruno@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "okay",
            "aspect_scores": {"music": 3},
            "aspect_tag_ids": [pos.id, neutral.id, neg.id],
            "audience_tag_ids": [aud1.id, aud2.id],
            "tag_suggestions": [],
        },
    )

    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 2
    assert agg["sentiment_distribution"]["amazing"] == 1
    assert agg["sentiment_distribution"]["okay"] == 1
    aspects = {a["aspect_slug"]: a for a in agg["aspects"]}
    assert aspects["music"]["average"] == 4.0
    assert aspects["music"]["count"] == 2
    pos_slugs = {t["slug"]: t["count"] for t in agg["top_positive_tags"]}
    neutral_slugs = {t["slug"]: t["count"] for t in agg["top_neutral_tags"]}
    neg_slugs = {t["slug"]: t["count"] for t in agg["top_negative_tags"]}
    assert pos_slugs == {"great-dj": 2}
    assert neutral_slugs == {"international-crowd": 1}
    assert neg_slugs == {"too-loud": 1}
    aud_slugs = {t["slug"]: t["count"] for t in agg["top_audience_tags"]}
    assert aud_slugs == {"beginners": 2, "advanced": 1}


@pytest.mark.unit
def test_update_review_replaces_aspects_without_unique_violation(
    client, session, event, aspect_group
):
    """Re-submitting a review must not collide on uq_event_rating_aspect_score /
    the aspect-tag unique constraint (regression: delete+insert now flush
    between phases)."""
    _, pos, neg = aspect_group
    assert _login(client, email="user@example.com").status_code == 200

    r1 = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "aspect_scores": {"music": 5},
            "aspect_tag_ids": [pos.id],
            "tag_suggestions": [],
        },
    )
    assert r1.status_code == 201, r1.text

    # Same aspect slug ("music") + same tag → would previously violate the
    # unique constraint because the new INSERT ran before the old DELETE.
    r2 = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "great",
            "aspect_scores": {"music": 3},
            "aspect_tag_ids": [pos.id, neg.id],
            "tag_suggestions": [],
        },
    )
    assert r2.status_code == 201, r2.text
    assert r2.json()["rating"]["aspect_scores"] == {"music": 3}
    assert set(r2.json()["rating"]["aspect_tag_ids"]) == {pos.id, neg.id}


@pytest.mark.unit
def test_aggregate_mood_headline_full_when_threshold_met(client, session, event):
    """Default threshold is 3; three reviews expose the computed mood label."""
    for email in ("a@example.com", "b@example.com", "c@example.com"):
        assert _login(client, email=email).status_code == 200
        client.post(
            f"/api/events/{event.event_id}/feedback",
            json={"overall_sentiment": "amazing", "tag_suggestions": []},
        )

    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 3
    assert agg["display_state"] == "full"
    assert agg["average_mood"] == pytest.approx(5.0)
    assert agg["positive_percentage"] == pytest.approx(100.0)
    assert agg["mood_label"] == "Exceptional"


@pytest.mark.unit
def test_aggregate_mood_early_below_threshold(client, session, event):
    assert _login(client, email="a@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "great", "tag_suggestions": []},
    )
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    assert agg["display_state"] == "early"
    assert agg["mood_label"] is None
    assert agg["positive_percentage"] == pytest.approx(100.0)


@pytest.mark.unit
def test_aggregate_mood_threshold_honours_site_setting(client, session, event):
    """Lowering review_mood_headline_min_reviews to 1 lets a single review
    show a full mood label."""
    session.add(SiteSetting(key="review_mood_headline_min_reviews", value="1"))
    session.commit()

    assert _login(client, email="a@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "great", "tag_suggestions": []},
    )
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["display_state"] == "full"
    assert agg["mood_label"] == "Highly enjoyed"  # avg 4.0


@pytest.fixture
def series_events(session):
    """Two editions of the same recurring event, joined by a resolved series."""
    ev1 = CachedEvent(
        event_id="evt-series-1",
        calendar_id="cal-1",
        title="Weekly Milonga",
        start=datetime(2020, 1, 1, 20, 0, 0),
        end=datetime(2020, 1, 2, 1, 0, 0),
    )
    ev2 = CachedEvent(
        event_id="evt-series-2",
        calendar_id="cal-1",
        title="Weekly Milonga",
        start=datetime(2020, 1, 8, 20, 0, 0),
        end=datetime(2020, 1, 9, 1, 0, 0),
    )
    session.add(ev1)
    session.add(ev2)
    series = EventSeries(
        status="resolved", source="manual", canonical_title="Weekly Milonga"
    )
    session.add(series)
    session.commit()
    session.refresh(series)
    session.add(EventSeriesMember(series_id=series.id, event_id=ev1.event_id))
    session.add(EventSeriesMember(series_id=series.id, event_id=ev2.event_id))
    session.commit()
    session.refresh(series)
    return series, ev1, ev2


@pytest.mark.unit
def test_event_series_rollup_none_when_not_in_resolved_series(client, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.get(f"/api/events/{event.event_id}/series")
    assert resp.status_code == 200
    assert resp.json() is None


@pytest.mark.unit
def test_series_rollup_unweighted_headline_and_pooled_breakdown(
    client, session, series_events
):
    series, ev1, ev2 = series_events

    # Edition 1: one "great" (4). Edition 2: two "amazing" (5).
    assert _login(client, email="a@example.com").status_code == 200
    client.post(
        f"/api/events/{ev1.event_id}/feedback",
        json={"overall_sentiment": "great", "tag_suggestions": []},
    )
    for email in ("b@example.com", "c@example.com"):
        assert _login(client, email=email).status_code == 200
        client.post(
            f"/api/events/{ev2.event_id}/feedback",
            json={"overall_sentiment": "amazing", "tag_suggestions": []},
        )

    roll = client.get(f"/api/series/{series.id}").json()
    assert roll["edition_count"] == 2
    assert roll["reviewed_edition_count"] == 2
    assert roll["total_review_count"] == 3
    # Unweighted mean of edition averages: (4.0 + 5.0) / 2 = 4.5 (NOT pooled
    # 4.67 that would over-weight the larger edition).
    assert roll["average_mood"] == pytest.approx(4.5)
    assert roll["display_state"] == "full"
    assert roll["mood_label"] == "Exceptional"
    # Pooled sentiment distribution across editions.
    assert roll["sentiment_distribution"]["amazing"] == 2
    assert roll["sentiment_distribution"]["great"] == 1
    # Editions newest-first by start date.
    assert [e["event_id"] for e in roll["editions"]] == [
        "evt-series-2",
        "evt-series-1",
    ]

    # The per-event endpoint returns the same roll-up for a member event.
    via_event = client.get(f"/api/events/{ev1.event_id}/series").json()
    assert via_event["series_id"] == series.id


@pytest.mark.unit
def test_series_rollup_404_when_not_resolved(client, session, series_events):
    series, _, _ = series_events
    series.status = "pending"
    session.add(series)
    session.commit()
    assert _login(client, email="user@example.com").status_code == 200
    assert client.get(f"/api/series/{series.id}").status_code == 404


@pytest.mark.unit
def test_series_reviews_pooled_across_editions(client, session, series_events):
    """The series reviews endpoint returns reviews from every edition, each
    carrying its own edition so callers can link back to it."""
    series, ev1, ev2 = series_events

    assert _login(client, email="a@example.com").status_code == 200
    client.post(
        f"/api/events/{ev1.event_id}/feedback",
        json={
            "overall_sentiment": "great",
            "comment": "Edition one was lovely.",
            "tag_suggestions": [],
        },
    )
    assert _login(client, email="b@example.com").status_code == 200
    client.post(
        f"/api/events/{ev2.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )

    resp = client.get(f"/api/series/{series.id}/reviews")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    event_ids = {item["event_id"] for item in body["items"]}
    assert event_ids == {ev1.event_id, ev2.event_id}
    for item in body["items"]:
        assert item["event_title"] == "Weekly Milonga"
        assert item["event_start"] is not None
    # Default sort is newest-first: ev2 (Jan 8) before ev1 (Jan 1).
    assert body["items"][0]["event_id"] == ev2.event_id


@pytest.mark.unit
def test_series_reviews_404_when_not_resolved(client, session, series_events):
    series, _, _ = series_events
    series.status = "pending"
    session.add(series)
    session.commit()
    assert _login(client, email="user@example.com").status_code == 200
    assert client.get(f"/api/series/{series.id}/reviews").status_code == 404


@pytest.mark.unit
def test_profanity_auto_flags(client, session, event, monkeypatch):
    monkeypatch.setattr(ratings_module, "contains_profanity", lambda s: True)
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "comment": "anything",
            "tag_suggestions": [],
        },
    )
    rating = session.exec(select(EventRating)).one()
    assert rating.admin_notes and "auto-flagged" in rating.admin_notes
    assert rating.comment_status == "pending"


@pytest.mark.unit
def test_comment_hidden_until_approved(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "comment": "Great night out",
            "tag_suggestions": [],
        },
    )
    # Structured review is public immediately, but comment is withheld.
    reviews = client.get(f"/api/events/{event.event_id}/reviews").json()
    assert reviews["total"] == 1
    assert reviews["items"][0]["overall_sentiment"] == "amazing"
    assert reviews["items"][0]["comment"] is None

    rating = session.exec(select(EventRating)).one()
    rating.comment_status = "approved"
    session.add(rating)
    session.commit()
    reviews = client.get(f"/api/events/{event.event_id}/reviews").json()
    assert reviews["items"][0]["comment"] == "Great night out"


@pytest.mark.unit
def test_anonymity_reviewer_label(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "is_anonymous": True,
            "tag_suggestions": [],
        },
    )
    reviews = client.get(f"/api/events/{event.event_id}/reviews").json()
    assert reviews["items"][0]["reviewer_label"] == "Anonymous"
    # Every review carries its owning-edition reference for cross-edition links.
    assert reviews["items"][0]["event_id"] == event.event_id
    assert reviews["items"][0]["event_title"] == event.title
    assert reviews["items"][0]["event_start"] is not None


@pytest.mark.unit
def test_user_rate_limit(client, session, event):
    """The per-user hourly cap should kick in well before slowapi's IP cap."""
    ratings_module._HOUR_LIMIT = 2
    try:
        assert _login(client, email="user@example.com").status_code == 200
        body = {"overall_sentiment": "amazing", "tag_suggestions": []}
        # Need separate events since (user_id, event_id) is unique.
        for i in range(3):
            ev = CachedEvent(
                event_id=f"evt-rl-{i}",
                calendar_id="cal-1",
                title=f"Event {i}",
                start=datetime(2020, 1, 1, 20, 0, 0),
                end=datetime(2020, 1, 1, 22, 0, 0),
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
        json={"overall_sentiment": "great", "tag_suggestions": []},
    )

    # Delete the account
    resp = client.delete("/api/auth/me")
    assert resp.status_code in (200, 204)

    # Aggregate unchanged, visible to any other signed-in user.
    assert _login(client, email="viewer@example.com").status_code == 200
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    assert agg["sentiment_distribution"]["great"] == 1

    # Row anonymised
    session.expire_all()
    rating = session.exec(select(EventRating)).one()
    assert rating.user_id is None
    assert rating.is_anonymous is True


@pytest.mark.unit
def test_batch_aggregate_cap(client):
    assert _login(client, email="user@example.com").status_code == 200
    too_many = [str(uuid4()) for _ in range(201)]
    resp = client.post("/api/events/ratings/aggregate", json={"event_ids": too_many})
    assert resp.status_code == 422


@pytest.mark.unit
def test_batch_aggregate_counts(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    client.post(
        f"/api/events/{event.event_id}/feedback",
        json={"overall_sentiment": "amazing", "tag_suggestions": []},
    )
    resp = client.post(
        "/api/events/ratings/aggregate",
        json={"event_ids": [event.event_id, "evt-none"]},
    )
    assert resp.status_code == 200
    by_id = {a["event_id"]: a["count"] for a in resp.json()}
    assert by_id[event.event_id] == 1
    assert by_id["evt-none"] == 0


@pytest.mark.unit
def test_batch_aggregate_pools_series_count_for_upcoming_edition(client, session):
    """An upcoming edition in a resolved series surfaces the series' pooled
    review count; a past edition keeps its own count."""
    past = CachedEvent(
        event_id="evt-pool-past",
        calendar_id="cal-1",
        title="Weekly Milonga",
        start=datetime(2020, 1, 1, 20, 0, 0),
        end=datetime(2020, 1, 2, 1, 0, 0),
    )
    upcoming = CachedEvent(
        event_id="evt-pool-upcoming",
        calendar_id="cal-1",
        title="Weekly Milonga",
        start=datetime(2099, 1, 1, 20, 0, 0),
        end=datetime(2099, 1, 2, 1, 0, 0),
    )
    session.add(past)
    session.add(upcoming)
    series = EventSeries(
        status="resolved", source="manual", canonical_title="Weekly Milonga"
    )
    session.add(series)
    session.commit()
    session.refresh(series)
    session.add(EventSeriesMember(series_id=series.id, event_id=past.event_id))
    session.add(EventSeriesMember(series_id=series.id, event_id=upcoming.event_id))
    session.commit()

    # Two reviews on the past edition; none on the upcoming one.
    for email in ("a@example.com", "b@example.com"):
        assert _login(client, email=email).status_code == 200
        client.post(
            f"/api/events/{past.event_id}/feedback",
            json={"overall_sentiment": "amazing", "tag_suggestions": []},
        )

    resp = client.post(
        "/api/events/ratings/aggregate",
        json={"event_ids": [past.event_id, upcoming.event_id]},
    )
    assert resp.status_code == 200
    by_id = {a["event_id"]: a["count"] for a in resp.json()}
    # Past edition keeps its own count; the upcoming edition pools the series'.
    assert by_id[past.event_id] == 2
    assert by_id[upcoming.event_id] == 2


@pytest.mark.unit
def test_admin_comment_moderation_queue_and_approve(client, session, event):
    """Only reviews with a comment enter the moderation queue; approve reveals it."""
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "comment": "Wonderful evening",
            "tag_suggestions": [],
        },
    )
    rating_id = resp.json()["rating"]["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    pending = client.get("/api/admin/feedback?status=pending").json()
    assert pending["total"] == 1

    approve = client.post(f"/api/admin/ratings/{rating_id}/approve", json={})
    assert approve.status_code == 200
    assert approve.json()["comment_status"] == "approved"

    approved = client.get("/api/admin/feedback?status=approved").json()
    assert approved["total"] == 1
    assert client.get("/api/admin/feedback?status=pending").json()["total"] == 0


@pytest.mark.unit
def test_admin_reject_hides_comment_but_keeps_structured(client, session, event):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "bad",
            "comment": "something abusive",
            "tag_suggestions": [],
        },
    )
    rating_id = resp.json()["rating"]["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    reject = client.post(f"/api/admin/ratings/{rating_id}/reject", json={})
    assert reject.status_code == 200
    assert reject.json()["comment_status"] == "rejected"

    # Structured review still counts; comment withheld.
    agg = client.get(f"/api/events/{event.event_id}/rating").json()
    assert agg["count"] == 1
    reviews = client.get(f"/api/events/{event.event_id}/reviews").json()
    assert reviews["items"][0]["comment"] is None


@pytest.mark.unit
def test_admin_approve_independent_of_suggestions(client, session, event, other_tag):
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "comment": "nice",
            "tag_suggestions": [{"tag_id": other_tag.id}],
        },
    )
    assert resp.status_code == 201
    rating_id = resp.json()["rating"]["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    approve = client.post(f"/api/admin/ratings/{rating_id}/approve", json={})
    assert approve.status_code == 200

    # The linked TagSuggestion should still be pending (independent moderation).
    sug = session.exec(select(TagSuggestion)).one()
    session.refresh(sug)
    assert sug.status == "pending"


@pytest.mark.unit
def test_approve_does_not_propagate_aspect_tags_to_event_tags(
    client, session, event, aspect_group
):
    """Approving a review must NOT attach its aspect tags to the event taxonomy."""
    _, pos, _ = aspect_group
    assert _login(client, email="user@example.com").status_code == 200
    resp = client.post(
        f"/api/events/{event.event_id}/feedback",
        json={
            "overall_sentiment": "amazing",
            "aspect_tag_ids": [pos.id],
            "comment": "great",
            "tag_suggestions": [],
        },
    )
    rating_id = resp.json()["rating"]["id"]

    assert _login(client, email="admin@example.com").status_code == 200
    assert (
        client.post(f"/api/admin/ratings/{rating_id}/approve", json={}).status_code
        == 200
    )

    assert (
        session.exec(select(EventTag).where(EventTag.event_id == event.event_id)).all()
        == []
    )


# ── Tag-group scope separation ────────────────────────────────────────


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
    client, event_tag_group, aspect_group, audience_group
):
    resp = client.get("/api/tags")
    assert resp.status_code == 200
    slugs = {g["slug"] for g in resp.json()}
    assert "format" in slugs
    assert "music" not in slugs
    assert "audience" not in slugs


@pytest.mark.unit
def test_public_tag_list_scope_aspect_returns_aspect_groups(
    client, event_tag_group, aspect_group, audience_group
):
    resp = client.get("/api/tags?scope=aspect")
    assert resp.status_code == 200
    payload = resp.json()
    slugs = {g["slug"] for g in payload}
    assert slugs == {"music"}
    assert payload[0]["scope"] == "aspect"
    # Polarity is carried through so the modal can order/label tags.
    polarities = {t["slug"]: t["polarity"] for t in payload[0]["tags"]}
    assert polarities == {"great-dj": "positive", "too-loud": "negative"}


# ── "Share your experience" pending reviews ───────────────────────────


def _me(session: Session, email: str) -> User:
    return session.exec(select(User).where(User.email == email)).first()


def _past_event(
    session: Session, event_id: str, *, days_ago: int, title: str
) -> CachedEvent:
    start = datetime.utcnow() - timedelta(days=days_ago)
    ev = CachedEvent(
        event_id=event_id,
        calendar_id="cal-1",
        title=title,
        start=start,
        end=start + timedelta(hours=4),
    )
    session.add(ev)
    session.commit()
    session.refresh(ev)
    return ev


@pytest.mark.unit
def test_pending_reviews_requires_auth(client):
    assert client.get("/api/users/me/pending-reviews").status_code == 401


@pytest.mark.unit
def test_pending_reviews_lists_attended_unreviewed(client, session):
    assert _login(client, email="user@example.com").status_code == 200
    me = _me(session, "user@example.com")
    _past_event(session, "ev-attended", days_ago=1, title="Barcelona Thursday Social")
    session.add(
        UserEventAttendance(device_id="dev-me", event_id="ev-attended", user_id=me.id)
    )
    session.commit()

    resp = client.get("/api/users/me/pending-reviews")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["event_id"] == "ev-attended"
    assert body[0]["event_title"] == "Barcelona Thursday Social"
    assert body[0]["friend_proof"] is None


@pytest.mark.unit
def test_pending_reviews_excludes_already_reviewed(client, session):
    assert _login(client, email="user@example.com").status_code == 200
    me = _me(session, "user@example.com")
    _past_event(session, "ev-reviewed", days_ago=1, title="Reviewed Social")
    session.add(
        UserEventAttendance(device_id="dev-me", event_id="ev-reviewed", user_id=me.id)
    )
    session.add(
        EventRating(event_id="ev-reviewed", user_id=me.id, stars=5, status="approved")
    )
    session.commit()

    resp = client.get("/api/users/me/pending-reviews")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.unit
def test_pending_reviews_includes_friend_proof(client, session):
    assert _login(client, email="user@example.com").status_code == 200
    me = _me(session, "user@example.com")
    laura = User(
        email="laura@example.com",
        display_name="Laura Vega",
        handle="laura",
        provider="google",
        provider_subject="mock|laura@example.com",
    )
    session.add(laura)
    session.commit()
    session.refresh(laura)
    _past_event(session, "ev-proof", days_ago=1, title="Rooftop Social")
    session.add(
        UserEventAttendance(device_id="dev-me", event_id="ev-proof", user_id=me.id)
    )
    session.add(UserFollow(follower_id=me.id, followee_id=laura.id, status="approved"))
    session.add(
        EventRating(
            event_id="ev-proof",
            user_id=laura.id,
            stars=5,
            status="approved",
            is_anonymous=False,
        )
    )
    session.commit()

    resp = client.get("/api/users/me/pending-reviews")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    # First name only, per review_prompt_service._display_name.
    assert body[0]["friend_proof"] == "Laura"


@pytest.mark.unit
def test_pending_reviews_respects_window(client, session):
    """Events older than the admin-configurable window are excluded."""
    assert _login(client, email="user@example.com").status_code == 200
    me = _me(session, "user@example.com")
    _past_event(session, "ev-old", days_ago=200, title="Old Social")
    session.add(
        UserEventAttendance(device_id="dev-me", event_id="ev-old", user_id=me.id)
    )
    session.commit()

    # Default window is 180 days → the 200-day-old event is out of range.
    assert client.get("/api/users/me/pending-reviews").json() == []

    # Widen the window via the admin SiteSetting override → now it surfaces.
    session.add(SiteSetting(key="for_you_review_window_days", value="365"))
    session.commit()
    body = client.get("/api/users/me/pending-reviews").json()
    assert [r["event_id"] for r in body] == ["ev-old"]


@pytest.mark.unit
def test_public_tag_list_scope_audience_returns_audience_group(
    client, event_tag_group, aspect_group, audience_group
):
    resp = client.get("/api/tags?scope=audience")
    assert resp.status_code == 200
    slugs = {g["slug"] for g in resp.json()}
    assert slugs == {"audience"}


@pytest.mark.unit
def test_public_tag_list_scope_invalid_rejected(client):
    resp = client.get("/api/tags?scope=bogus")
    assert resp.status_code == 422


@pytest.mark.unit
def test_tag_suggestion_rejects_aspect_scope_tag(client, event, aspect_group):
    """A reviewer-vocabulary tag must not be suggestable as an event tag."""
    _, pos, _ = aspect_group
    resp = client.post(
        "/api/tags/suggestions",
        json={"event_id": event.event_id, "tag_id": pos.id, "device_id": "dev-1"},
    )
    assert resp.status_code == 400
    assert "cannot be suggested" in resp.json()["detail"].lower()
