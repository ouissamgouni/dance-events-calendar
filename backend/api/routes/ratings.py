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
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlmodel import Session, col, select

from backend.api.deps import get_client_ip, require_admin, require_user
from backend.api.schemas import (
    AdminRatingListResponse,
    AdminRatingResponse,
    BatchAggregateRequest,
    EventRatingAggregate,
    EventRatingResponse,
    EventReviewPublic,
    EventReviewsListResponse,
    FeedbackSubmissionCreate,
    FeedbackSubmissionResponse,
    MyRatingResponse,
    RatingApproveRequest,
    RatingRejectRequest,
    TagResponse,
)
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    EventRating,
    EventTag,
    Tag,
    TagGroup,
    TagSuggestion,
    User,
)
from backend.services.ip_geolocation import geolocate_ip
from backend.services.profanity import contains_profanity

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ratings"])
limiter = Limiter(key_func=get_remote_address)


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
        enabled=tag.enabled,
        is_hero_filter=tag.is_hero_filter,
        hero_ordinal=tag.hero_ordinal,
    )


def _load_review_tags(session: Session, ids: list[int]) -> list[TagResponse]:
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


def _validate_review_tag_ids(session: Session, ids: list[int]) -> list[int]:
    """Restrict review_tag_ids to tags belonging to the ``review-tags`` group."""
    if not ids:
        return []
    group = session.exec(select(TagGroup).where(TagGroup.slug == "review-tags")).first()
    if not group:
        return []
    valid_ids = set(
        session.exec(
            select(Tag.id).where(Tag.group_id == group.id, col(Tag.id).in_(ids))
        ).all()
    )
    return [i for i in ids if i in valid_ids]


def _reviewer_label(user: User | None, is_anonymous: bool) -> str:
    if is_anonymous or user is None:
        return "Anonymous"
    name = (user.display_name or user.email or "User").strip()
    return name


def _aggregate_for_event(session: Session, event_id: str) -> EventRatingAggregate:
    rows = session.exec(
        select(EventRating.stars).where(
            EventRating.event_id == event_id, EventRating.status == "approved"
        )
    ).all()
    distribution = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    for s in rows:
        if 1 <= s <= 5:
            distribution[s] += 1
    total = sum(distribution.values())
    avg = (
        round(sum(s * c for s, c in distribution.items()) / total, 2) if total else 0.0
    )
    return EventRatingAggregate(
        event_id=event_id, average=avg, count=total, distribution=distribution
    )


def _to_rating_response(rating: EventRating) -> EventRatingResponse:
    return EventRatingResponse(
        id=rating.id,
        event_id=rating.event_id,
        stars=rating.stars,
        comment=rating.comment,
        review_tag_ids=list(rating.review_tag_ids or []),
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
    """Submit (or update) a rating + optional related tag suggestions.

    If the user already rated this event the existing row is updated and its
    status reset to ``pending`` for re-moderation.
    """
    # Honeypot — silent accept (return synthetic ids so bots can't probe).
    if body.website:
        synth_id = uuid4()
        return FeedbackSubmissionResponse(
            feedback_submission_id=synth_id,
            rating=EventRatingResponse(
                id=synth_id,
                event_id=event_id,
                stars=body.stars,
                comment=body.comment,
                review_tag_ids=[],
                is_anonymous=body.is_anonymous,
                status="pending",
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            ),
            tag_suggestion_ids=[],
        )

    event = session.get(CachedEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Min comment length for low-star ratings (constructive feedback rule).
    if body.stars <= 2 and (not body.comment or len(body.comment.strip()) < 30):
        raise HTTPException(
            status_code=422,
            detail="Please provide at least 30 characters explaining your rating.",
        )

    _enforce_user_rate_limit(session, user.id)

    valid_review_tag_ids = _validate_review_tag_ids(session, body.review_tag_ids)

    feedback_submission_id = uuid4()
    auto_flag = contains_profanity(body.comment)
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
        existing.stars = body.stars
        existing.comment = body.comment
        existing.review_tag_ids = valid_review_tag_ids or None
        existing.is_anonymous = body.is_anonymous
        existing.feedback_submission_id = feedback_submission_id
        existing.status = "pending"
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
            stars=body.stars,
            comment=body.comment,
            review_tag_ids=valid_review_tag_ids or None,
            is_anonymous=body.is_anonymous,
            feedback_submission_id=feedback_submission_id,
            status="pending",
            admin_notes=admin_notes,
            submitter_ip=client_ip,
            submitter_user_agent=user_agent,
            created_at=now,
            updated_at=now,
        )
        session.add(rating)

    session.flush()

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
        rating=_to_rating_response(rating),
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
    return _to_rating_response(rating)


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
        session.delete(rating)
        session.commit()


@router.get("/api/events/{event_id}/rating", response_model=EventRatingAggregate)
def get_rating_aggregate(
    event_id: str,
    session: Session = Depends(get_session),
):
    return _aggregate_for_event(session, event_id)


@router.post(
    "/api/events/ratings/aggregate",
    response_model=list[EventRatingAggregate],
)
def get_rating_aggregates_batch(
    body: BatchAggregateRequest,
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(EventRating.event_id, EventRating.stars).where(
            col(EventRating.event_id).in_(body.event_ids),
            EventRating.status == "approved",
        )
    ).all()

    by_event: dict[str, dict[int, int]] = {
        eid: {1: 0, 2: 0, 3: 0, 4: 0, 5: 0} for eid in body.event_ids
    }
    for eid, stars in rows:
        if eid in by_event and 1 <= stars <= 5:
            by_event[eid][stars] += 1

    out: list[EventRatingAggregate] = []
    for eid in body.event_ids:
        dist = by_event[eid]
        total = sum(dist.values())
        avg = round(sum(s * c for s, c in dist.items()) / total, 2) if total else 0.0
        out.append(
            EventRatingAggregate(
                event_id=eid, average=avg, count=total, distribution=dist
            )
        )
    return out


@router.get("/api/events/{event_id}/reviews", response_model=EventReviewsListResponse)
def list_reviews(
    event_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    sort: str = Query(default="recent", pattern="^(recent|highest|lowest)$"),
    min_stars: int | None = Query(default=None, ge=1, le=5),
    session: Session = Depends(get_session),
):
    base = select(EventRating).where(
        EventRating.event_id == event_id, EventRating.status == "approved"
    )
    if min_stars is not None:
        base = base.where(EventRating.stars == min_stars)

    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    if isinstance(total, tuple):
        total = total[0]

    if sort == "highest":
        base = base.order_by(
            col(EventRating.stars).desc(), col(EventRating.created_at).desc()
        )
    elif sort == "lowest":
        base = base.order_by(
            col(EventRating.stars).asc(), col(EventRating.created_at).desc()
        )
    else:
        base = base.order_by(col(EventRating.created_at).desc())

    rows = session.exec(base.offset(offset).limit(limit)).all()

    user_ids = list({r.user_id for r in rows if r.user_id is not None})
    users_by_id = {}
    if user_ids:
        users = session.exec(select(User).where(col(User.id).in_(user_ids))).all()
        users_by_id = {u.id: u for u in users}

    items: list[EventReviewPublic] = []
    for r in rows:
        u = users_by_id.get(r.user_id) if r.user_id else None
        items.append(
            EventReviewPublic(
                id=r.id,
                stars=r.stars,
                comment=r.comment,
                review_tags=_load_review_tags(session, list(r.review_tag_ids or [])),
                reviewer_label=_reviewer_label(u, r.is_anonymous),
                created_at=r.created_at,
            )
        )

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
                stars=r.stars,
                comment=r.comment,
                review_tag_ids=list(r.review_tag_ids or []),
                is_anonymous=r.is_anonymous,
                status=r.status,
                created_at=r.created_at,
                updated_at=r.updated_at,
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
        stars=rating.stars,
        comment=rating.comment,
        review_tags=_load_review_tags(session, list(rating.review_tag_ids or [])),
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
    status: str | None = Query(default=None, pattern="^(pending|approved|rejected)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    base = select(EventRating)
    if status:
        base = base.where(EventRating.status == status)

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
    if rating.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Rating is already {rating.status}"
        )
    rating.status = "approved"
    rating.reviewed_at = datetime.utcnow()
    rating.reviewed_by = admin.get("email")
    if body.admin_notes is not None:
        rating.admin_notes = body.admin_notes
    session.add(rating)
    session.commit()
    session.refresh(rating)

    # Propagate review tags to event tags so they become filterable like normal tags.
    review_tag_ids = list(rating.review_tag_ids or [])
    if review_tag_ids:
        existing = session.exec(
            select(EventTag.tag_id).where(
                EventTag.event_id == rating.event_id,
                col(EventTag.tag_id).in_(review_tag_ids),
            )
        ).all()
        existing_set = set(existing)
        added = False
        for tid in review_tag_ids:
            if tid in existing_set:
                continue
            if not session.get(Tag, tid):
                continue
            session.add(EventTag(event_id=rating.event_id, tag_id=tid))
            added = True
        if added:
            session.commit()

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
    if rating.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Rating is already {rating.status}"
        )
    rating.status = "rejected"
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
