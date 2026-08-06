"""Event ratings + unified feedback envelope (rating + linked tag suggestions).

Design notes:
- Pre-moderation: ratings start as ``status="pending"`` and are not visible to
  other users until an admin approves. Aggregate counts/averages exposed via
  ``/api/events/{id}/rating`` reflect approved rows only.
- Anonymity: per-rating opt-in via ``is_anonymous``. The reviewer label shown
  publicly is "Anonymous" when set; otherwise the user's display name.
- Soft-delete: ``user_id`` is nullable. Account deletion (auth.delete_me) sets
  user_id=NULL and is_anonymous=TRUE so aggregate scores stay stable.
- Feedback envelope: the same submission may include tag suggestions. Both
  rating and suggestions share a ``feedback_submission_id`` so admins can see
  them together while approving each independently.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
)
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlalchemy import func
from sqlmodel import Session, col, select

from backend.api.deps import (
    get_client_ip,
    get_current_user_optional,
    require_admin,
    require_user,
)
from backend.api.schemas import (
    AdminRatingListResponse,
    AdminRatingResponse,
    AspectAggregate,
    BatchAggregateRequest,
    EventRatingAggregate,
    EventRatingResponse,
    EventReviewPublic,
    EventReviewsListResponse,
    FeedbackSubmissionCreate,
    FeedbackSubmissionResponse,
    MyRatingResponse,
    PendingReviewResponse,
    RatingApproveRequest,
    RatingRejectRequest,
    SeriesEditionSummary,
    SeriesRatingRollup,
    TagResponse,
    TopReviewTag,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventRating,
    EventRatingAspectScore,
    EventRatingAspectTag,
    EventSeries,
    EventSeriesMember,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
    UserFollow,
)
from backend.services.app_settings import (
    get_for_you_review_window_days,
    get_review_mood_headline_min_reviews,
)
from backend.services.experience_aspects import (
    SENTIMENT_TO_SCORE,
    SENTIMENT_VALUES,
    compute_mood_metrics,
    get_aspect_slugs,
    mood_metrics_from_averages,
)
from backend.services.ip_geolocation import geolocate_ip
from backend.services.passport import attended_events
from backend.services.profanity import contains_profanity
from backend.services.review_prompt_service import (
    friend_review_proof,
    proof_phrase,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ratings"])
limiter = Limiter(key_func=client_ip)


# ── Helpers ──────────────────────────────────────────────────────────


def _tag_to_response(tag: Tag, group: TagGroup | None = None) -> TagResponse:
    return TagResponse(
        id=tag.id or 0,
        slug=tag.slug,
        label=tag.label,
        color=tag.color,
        ordinal=tag.ordinal,
        group_slug=group.slug if group else "",
        group_label=group.label if group else "",
        group_color=group.color if group else None,
        group_scope=group.scope if group else "event",
        polarity=tag.polarity,
        enabled=tag.enabled,
        is_hero_filter=tag.is_hero_filter,
        hero_ordinal=tag.hero_ordinal,
    )


def _load_tags_as_response(session: Session, ids: list[int]) -> list[TagResponse]:
    if not ids:
        return []
    tags = session.exec(select(Tag).where(col(Tag.id).in_(ids))).all()
    by_id = {t.id: t for t in tags}
    group_ids = list({t.group_id for t in tags})
    groups = (
        session.exec(select(TagGroup).where(col(TagGroup.id).in_(group_ids))).all()
        if group_ids
        else []
    )
    groups_by_id = {g.id: g for g in groups}
    out: list[TagResponse] = []
    for tid in ids:
        tag = by_id.get(tid)
        if tag:
            out.append(_tag_to_response(tag, groups_by_id.get(tag.group_id)))
    return out


def _validate_aspect_tag_ids(session: Session, ids: list[int]) -> list[tuple[int, str]]:
    """Return (tag_id, aspect_slug) pairs for tags in scope='aspect' groups.

    ``aspect_slug`` is the parent group slug so counts can be grouped by aspect.
    """
    if not ids:
        return []
    rows = session.exec(
        select(Tag.id, TagGroup.slug)
        .join(TagGroup, col(Tag.group_id) == col(TagGroup.id))
        .where(col(Tag.id).in_(ids), TagGroup.scope == "aspect", Tag.enabled)
    ).all()
    valid = {tid: slug for tid, slug in rows}
    return [(tid, valid[tid]) for tid in ids if tid in valid]


def _validate_audience_tag_ids(session: Session, ids: list[int]) -> list[int]:
    """Restrict ids to tags belonging to a scope='audience' group."""
    if not ids:
        return []
    valid_ids = set(
        session.exec(
            select(Tag.id)
            .join(TagGroup, col(Tag.group_id) == col(TagGroup.id))
            .where(col(Tag.id).in_(ids), TagGroup.scope == "audience", Tag.enabled)
        ).all()
    )
    return [i for i in ids if i in valid_ids]


def _validate_aspect_scores(
    session: Session, aspect_scores: dict[str, int]
) -> dict[str, int]:
    """Drop unknown aspect slugs and out-of-range scores (1-5)."""
    valid_slugs = get_aspect_slugs(session)
    return {
        slug: score
        for slug, score in aspect_scores.items()
        if slug in valid_slugs and 1 <= score <= 5
    }


def _replace_aspect_scores(
    session: Session, rating_id: UUID, aspect_scores: dict[str, int]
) -> None:
    existing = session.exec(
        select(EventRatingAspectScore).where(
            EventRatingAspectScore.rating_id == rating_id
        )
    ).all()
    for row in existing:
        session.delete(row)
    # Flush the deletes before inserting: SQLAlchemy's unit-of-work emits
    # INSERTs before DELETEs within a flush, which would otherwise collide with
    # the not-yet-deleted rows on uq_event_rating_aspect_score during an update.
    session.flush()
    for slug, score in aspect_scores.items():
        session.add(
            EventRatingAspectScore(rating_id=rating_id, aspect_slug=slug, score=score)
        )


def _replace_aspect_tags(
    session: Session, rating_id: UUID, pairs: list[tuple[int, str]]
) -> None:
    existing = session.exec(
        select(EventRatingAspectTag).where(EventRatingAspectTag.rating_id == rating_id)
    ).all()
    for row in existing:
        session.delete(row)
    # Flush deletes before inserts — see _replace_aspect_scores for why.
    session.flush()
    for tag_id, aspect_slug in pairs:
        session.add(
            EventRatingAspectTag(
                rating_id=rating_id, aspect_slug=aspect_slug, tag_id=tag_id
            )
        )


def _load_aspect_scores(session: Session, rating_id: UUID) -> dict[str, int]:
    rows = session.exec(
        select(EventRatingAspectScore).where(
            EventRatingAspectScore.rating_id == rating_id
        )
    ).all()
    return {r.aspect_slug: r.score for r in rows}


def _load_aspect_tag_ids(session: Session, rating_id: UUID) -> list[int]:
    return list(
        session.exec(
            select(EventRatingAspectTag.tag_id).where(
                EventRatingAspectTag.rating_id == rating_id
            )
        ).all()
    )


def _reviewer_label(user: User | None, is_anonymous: bool) -> str:
    if is_anonymous or user is None:
        return "Anonymous"
    name = (user.display_name or user.email or "User").strip()
    return name


def _aggregate_core(
    session: Session, event_ids: list[str]
) -> tuple[
    int,
    dict[str, int],
    list[AspectAggregate],
    list[TopReviewTag],
    list[TopReviewTag],
    list[TopReviewTag],
]:
    """Pooled structured aggregate over all non-rejected reviews for the given
    events. Returns
    ``(count, sentiment_distribution, aspects, top_positive, top_negative,
    top_audience)`` — the mood headline is layered on top by callers.
    """
    sentiment_distribution = {s: 0 for s in SENTIMENT_VALUES}
    if not event_ids:
        return 0, sentiment_distribution, [], [], [], []

    rows = session.exec(
        select(
            EventRating.id, EventRating.overall_sentiment, EventRating.audience_tag_ids
        ).where(
            col(EventRating.event_id).in_(event_ids),
            EventRating.status != "rejected",
        )
    ).all()

    audience_counts: dict[int, int] = {}
    rating_ids: list[UUID] = []

    for rating_id, sentiment, audience_tag_ids in rows:
        rating_ids.append(rating_id)
        if sentiment in sentiment_distribution:
            sentiment_distribution[sentiment] += 1
        for tid in audience_tag_ids or []:
            audience_counts[tid] = audience_counts.get(tid, 0) + 1

    total = len(rating_ids)

    # Per-aspect averages + counts.
    aspects: list[AspectAggregate] = []
    if rating_ids:
        aspect_rows = session.exec(
            select(
                EventRatingAspectScore.aspect_slug, EventRatingAspectScore.score
            ).where(col(EventRatingAspectScore.rating_id).in_(rating_ids))
        ).all()
        scores_by_slug: dict[str, list[int]] = {}
        for slug, score in aspect_rows:
            scores_by_slug.setdefault(slug, []).append(score)
        for slug in sorted(scores_by_slug):
            scores = scores_by_slug[slug]
            aspects.append(
                AspectAggregate(
                    aspect_slug=slug,
                    average=round(sum(scores) / len(scores), 2),
                    count=len(scores),
                )
            )

    # Aspect-tag counts split by polarity.
    top_positive_tags: list[TopReviewTag] = []
    top_negative_tags: list[TopReviewTag] = []
    if rating_ids:
        tag_rows = session.exec(
            select(EventRatingAspectTag.tag_id, EventRatingAspectTag.aspect_slug).where(
                col(EventRatingAspectTag.rating_id).in_(rating_ids)
            )
        ).all()
        counts: dict[int, int] = {}
        aspect_by_tag: dict[int, str] = {}
        for tid, aspect_slug in tag_rows:
            counts[tid] = counts.get(tid, 0) + 1
            aspect_by_tag[tid] = aspect_slug
        if counts:
            tags = session.exec(select(Tag).where(col(Tag.id).in_(counts.keys()))).all()
            tags_by_id = {t.id: t for t in tags}
            pos: list[tuple[int, int]] = []
            neg: list[tuple[int, int]] = []
            for tid, count in counts.items():
                tag = tags_by_id.get(tid)
                if not tag:
                    continue
                (neg if tag.polarity == "negative" else pos).append((tid, count))
            for bucket, dest in ((pos, top_positive_tags), (neg, top_negative_tags)):
                for tid, count in sorted(bucket, key=lambda kv: kv[1], reverse=True)[
                    :5
                ]:
                    tag = tags_by_id[tid]
                    dest.append(
                        TopReviewTag(
                            tag_id=tid,
                            slug=tag.slug,
                            label=tag.label,
                            count=count,
                            aspect_slug=aspect_by_tag.get(tid),
                        )
                    )

    # Recommendation audience.
    top_audience_tags: list[TopReviewTag] = []
    if audience_counts:
        tags = session.exec(
            select(Tag).where(col(Tag.id).in_(audience_counts.keys()))
        ).all()
        tags_by_id = {t.id: t for t in tags}
        for tid, count in sorted(
            audience_counts.items(), key=lambda kv: kv[1], reverse=True
        )[:8]:
            tag = tags_by_id.get(tid)
            if not tag:
                continue
            top_audience_tags.append(
                TopReviewTag(tag_id=tid, slug=tag.slug, label=tag.label, count=count)
            )

    return (
        total,
        sentiment_distribution,
        aspects,
        top_positive_tags,
        top_negative_tags,
        top_audience_tags,
    )


def _aggregate_for_event(session: Session, event_id: str) -> EventRatingAggregate:
    """Live structured aggregate + overall-mood headline for a single event."""
    (
        total,
        sentiment_distribution,
        aspects,
        top_positive_tags,
        top_negative_tags,
        top_audience_tags,
    ) = _aggregate_core(session, [event_id])

    min_reviews = get_review_mood_headline_min_reviews(session)
    mood = compute_mood_metrics(sentiment_distribution, min_reviews)

    return EventRatingAggregate(
        event_id=event_id,
        count=total,
        sentiment_distribution=sentiment_distribution,
        aspects=aspects,
        top_positive_tags=top_positive_tags,
        top_negative_tags=top_negative_tags,
        top_audience_tags=top_audience_tags,
        average_mood=mood.average_mood,
        positive_percentage=mood.positive_percentage,
        neutral_percentage=mood.neutral_percentage,
        negative_percentage=mood.negative_percentage,
        mood_label=mood.mood_label,
        display_state=mood.display_state,
    )


def _resolved_series_for_event(session: Session, event_id: str) -> EventSeries | None:
    """Return the resolved series this event belongs to, if any."""
    member = session.exec(
        select(EventSeriesMember).where(EventSeriesMember.event_id == event_id)
    ).first()
    if member is None:
        return None
    series = session.get(EventSeries, member.series_id)
    if series is None or series.status != "resolved":
        return None
    return series


def _series_rollup(session: Session, series: EventSeries) -> SeriesRatingRollup:
    """Cross-edition roll-up for a resolved series.

    Headline mood is the unweighted mean of each reviewed edition's own
    average/positive figures; the breakdown (distribution, aspects, tags) is
    pooled across every edition; the display gate uses the pooled review count.
    """
    min_reviews = get_review_mood_headline_min_reviews(session)

    members = session.exec(
        select(EventSeriesMember.event_id).where(
            EventSeriesMember.series_id == series.id
        )
    ).all()
    event_ids = [m for m in members]

    events: dict[str, CachedEvent] = {}
    if event_ids:
        for ev in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all():
            events[ev.event_id] = ev

    editions: list[SeriesEditionSummary] = []
    edition_averages: list[float] = []
    positive_percentages: list[float] = []
    for eid in event_ids:
        total, dist, *_ = _aggregate_core(session, [eid])
        m = compute_mood_metrics(dist, min_reviews)
        ev = events.get(eid)
        if ev is None:
            continue
        editions.append(
            SeriesEditionSummary(
                event_id=eid,
                title=ev.title,
                start=ev.start,
                end=ev.end,
                review_count=m.review_count,
                average_mood=m.average_mood,
                positive_percentage=m.positive_percentage,
                mood_label=m.mood_label,
                display_state=m.display_state,
            )
        )
        if m.review_count > 0:
            edition_averages.append(m.average_mood)
            positive_percentages.append(m.positive_percentage)

    # Newest edition first.
    editions.sort(key=lambda e: e.start, reverse=True)

    (
        total,
        sentiment_distribution,
        aspects,
        top_positive_tags,
        top_negative_tags,
        top_audience_tags,
    ) = _aggregate_core(session, event_ids)

    headline = mood_metrics_from_averages(
        edition_averages, total, positive_percentages, min_reviews
    )

    return SeriesRatingRollup(
        series_id=series.id or 0,
        canonical_title=series.canonical_title,
        edition_count=len(event_ids),
        reviewed_edition_count=len(edition_averages),
        total_review_count=total,
        average_mood=headline.average_mood,
        positive_percentage=headline.positive_percentage,
        mood_label=headline.mood_label,
        display_state=headline.display_state,
        sentiment_distribution=sentiment_distribution,
        aspects=aspects,
        top_positive_tags=top_positive_tags,
        top_negative_tags=top_negative_tags,
        top_audience_tags=top_audience_tags,
        editions=editions,
    )


def _to_rating_response(
    rating: EventRating,
    aspect_scores: dict[str, int] | None = None,
    aspect_tag_ids: list[int] | None = None,
) -> EventRatingResponse:
    return EventRatingResponse(
        id=rating.id,
        event_id=rating.event_id,
        overall_sentiment=rating.overall_sentiment,
        aspect_scores=aspect_scores or {},
        aspect_tag_ids=aspect_tag_ids or [],
        audience_tag_ids=list(rating.audience_tag_ids or []),
        comment=rating.comment,
        comment_status=rating.comment_status,
        is_anonymous=rating.is_anonymous,
        status=rating.status,
        created_at=rating.created_at,
        updated_at=rating.updated_at,
    )


# ── Background tasks ────────────────────────────────────────────────


async def _geolocate_rating(rating_id: UUID, ip: str) -> None:
    from backend.db.database import get_engine

    geo = await geolocate_ip(ip)
    if not geo:
        return
    engine = get_engine()
    with Session(engine) as session:
        rating = session.get(EventRating, rating_id)
        if rating:
            rating.submitter_country = (geo.get("country") or "")[:8] or None
            session.add(rating)
            session.commit()


# ── Anti-abuse helpers ──────────────────────────────────────────────


_HOUR_LIMIT = 5
_DAY_LIMIT = 20


def _enforce_user_rate_limit(session: Session, user_id: UUID) -> None:
    """Raise 429 if the user has submitted too many ratings recently."""
    now = datetime.utcnow()
    hour_ago = now - timedelta(hours=1)
    day_ago = now - timedelta(days=1)
    count_hour = session.exec(
        select(func.count())
        .select_from(EventRating)
        .where(EventRating.user_id == user_id, EventRating.created_at >= hour_ago)
    ).one()
    if isinstance(count_hour, tuple):
        count_hour = count_hour[0]
    if int(count_hour or 0) >= _HOUR_LIMIT:
        raise HTTPException(status_code=429, detail="Rate limit exceeded (per hour)")
    count_day = session.exec(
        select(func.count())
        .select_from(EventRating)
        .where(EventRating.user_id == user_id, EventRating.created_at >= day_ago)
    ).one()
    if isinstance(count_day, tuple):
        count_day = count_day[0]
    if int(count_day or 0) >= _DAY_LIMIT:
        raise HTTPException(status_code=429, detail="Rate limit exceeded (per day)")


# ── Public endpoints ────────────────────────────────────────────────


@router.post(
    "/api/events/{event_id}/feedback",
    response_model=FeedbackSubmissionResponse,
    status_code=201,
)
@limiter.limit("10/hour")
def submit_feedback(
    event_id: str,
    body: FeedbackSubmissionCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Submit (or update) a review + optional related tag suggestions.

    Structured signals count live (``status`` defaults to ``approved``). Only the
    free-text ``comment`` is moderated: a new/edited comment starts as
    ``comment_status='pending'``. If the user already reviewed this event the
    existing row is updated in place.
    """
    # Honeypot — silent accept (return synthetic ids so bots can't probe).
    if body.website:
        synth_id = uuid4()
        return FeedbackSubmissionResponse(
            feedback_submission_id=synth_id,
            rating=EventRatingResponse(
                id=synth_id,
                event_id=event_id,
                overall_sentiment=body.overall_sentiment,
                aspect_scores={},
                aspect_tag_ids=[],
                audience_tag_ids=[],
                comment=body.comment,
                comment_status="none",
                is_anonymous=body.is_anonymous,
                status="approved",
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            ),
            tag_suggestion_ids=[],
        )

    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Upcoming editions can't be reviewed — reviews open only after the event ends.
    if event.end and event.end > datetime.utcnow():
        raise HTTPException(status_code=400, detail="This event hasn't taken place yet")

    _enforce_user_rate_limit(session, user.id)

    valid_aspect_scores = _validate_aspect_scores(session, body.aspect_scores)
    aspect_tag_pairs = _validate_aspect_tag_ids(session, body.aspect_tag_ids)
    valid_aspect_tag_ids = [tid for tid, _ in aspect_tag_pairs]
    valid_audience_tag_ids = _validate_audience_tag_ids(session, body.audience_tag_ids)
    stars = SENTIMENT_TO_SCORE[body.overall_sentiment]

    feedback_submission_id = uuid4()

    # Only the free-text comment is moderated. Profanity auto-flags for review.
    has_comment = bool(body.comment and body.comment.strip())
    comment_status = "pending" if has_comment else "none"
    auto_flag = has_comment and contains_profanity(body.comment)
    admin_notes = "auto-flagged: profanity" if auto_flag else None

    # Upsert rating per (user_id, event_id).
    existing = session.exec(
        select(EventRating).where(
            EventRating.user_id == user.id, EventRating.event_id == event_id
        )
    ).first()
    now = datetime.utcnow()
    client_ip = get_client_ip(request)
    user_agent = (request.headers.get("user-agent") or "")[:512] or None

    if existing:
        existing.stars = stars
        existing.overall_sentiment = body.overall_sentiment
        existing.comment = body.comment
        existing.comment_status = comment_status
        existing.audience_tag_ids = valid_audience_tag_ids or None
        existing.is_anonymous = body.is_anonymous
        existing.feedback_submission_id = feedback_submission_id
        existing.status = "approved"
        existing.admin_notes = admin_notes
        existing.reviewed_at = None
        existing.reviewed_by = None
        existing.submitter_ip = client_ip
        existing.submitter_user_agent = user_agent
        existing.updated_at = now
        session.add(existing)
        rating = existing
    else:
        rating = EventRating(
            event_id=event_id,
            user_id=user.id,
            stars=stars,
            overall_sentiment=body.overall_sentiment,
            comment=body.comment,
            comment_status=comment_status,
            audience_tag_ids=valid_audience_tag_ids or None,
            is_anonymous=body.is_anonymous,
            feedback_submission_id=feedback_submission_id,
            status="approved",
            admin_notes=admin_notes,
            submitter_ip=client_ip,
            submitter_user_agent=user_agent,
            created_at=now,
            updated_at=now,
        )
        session.add(rating)

    session.flush()
    _replace_aspect_scores(session, rating.id, valid_aspect_scores)
    _replace_aspect_tags(session, rating.id, aspect_tag_pairs)

    # Linked tag suggestions (optional). Decoupled moderation: each row gets
    # the same feedback_submission_id but its own status="pending".
    suggestion_ids: list[int] = []
    for ts in body.tag_suggestions:
        if not ts.tag_id and not ts.free_text:
            continue
        if ts.tag_id:
            tag = session.get(Tag, ts.tag_id)
            if not tag:
                continue
        ts_row = TagSuggestion(
            event_id=event_id,
            tag_id=ts.tag_id,
            free_text=ts.free_text,
            group_slug=ts.group_slug,
            submitter_ip=client_ip,
            feedback_submission_id=feedback_submission_id,
        )
        session.add(ts_row)
        session.flush()
        if ts_row.id is not None:
            suggestion_ids.append(ts_row.id)

    session.commit()
    session.refresh(rating)

    if client_ip:
        background_tasks.add_task(_geolocate_rating, rating.id, client_ip)

    return FeedbackSubmissionResponse(
        feedback_submission_id=feedback_submission_id,
        rating=_to_rating_response(rating, valid_aspect_scores, valid_aspect_tag_ids),
        tag_suggestion_ids=suggestion_ids,
    )


@router.get(
    "/api/events/{event_id}/rating/me",
    response_model=EventRatingResponse | None,
)
def get_my_rating(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    rating = session.exec(
        select(EventRating).where(
            EventRating.user_id == user.id, EventRating.event_id == event_id
        )
    ).first()
    if not rating:
        return None
    return _to_rating_response(
        rating,
        _load_aspect_scores(session, rating.id),
        _load_aspect_tag_ids(session, rating.id),
    )


@router.delete("/api/events/{event_id}/rating", status_code=204)
def delete_my_rating(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    rating = session.exec(
        select(EventRating).where(
            EventRating.user_id == user.id, EventRating.event_id == event_id
        )
    ).first()
    if rating:
        for row in session.exec(
            select(EventRatingAspectScore).where(
                EventRatingAspectScore.rating_id == rating.id
            )
        ).all():
            session.delete(row)
        for row in session.exec(
            select(EventRatingAspectTag).where(
                EventRatingAspectTag.rating_id == rating.id
            )
        ).all():
            session.delete(row)
        session.delete(rating)
        session.commit()


@router.get("/api/events/{event_id}/rating", response_model=EventRatingAggregate)
def get_rating_aggregate(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    return _aggregate_for_event(session, event_id)


@router.get(
    "/api/events/{event_id}/series",
    response_model=SeriesRatingRollup | None,
)
def get_event_series_rollup(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
) -> SeriesRatingRollup | None:
    """Cross-edition rating roll-up for the resolved series this event belongs
    to, or ``null`` if the event isn't part of a resolved series."""
    series = _resolved_series_for_event(session, event_id)
    if series is None:
        return None
    return _series_rollup(session, series)


@router.get("/api/series/{series_id}", response_model=SeriesRatingRollup)
def get_series_rollup(
    series_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
) -> SeriesRatingRollup:
    series = session.get(EventSeries, series_id)
    if series is None or series.status != "resolved":
        raise HTTPException(status_code=404, detail="Series not found")
    return _series_rollup(session, series)


@router.post(
    "/api/events/ratings/aggregate",
    response_model=list[EventRatingAggregate],
)
def get_rating_aggregates_batch(
    body: BatchAggregateRequest,
    session: Session = Depends(get_session),
    # Count-only response — open to anonymous visitors so signed-out cards and
    # the community-experience header can show "N reviews" (content stays gated).
    user: User | None = Depends(get_current_user_optional),
):
    rows = session.exec(
        select(EventRating.event_id).where(
            col(EventRating.event_id).in_(body.event_ids),
            EventRating.status != "rejected",
        )
    ).all()

    counts: dict[str, int] = {eid: 0 for eid in body.event_ids}
    for eid in rows:
        if eid in counts:
            counts[eid] += 1

    # Upcoming editions in a resolved series with history surface the series'
    # pooled review count (so a fresh edition isn't shown as review-less) —
    # mirroring the cross-edition roll-up used by the full experience section.
    now = datetime.utcnow()
    upcoming_ids = [
        ev_id
        for ev_id, end in session.exec(
            select(CachedEvent.event_id, CachedEvent.end).where(
                col(CachedEvent.event_id).in_(body.event_ids)
            )
        ).all()
        if end is not None and end > now
    ]

    if upcoming_ids:
        series_by_event = {
            ev_id: sid
            for ev_id, sid in session.exec(
                select(EventSeriesMember.event_id, EventSeriesMember.series_id).where(
                    col(EventSeriesMember.event_id).in_(upcoming_ids)
                )
            ).all()
        }
        resolved = (
            {
                s_id
                for s_id in session.exec(
                    select(EventSeries.id).where(
                        col(EventSeries.id).in_(set(series_by_event.values())),
                        EventSeries.status == "resolved",
                    )
                ).all()
            }
            if series_by_event
            else set()
        )

        if resolved:
            all_members = session.exec(
                select(EventSeriesMember.series_id, EventSeriesMember.event_id).where(
                    col(EventSeriesMember.series_id).in_(resolved)
                )
            ).all()
            member_event_ids = [ev_id for _sid, ev_id in all_members]
            rating_counts: dict[str, int] = {}
            if member_event_ids:
                for ev_id in session.exec(
                    select(EventRating.event_id).where(
                        col(EventRating.event_id).in_(member_event_ids),
                        EventRating.status != "rejected",
                    )
                ).all():
                    rating_counts[ev_id] = rating_counts.get(ev_id, 0) + 1
            pooled_by_series: dict[int, int] = {}
            for sid, ev_id in all_members:
                pooled_by_series[sid] = pooled_by_series.get(
                    sid, 0
                ) + rating_counts.get(ev_id, 0)
            for ev_id in upcoming_ids:
                sid = series_by_event.get(ev_id)
                if sid in resolved:
                    pooled = pooled_by_series.get(sid, 0)
                    if pooled > 0:
                        counts[ev_id] = pooled

    return [
        EventRatingAggregate(event_id=eid, count=counts[eid]) for eid in body.event_ids
    ]


def _sort_review_query(base, sort: str):
    """Apply the shared review ordering (recent / positive / critical)."""
    if sort == "positive":
        return base.order_by(
            col(EventRating.stars).desc(), col(EventRating.created_at).desc()
        )
    if sort == "critical":
        return base.order_by(
            col(EventRating.stars).asc(), col(EventRating.created_at).desc()
        )
    return base.order_by(col(EventRating.created_at).desc())


def _reviews_to_public(
    session: Session,
    rows: list[EventRating],
    events_by_id: dict[str, CachedEvent],
) -> list[EventReviewPublic]:
    """Map rating rows to their public shape, resolving reviewer labels and the
    edition (event) each review belongs to."""
    user_ids = list({r.user_id for r in rows if r.user_id is not None})
    users_by_id = {}
    if user_ids:
        users = session.exec(select(User).where(col(User.id).in_(user_ids))).all()
        users_by_id = {u.id: u for u in users}

    items: list[EventReviewPublic] = []
    for r in rows:
        u = users_by_id.get(r.user_id) if r.user_id else None
        # Structured signals always shown; comment only once approved.
        comment = r.comment if r.comment_status == "approved" else None
        ev = events_by_id.get(r.event_id)
        items.append(
            EventReviewPublic(
                id=r.id,
                event_id=r.event_id,
                event_title=ev.title if ev else "",
                event_start=ev.start if ev else datetime.utcnow(),
                overall_sentiment=r.overall_sentiment,
                comment=comment,
                aspect_tags=_load_tags_as_response(
                    session, _load_aspect_tag_ids(session, r.id)
                ),
                audience_tags=_load_tags_as_response(
                    session, list(r.audience_tag_ids or [])
                ),
                reviewer_label=_reviewer_label(u, r.is_anonymous),
                created_at=r.created_at,
            )
        )
    return items


@router.get("/api/events/{event_id}/reviews", response_model=EventReviewsListResponse)
def list_reviews(
    event_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    sort: str = Query(default="recent", pattern="^(recent|positive|critical)$"),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    base = select(EventRating).where(
        EventRating.event_id == event_id, EventRating.status != "rejected"
    )

    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    if isinstance(total, tuple):
        total = total[0]

    base = _sort_review_query(base, sort)
    rows = session.exec(base.offset(offset).limit(limit)).all()

    event = session.get(CachedEvent, event_id)
    events_by_id = {event_id: event} if event else {}
    items = _reviews_to_public(session, rows, events_by_id)

    return EventReviewsListResponse(items=items, total=int(total or 0))


@router.get("/api/series/{series_id}/reviews", response_model=EventReviewsListResponse)
def list_series_reviews(
    series_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    sort: str = Query(default="recent", pattern="^(recent|positive|critical)$"),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Reviews pooled across every edition of a resolved series, newest-first by
    default. Each item carries its own edition (event_id / event_title) so the
    caller can link a review back to the edition it belongs to."""
    series = session.get(EventSeries, series_id)
    if series is None or series.status != "resolved":
        raise HTTPException(status_code=404, detail="Series not found")

    members = session.exec(
        select(EventSeriesMember.event_id).where(
            EventSeriesMember.series_id == series_id
        )
    ).all()
    event_ids = [m for m in members]
    if not event_ids:
        return EventReviewsListResponse(items=[], total=0)

    base = select(EventRating).where(
        col(EventRating.event_id).in_(event_ids), EventRating.status != "rejected"
    )

    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    if isinstance(total, tuple):
        total = total[0]

    base = _sort_review_query(base, sort)
    rows = session.exec(base.offset(offset).limit(limit)).all()

    events_by_id = {
        ev.event_id: ev
        for ev in session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
    }
    items = _reviews_to_public(session, rows, events_by_id)

    return EventReviewsListResponse(items=items, total=int(total or 0))


@router.get("/api/users/me/following-reviews", response_model=EventReviewsListResponse)
def list_following_reviews(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Reviews written by people the viewer follows, newest-first.

    Only non-anonymous, non-rejected reviews from approved follow edges are
    surfaced (an anonymous review from a followee reveals nothing useful).
    """
    followee_ids = session.exec(
        select(UserFollow.followee_id).where(
            UserFollow.follower_id == user.id,
            UserFollow.status == "approved",
        )
    ).all()
    if not followee_ids:
        return EventReviewsListResponse(items=[], total=0)

    base = select(EventRating).where(
        col(EventRating.user_id).in_(followee_ids),
        EventRating.status != "rejected",
        col(EventRating.is_anonymous).is_(False),
    )

    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    if isinstance(total, tuple):
        total = total[0]

    base = base.order_by(col(EventRating.created_at).desc())
    rows = session.exec(base.offset(offset).limit(limit)).all()

    event_ids = list({r.event_id for r in rows})
    events_by_id = (
        {
            ev.event_id: ev
            for ev in session.exec(
                select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
            ).all()
        }
        if event_ids
        else {}
    )
    items = _reviews_to_public(session, rows, events_by_id)

    return EventReviewsListResponse(items=items, total=int(total or 0))


# ── User dashboard ───────────────────────────────────────────────────


@router.get("/api/users/me/ratings", response_model=list[MyRatingResponse])
def list_my_ratings(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    rows = session.exec(
        select(EventRating)
        .where(EventRating.user_id == user.id)
        .order_by(col(EventRating.created_at).desc())
    ).all()
    event_ids = list({r.event_id for r in rows})
    events = (
        session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
        if event_ids
        else []
    )
    events_by_id = {e.event_id: e for e in events}

    out: list[MyRatingResponse] = []
    for r in rows:
        ev = events_by_id.get(r.event_id)
        out.append(
            MyRatingResponse(
                id=r.id,
                event_id=r.event_id,
                event_title=ev.title if ev else None,
                event_start=ev.start if ev else None,
                overall_sentiment=r.overall_sentiment,
                aspect_scores=_load_aspect_scores(session, r.id),
                aspect_tag_ids=_load_aspect_tag_ids(session, r.id),
                audience_tag_ids=list(r.audience_tag_ids or []),
                comment=r.comment,
                comment_status=r.comment_status,
                is_anonymous=r.is_anonymous,
                status=r.status,
                created_at=r.created_at,
                updated_at=r.updated_at,
            )
        )
    return out


@router.get("/api/users/me/pending-reviews", response_model=list[PendingReviewResponse])
def list_my_pending_reviews(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Events the viewer attended (RSVP'd Going, now past) but hasn't reviewed,
    within the admin-configurable recency window, newest-first. Powers the
    "Share your experience" trail on the "For you" page."""
    window_days = get_for_you_review_window_days(session)
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    events = [e for e in attended_events(session, user.id) if e.start >= cutoff]
    if not events:
        return []

    event_ids = [e.event_id for e in events]
    rated_ids = set(
        session.exec(
            select(EventRating.event_id)
            .where(EventRating.user_id == user.id)
            .where(col(EventRating.event_id).in_(event_ids))
        ).all()
    )

    out: list[PendingReviewResponse] = []
    for event in events:
        if event.event_id in rated_ids:
            continue
        proof = friend_review_proof(session, user.id, event.event_id)
        out.append(
            PendingReviewResponse(
                event_id=event.event_id,
                event_title=event.title,
                event_start=event.start,
                event_end=event.end,
                friend_proof=proof_phrase(proof) if proof else None,
            )
        )
    return out


# ── Admin endpoints ──────────────────────────────────────────────────


def _to_admin_rating(
    rating: EventRating,
    *,
    event: CachedEvent | None,
    user: User | None,
    session: Session,
) -> AdminRatingResponse:
    linked_ids: list[int] = []
    if rating.feedback_submission_id is not None:
        linked_ids = [
            tid
            for tid in session.exec(
                select(TagSuggestion.id).where(
                    TagSuggestion.feedback_submission_id
                    == rating.feedback_submission_id
                )
            ).all()
            if tid is not None
        ]
    auto_flagged = bool(rating.admin_notes and "auto-flagged" in rating.admin_notes)
    return AdminRatingResponse(
        id=rating.id,
        event_id=rating.event_id,
        event_title=event.title if event else None,
        user_email=user.email if user else None,
        user_display_name=user.display_name if user else None,
        is_anonymous=rating.is_anonymous,
        overall_sentiment=rating.overall_sentiment,
        aspect_scores=_load_aspect_scores(session, rating.id),
        aspect_tags=_load_tags_as_response(
            session, _load_aspect_tag_ids(session, rating.id)
        ),
        audience_tags=_load_tags_as_response(
            session, list(rating.audience_tag_ids or [])
        ),
        comment=rating.comment,
        comment_status=rating.comment_status,
        feedback_submission_id=rating.feedback_submission_id,
        linked_tag_suggestion_ids=linked_ids,
        status=rating.status,
        admin_notes=rating.admin_notes,
        submitter_ip=rating.submitter_ip,
        submitter_user_agent=rating.submitter_user_agent,
        submitter_country=rating.submitter_country,
        auto_flagged=auto_flagged,
        reviewed_at=rating.reviewed_at,
        reviewed_by=rating.reviewed_by,
        created_at=rating.created_at,
    )


@router.get("/api/admin/feedback", response_model=AdminRatingListResponse)
def list_admin_ratings(
    status: str = Query(default="pending", pattern="^(pending|approved|rejected)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    # Moderation queue is over the free-text comment; structured data is live.
    base = select(EventRating).where(EventRating.comment_status == status)

    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    if isinstance(total, tuple):
        total = total[0]

    rows = session.exec(
        base.order_by(col(EventRating.created_at).desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    event_ids = list({r.event_id for r in rows})
    events = (
        session.exec(
            select(CachedEvent).where(col(CachedEvent.event_id).in_(event_ids))
        ).all()
        if event_ids
        else []
    )
    events_by_id = {e.event_id: e for e in events}

    user_ids = list({r.user_id for r in rows if r.user_id is not None})
    users = (
        session.exec(select(User).where(col(User.id).in_(user_ids))).all()
        if user_ids
        else []
    )
    users_by_id = {u.id: u for u in users}

    items = [
        _to_admin_rating(
            r,
            event=events_by_id.get(r.event_id),
            user=users_by_id.get(r.user_id) if r.user_id else None,
            session=session,
        )
        for r in rows
    ]
    return AdminRatingListResponse(
        items=items, total=int(total or 0), page=page, page_size=page_size
    )


@router.post(
    "/api/admin/ratings/{rating_id}/approve", response_model=AdminRatingResponse
)
def approve_rating(
    rating_id: UUID,
    body: RatingApproveRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    rating = session.get(EventRating, rating_id)
    if not rating:
        raise HTTPException(status_code=404, detail="Rating not found")
    if rating.comment_status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Comment is already {rating.comment_status}"
        )
    rating.comment_status = "approved"
    rating.reviewed_at = datetime.utcnow()
    rating.reviewed_by = admin.get("email")
    if body.admin_notes is not None:
        rating.admin_notes = body.admin_notes
    session.add(rating)
    session.commit()
    session.refresh(rating)

    event = session.get(CachedEvent, rating.event_id)
    user = session.get(User, rating.user_id) if rating.user_id else None
    return _to_admin_rating(rating, event=event, user=user, session=session)


@router.post(
    "/api/admin/ratings/{rating_id}/reject", response_model=AdminRatingResponse
)
def reject_rating(
    rating_id: UUID,
    body: RatingRejectRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    rating = session.get(EventRating, rating_id)
    if not rating:
        raise HTTPException(status_code=404, detail="Rating not found")
    if rating.comment_status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Comment is already {rating.comment_status}"
        )
    rating.comment_status = "rejected"
    rating.reviewed_at = datetime.utcnow()
    rating.reviewed_by = admin.get("email")
    if body.admin_notes is not None:
        rating.admin_notes = body.admin_notes
    session.add(rating)
    session.commit()
    session.refresh(rating)

    event = session.get(CachedEvent, rating.event_id)
    user = session.get(User, rating.user_id) if rating.user_id else None
    return _to_admin_rating(rating, event=event, user=user, session=session)
