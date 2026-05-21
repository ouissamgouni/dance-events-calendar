from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter
from sqlalchemy import func
from sqlmodel import Session, col, select

from backend.api.deps import (
    _audience_passes,
    can_view,
    get_current_user_optional,
    require_user,
)
from backend.api.rate_limit import client_ip
from backend.api.routes.settings import _get_since_date
from backend.api.schemas import (
    CalendarSettingResponse,
    EventBatchRequest,
    EventOrganizerMini,
    EventResponse,
)
from backend.api.routes.tags import get_event_tags
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventPromoCode,
    EventTag,
    EventView,
    User,
    UserEventAttendance,
    UserFollow,
    UserSavedEvent,
)
from backend.services.popularity import compute_popularity_scores, get_saved_counts

router = APIRouter(prefix="/api/events", tags=["events"])

limiter = Limiter(key_func=client_ip)


def _trending_settings(session: Session) -> tuple[bool, int, int]:
    """Read the ``trending_*`` site settings.

    Mirrors the helper in ``event_serializer.py`` but kept local to avoid
    importing from a sibling that itself depends on this module's
    ``get_event_tags``. Returns ``(enabled, window_days, floor_going)``.
    """
    from backend.db.models import SiteSetting  # local import to avoid cycle

    enabled = False
    window_days = 30
    floor_going = 3
    try:
        row = session.get(SiteSetting, "trending_enabled")
        if row and row.value.lower() == "true":
            enabled = True
        row = session.get(SiteSetting, "trending_window_days")
        if row and row.value.isdigit():
            window_days = int(row.value)
        row = session.get(SiteSetting, "trending_floor_going")
        if row and row.value.lstrip("-").isdigit():
            floor_going = int(row.value)
    except Exception:
        pass
    return enabled, window_days, floor_going


def _following_badge_enabled(session: Session) -> bool:
    """Read the ``following_badge_enabled`` site setting. Defaults to False."""
    from backend.db.models import SiteSetting  # local import to avoid cycle

    try:
        row = session.get(SiteSetting, "following_badge_enabled")
        return bool(row and row.value.lower() == "true")
    except Exception:
        return False


def _promo_codes_enabled(session: Session) -> bool:
    """Read the ``promo_codes_enabled`` site setting. Defaults to False."""
    from backend.db.models import SiteSetting  # local import to avoid cycle

    try:
        row = session.get(SiteSetting, "promo_codes_enabled")
        return bool(row and row.value.lower() == "true")
    except Exception:
        return False


def _following_friend_signals(
    session: Session,
    viewer: Optional[User],
    event_ids: list[str],
    *,
    preview_limit: int = 5,
) -> tuple[dict[str, int], dict[str, list[dict]]]:
    """Return ``(counts, previews)`` for the viewer's mutual friends who
    are going to or have saved each event.

    ``counts`` maps event_id → total friend count.
    ``previews`` maps event_id → up to ``preview_limit`` friend mini
    dicts ``{user_id, display_name, avatar_url}``, sorted alphabetically
    by display_name for stable rendering. Audience-gated via
    ``_audience_passes`` and deduplicated per (event, friend) so a
    friend who both saved and is going still counts once.
    """
    if not event_ids or viewer is None or viewer.id is None:
        return {}, {}
    friend_ids = _viewer_friend_ids(session, viewer)
    if not friend_ids:
        return {}, {}
    friend_by_id: dict = {}
    for f in session.exec(select(User).where(User.id.in_(friend_ids))).all():
        friend_by_id[f.id] = f

    pairs: set[tuple[str, object]] = set()

    going_rows = session.exec(
        select(
            UserEventAttendance.event_id,
            UserEventAttendance.user_id,
            UserEventAttendance.share_audience,
        )
        .where(UserEventAttendance.user_id.in_(friend_ids))
        .where(UserEventAttendance.event_id.in_(event_ids))
    ).all()
    for event_id, owner_id, share_audience in going_rows:
        owner = friend_by_id.get(owner_id)
        if owner is None or not event_id:
            continue
        if _audience_passes(session, viewer, owner, share_audience or "private"):
            pairs.add((event_id, owner_id))

    saved_rows = session.exec(
        select(
            UserSavedEvent.event_id,
            UserSavedEvent.user_id,
            UserSavedEvent.audience,
        )
        .where(UserSavedEvent.user_id.in_(friend_ids))
        .where(UserSavedEvent.event_id.in_(event_ids))
    ).all()
    for event_id, owner_id, audience in saved_rows:
        owner = friend_by_id.get(owner_id)
        if owner is None or not event_id:
            continue
        if _audience_passes(session, viewer, owner, audience or "private"):
            pairs.add((event_id, owner_id))

    by_event: dict[str, list] = {}
    for event_id, owner_id in pairs:
        by_event.setdefault(event_id, []).append(owner_id)

    counts: dict[str, int] = {eid: len(ids) for eid, ids in by_event.items()}
    previews: dict[str, list[dict]] = {}
    for eid, ids in by_event.items():
        owners = [friend_by_id[oid] for oid in ids if oid in friend_by_id]
        owners.sort(key=lambda u: (u.display_name or "").lower())
        previews[eid] = [
            {
                "user_id": u.id,
                "display_name": u.display_name,
                "avatar_url": u.avatar_url,
            }
            for u in owners[:preview_limit]
        ]
    return counts, previews


def _viewer_friend_ids(session: Session, viewer: Optional[User]) -> list:
    """Return the user_ids of the viewer's friends (mutual followers).

    Returns an empty list for anonymous viewers (no follow graph anchor).
    Used by the explorer friend filter on ``GET /api/events``.
    """
    if viewer is None or viewer.id is None:
        return []
    # Self-join: x is a friend of viewer iff viewer follows x AND x follows
    # viewer. Single SELECT with a sub-query avoids two round-trips.
    # Phase E (E8): only approved follow edges count toward friendship;
    # pending follow-requests don't grant feed visibility.
    out = (
        select(UserFollow.followee_id)
        .where(UserFollow.follower_id == viewer.id)
        .where(UserFollow.status == "approved")
        .where(
            UserFollow.followee_id.in_(
                select(UserFollow.follower_id)
                .where(UserFollow.followee_id == viewer.id)
                .where(UserFollow.status == "approved")
            )
        )
    )
    return [row for row in session.exec(out).all()]


def _viewer_followed_ids(session: Session, viewer: Optional[User]) -> list:
    """Return the user_ids of every approved followee of ``viewer``.

    One-way edges count: this is the candidate set for
    ``interest_source=follows``. Returns an empty list for anonymous
    viewers (no follow graph anchor).
    """
    if viewer is None or viewer.id is None:
        return []
    rows = session.exec(
        select(UserFollow.followee_id)
        .where(UserFollow.follower_id == viewer.id)
        .where(UserFollow.status == "approved")
    ).all()
    return [r for r in rows]


# Allowed enum values for the explorer interest filter. Kept module-level
# so the route handler and tests can share the same source of truth.
INTEREST_SOURCES = ("follows", "friends")
INTEREST_KINDS = ("any", "going", "saved")


def _interest_filtered_event_ids(
    *,
    session: Session,
    viewer: Optional[User],
    interest_source: Optional[str],
    interest_kind: str,
    interest_user_handle: Optional[str],
) -> list[str]:
    """Compute event_ids visible to ``viewer`` via the interest filter.

    Candidate resolution:

    1. ``interest_user_handle`` (when supplied) narrows the set to that
       single user — they need NOT be a followee. Unknown / deleted
       handles silently resolve to an empty set (privacy chokepoint).
    2. Otherwise the set is the viewer's followees (``interest_source=
       follows``) or mutual friends (``interest_source=friends``).

    Visibility:

    - Account-level: ``can_view`` filters out owners whose account is
      gated to the viewer (e.g. friends-only profile vs. a one-way
      follower).
    - Per-row: ``_audience_passes`` enforces share_audience for each
      attendance / saved row; ``friends`` audience requires mutual
      follow regardless of the source scope.

    ``interest_kind`` selects which row sources contribute: ``going``
    reads ``user_event_attendance``; ``saved`` reads ``user_saved_event``;
    ``any`` UNIONs both.
    """
    # Resolve candidates.
    candidates: list[User] = []
    if interest_user_handle is not None:
        h = (interest_user_handle or "").strip().lstrip("@").lower()
        if not h:
            return []
        target = session.exec(select(User).where(func.lower(User.handle) == h)).first()
        if target is None or target.deleted_at is not None:
            return []
        # Optionally also constrain to the chosen source. If the viewer
        # explicitly asked for `friends`, drop targets that aren't mutual.
        if interest_source == "friends":
            friend_ids = _viewer_friend_ids(session, viewer)
            if target.id not in friend_ids:
                return []
        candidates = [target]
    else:
        if viewer is None:
            return []
        if interest_source == "friends":
            candidate_ids = _viewer_friend_ids(session, viewer)
        else:
            # Default / `follows`: any approved followee.
            candidate_ids = _viewer_followed_ids(session, viewer)
        if not candidate_ids:
            return []
        candidates = list(
            session.exec(select(User).where(User.id.in_(candidate_ids))).all()
        )

    include_going = interest_kind in ("any", "going")
    include_saved = interest_kind in ("any", "saved")

    going_owner_ids: list = []
    saved_owner_ids: list = []
    owner_by_id: dict = {}
    for owner in candidates:
        # Account-level gate: hides owners whose visibility excludes
        # this viewer (e.g. friends-only profile, one-way follower).
        if not can_view(session, viewer, owner):
            continue
        owner_by_id[owner.id] = owner
        if include_going:
            going_owner_ids.append(owner.id)
        if include_saved:
            saved_owner_ids.append(owner.id)

    event_ids: set[str] = set()
    if going_owner_ids:
        rows = session.exec(
            select(
                UserEventAttendance.event_id,
                UserEventAttendance.user_id,
                UserEventAttendance.share_audience,
            ).where(UserEventAttendance.user_id.in_(going_owner_ids))
        ).all()
        for event_id, owner_id, share_audience in rows:
            if not event_id:
                continue
            owner = owner_by_id.get(owner_id)
            if owner is None:
                continue
            if _audience_passes(session, viewer, owner, share_audience or "private"):
                event_ids.add(event_id)
    if saved_owner_ids:
        rows = session.exec(
            select(
                UserSavedEvent.event_id,
                UserSavedEvent.user_id,
                UserSavedEvent.audience,
            ).where(UserSavedEvent.user_id.in_(saved_owner_ids))
        ).all()
        for event_id, owner_id, audience in rows:
            if not event_id:
                continue
            owner = owner_by_id.get(owner_id)
            if owner is None:
                continue
            if _audience_passes(session, viewer, owner, audience or "private"):
                event_ids.add(event_id)
    return list(event_ids)


@router.get("/calendars", response_model=list[CalendarSettingResponse])
@limiter.limit("300/minute")
def get_calendars(
    request: Request,
    session: Session = Depends(get_session),
):
    """Public list of enabled calendars with name and color."""
    calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    return calendars


@router.get("", response_model=list[EventResponse])
@limiter.limit("300/minute")
def get_events(
    request: Request,
    session: Session = Depends(get_session),
    start_date: Optional[str] = Query(
        None, description="Filter events starting from this date (YYYY-MM-DD)"
    ),
    end_date: Optional[str] = Query(
        None, description="Filter events up to this date (YYYY-MM-DD)"
    ),
    tag_ids: Optional[str] = Query(
        None, description="Comma-separated tag IDs to filter by (AND logic)"
    ),
    min_lat: Optional[float] = Query(
        None,
        ge=-90,
        le=90,
        description="Bounding-box south edge (decimal degrees)",
    ),
    min_lng: Optional[float] = Query(
        None,
        ge=-180,
        le=180,
        description="Bounding-box west edge (decimal degrees)",
    ),
    max_lat: Optional[float] = Query(
        None,
        ge=-90,
        le=90,
        description="Bounding-box north edge (decimal degrees)",
    ),
    max_lng: Optional[float] = Query(
        None,
        ge=-180,
        le=180,
        description="Bounding-box east edge (decimal degrees)",
    ),
    interest_source: Optional[str] = Query(
        None,
        description=(
            "Restrict events to activity from people the viewer is "
            "interested in. ``follows`` covers any approved followee "
            "(one-way OK); ``friends`` narrows to mutual followers only. "
            "Requires auth; returns an empty list for anonymous viewers."
        ),
    ),
    interest_kind: str = Query(
        "any",
        description=(
            "Which row source contributes to the interest filter: "
            "``going`` reads attendance; ``saved`` reads saves; ``any`` "
            "UNIONs both. Defaults to ``any``."
        ),
    ),
    interest_user_handle: Optional[str] = Query(
        None,
        description=(
            "Narrow the interest filter to a specific @handle. The "
            "handle's owner must currently pass can_view for each "
            "candidate row; otherwise an empty list is returned (privacy "
            "chokepoint — never 403 / 404)."
        ),
    ),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    # Validate interest enum values early (FastAPI Query doesn't enforce
    # arbitrary string enums without an explicit Enum / Literal — keep
    # this here for clear 400s rather than silent fallthrough).
    if interest_source is not None and interest_source not in INTEREST_SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"interest_source must be one of {INTEREST_SOURCES}",
        )
    if interest_kind not in INTEREST_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"interest_kind must be one of {INTEREST_KINDS}",
        )

    since_date = _get_since_date(session)
    since_dt = datetime.fromisoformat(since_date)

    # Determine effective date range
    effective_start = since_dt
    if start_date:
        start_dt = datetime.fromisoformat(start_date)
        effective_start = max(since_dt, start_dt)

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return []

    query = select(CachedEvent).where(
        CachedEvent.calendar_id.in_(calendar_ids),
        CachedEvent.deleted_at == None,
        CachedEvent.is_hidden == False,
        CachedEvent.start >= effective_start,
    )
    if end_date:
        end_dt = datetime.fromisoformat(end_date)
        # Include full end day
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        query = query.where(CachedEvent.start <= end_dt)

    # AND-filter by tags: event must have ALL specified tag_ids
    if tag_ids:
        try:
            tid_list = [int(t.strip()) for t in tag_ids.split(",") if t.strip()]
        except ValueError:
            tid_list = []
        for tid in tid_list:
            query = query.where(
                CachedEvent.event_id.in_(
                    select(EventTag.event_id).where(EventTag.tag_id == tid)
                )
            )

    # Bounding-box filter (preferred-area in user prefs, or any explicit
    # bbox passed by the explorer). All four params must be supplied
    # together; otherwise the bbox filter is skipped. Events without
    # geocoded coordinates (latitude/longitude IS NULL) are excluded when
    # any bbox is active.
    bbox_parts = [min_lat, min_lng, max_lat, max_lng]
    if any(p is not None for p in bbox_parts):
        if any(p is None for p in bbox_parts):
            raise HTTPException(
                status_code=400,
                detail="min_lat, min_lng, max_lat, max_lng must be supplied together",
            )
        if min_lat >= max_lat or min_lng >= max_lng:
            raise HTTPException(
                status_code=400,
                detail="Invalid bounding box: min must be < max",
            )
        query = query.where(
            CachedEvent.latitude.is_not(None),
            CachedEvent.longitude.is_not(None),
            CachedEvent.latitude >= min_lat,
            CachedEvent.latitude <= max_lat,
            CachedEvent.longitude >= min_lng,
            CachedEvent.longitude <= max_lng,
        )

    # Interest filter (Phase: following-interest): restrict to events the
    # viewer's followees / friends are going to or have saved. Per-row
    # ``_audience_passes`` enforces share_audience independently, so
    # broadening to one-way followees never leaks friends-only activity.
    if interest_source is not None or interest_user_handle is not None:
        interest_event_ids = _interest_filtered_event_ids(
            session=session,
            viewer=current_user,
            interest_source=interest_source or "follows",
            interest_kind=interest_kind,
            interest_user_handle=interest_user_handle,
        )
        if not interest_event_ids:
            # Empty match — short-circuit so we don't pay for any of the
            # downstream batch queries (and so anonymous viewers get a
            # consistently empty list).
            response = JSONResponse(content=[])
            response.headers["Cache-Control"] = "private, max-age=0"
            return response
        query = query.where(CachedEvent.event_id.in_(interest_event_ids))

    events = session.exec(query).all()

    # Batch-fetch view counts to avoid N+1
    event_ids = [e.event_id for e in events]
    view_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(EventView.event_id, func.count(EventView.id))
            .where(EventView.event_id.in_(event_ids))
            .group_by(EventView.event_id)
        ).all()
        view_counts = {row[0]: row[1] for row in rows}

    # Aggregate "going" count per event (one row per device in
    # user_event_attendances = currently going). Public count includes
    # both anonymous and signed-in attendees regardless of share toggle.
    going_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(UserEventAttendance.event_id, func.count(UserEventAttendance.id))
            .where(UserEventAttendance.event_id.in_(event_ids))
            .group_by(UserEventAttendance.event_id)
        ).all()
        going_counts = {row[0]: row[1] for row in rows}

    # Lifetime saved count per event + (when trending is on) the
    # commitment-weighted, time-decayed popularity score.
    saved_counts = get_saved_counts(session, event_ids) if event_ids else {}
    trending_on, window_days, floor_going = _trending_settings(session)
    if trending_on and events:
        scores = compute_popularity_scores(
            session,
            events,
            window_days=window_days,
            floor_going=floor_going,
        )
    else:
        scores = {}

    # Per-event "mutual friend signal" — populated only when the feature is
    # on AND the viewer is signed in. Cheap: single pair of batched queries
    # bounded by the page's event_ids and the viewer's friend set.
    following_counts: dict[str, int] = {}
    following_previews: dict[str, list[dict]] = {}
    if event_ids and current_user is not None and _following_badge_enabled(session):
        following_counts, following_previews = _following_friend_signals(
            session, current_user, event_ids
        )
    # Batch-fetch tags
    tags_map = get_event_tags(session, event_ids)

    events_with_promos: set[str] = set()
    if event_ids and _promo_codes_enabled(session):
        promo_rows = session.exec(
            select(EventPromoCode.event_id)
            .where(EventPromoCode.event_id.in_(event_ids))
            .where(EventPromoCode.status == "approved")
            .where(
                (EventPromoCode.expires_at.is_(None))
                | (EventPromoCode.expires_at > datetime.utcnow())
            )
            .group_by(EventPromoCode.event_id)
        ).all()
        events_with_promos = {row for row in promo_rows}

    data = [
        EventResponse(
            event_id=e.event_id,
            calendar_id=e.calendar_id,
            title=e.title,
            description=e.description,
            location=e.location,
            start=e.start,
            end=e.end,
            all_day=e.all_day,
            latitude=e.latitude,
            longitude=e.longitude,
            color=color_map.get(e.calendar_id),
            view_count=view_counts.get(e.event_id, 0),
            going_count=going_counts.get(e.event_id, 0),
            saved_count=saved_counts.get(e.event_id, 0),
            popularity_score=scores.get(e.event_id, 0.0),
            following_friend_count=following_counts.get(e.event_id, 0),
            following_friends_preview=following_previews.get(e.event_id, []),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
            has_active_promo_codes=e.event_id in events_with_promos,
        )
        for e in events
    ]

    response = JSONResponse(content=[d.model_dump(mode="json") for d in data])
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


@router.get("/search", response_model=list[dict])
@limiter.limit("60/minute")
def search_events(
    request: Request,
    q: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(default=10, ge=1, le=25),
    session: Session = Depends(get_session),
    _current_user: User = Depends(require_user),
):
    """Lightweight title typeahead for authenticated users.

    Returns up to ``limit`` upcoming (non-deleted, non-hidden) events
    matching ``q`` against ``title`` (case-insensitive substring).
    Backs the organizer event-claim picker — verified organizers need
    to find arbitrary events they organize without first saving / going.
    Payload is intentionally minimal: ``{event_id, title, start}``.
    """
    needle = q.strip()
    if not needle:
        return []
    like = f"%{needle}%"
    rows = session.exec(
        select(CachedEvent)
        .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
        .where(CachedEvent.is_hidden.is_(False))  # type: ignore[union-attr]
        .where(CachedEvent.start >= datetime.utcnow())
        .where(col(CachedEvent.title).ilike(like))
        .order_by(col(CachedEvent.start).asc())
        .limit(limit)
    ).all()
    return [
        {
            "event_id": e.event_id,
            "title": e.title,
            "start": e.start.isoformat() if e.start else None,
        }
        for e in rows
    ]


@router.post("/by-ids", response_model=list[EventResponse])
@limiter.limit("120/minute")
def get_events_by_ids(
    request: Request,
    payload: EventBatchRequest,
    session: Session = Depends(get_session),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """Fetch events by a list of IDs (for saved events / My Calendar page)."""
    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]
    color_map = {c.calendar_id: c.color for c in enabled_calendars}

    if not calendar_ids:
        return []

    events = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id.in_(payload.event_ids),
            CachedEvent.calendar_id.in_(calendar_ids),
            CachedEvent.deleted_at == None,
            CachedEvent.is_hidden == False,
        )
    ).all()

    event_ids = [e.event_id for e in events]
    view_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(EventView.event_id, func.count(EventView.id))
            .where(EventView.event_id.in_(event_ids))
            .group_by(EventView.event_id)
        ).all()
        view_counts = {row[0]: row[1] for row in rows}

    going_counts: dict[str, int] = {}
    if event_ids:
        rows = session.exec(
            select(UserEventAttendance.event_id, func.count(UserEventAttendance.id))
            .where(UserEventAttendance.event_id.in_(event_ids))
            .group_by(UserEventAttendance.event_id)
        ).all()
        going_counts = {row[0]: row[1] for row in rows}

    saved_counts = get_saved_counts(session, event_ids) if event_ids else {}
    trending_on, window_days, floor_going = _trending_settings(session)
    if trending_on and events:
        scores = compute_popularity_scores(
            session,
            events,
            window_days=window_days,
            floor_going=floor_going,
        )
    else:
        scores = {}

    following_counts: dict[str, int] = {}
    following_previews: dict[str, list[dict]] = {}
    if event_ids and current_user is not None and _following_badge_enabled(session):
        following_counts, following_previews = _following_friend_signals(
            session, current_user, event_ids
        )

    tags_map = get_event_tags(session, event_ids)

    events_with_promos: set[str] = set()
    if event_ids and _promo_codes_enabled(session):
        promo_rows = session.exec(
            select(EventPromoCode.event_id)
            .where(EventPromoCode.event_id.in_(event_ids))
            .where(EventPromoCode.status == "approved")
            .where(
                (EventPromoCode.expires_at.is_(None))
                | (EventPromoCode.expires_at > datetime.utcnow())
            )
            .group_by(EventPromoCode.event_id)
        ).all()
        events_with_promos = {row for row in promo_rows}

    return [
        EventResponse(
            event_id=e.event_id,
            calendar_id=e.calendar_id,
            title=e.title,
            description=e.description,
            location=e.location,
            start=e.start,
            end=e.end,
            all_day=e.all_day,
            latitude=e.latitude,
            longitude=e.longitude,
            color=color_map.get(e.calendar_id),
            view_count=view_counts.get(e.event_id, 0),
            going_count=going_counts.get(e.event_id, 0),
            saved_count=saved_counts.get(e.event_id, 0),
            popularity_score=scores.get(e.event_id, 0.0),
            following_friend_count=following_counts.get(e.event_id, 0),
            following_friends_preview=following_previews.get(e.event_id, []),
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
            has_active_promo_codes=e.event_id in events_with_promos,
        )
        for e in events
    ]


@router.get("/{event_id}", response_model=EventResponse)
@limiter.limit("300/minute")
def get_event(
    event_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Public single-event endpoint for shareable event pages."""
    event = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id == event_id,
            CachedEvent.deleted_at == None,
            CachedEvent.is_hidden == False,
        )
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Check calendar is enabled
    calendar = session.exec(
        select(CalendarSetting).where(
            CalendarSetting.calendar_id == event.calendar_id,
            CalendarSetting.enabled == True,
        )
    ).first()
    if not calendar:
        raise HTTPException(status_code=404, detail="Event not found")

    view_count = session.exec(
        select(func.count(EventView.id)).where(EventView.event_id == event_id)
    ).one()

    going_count = session.exec(
        select(func.count(UserEventAttendance.id)).where(
            UserEventAttendance.event_id == event_id
        )
    ).one()

    tags_map = get_event_tags(session, [event_id])

    # Surface organizer pill when the flag is on and the event has an
    # admin-approved attribution. Kept inline here (rather than calling
    # ``serialize_events``) because this endpoint hand-builds its
    # ``EventResponse`` for the single-event share page.
    organizer_mini: Optional[EventOrganizerMini] = None
    if event.organizer_user_id:
        from backend.db.models import SiteSetting

        flag_row = session.get(SiteSetting, "organizer_claims_enabled")
        if flag_row and flag_row.value.lower() == "true":
            u = session.get(User, event.organizer_user_id)
            if u is not None:
                organizer_mini = EventOrganizerMini(
                    user_id=u.id,
                    handle=u.handle,
                    display_name=u.display_name,
                    avatar_url=u.avatar_url,
                    is_verified_organizer=u.is_verified_organizer,
                )

    data = EventResponse(
        event_id=event.event_id,
        calendar_id=event.calendar_id,
        title=event.title,
        description=event.description,
        location=event.location,
        start=event.start,
        end=event.end,
        all_day=event.all_day,
        latitude=event.latitude,
        longitude=event.longitude,
        color=calendar.color,
        view_count=view_count,
        going_count=going_count,
        price_min=event.price_min,
        price_max=event.price_max,
        price_currency=event.price_currency,
        price_is_free=event.price_is_free,
        review_status=event.review_status,
        links=event.links,
        tags=tags_map.get(event_id, []),
        organizer=organizer_mini,
    )
    response = JSONResponse(content=data.model_dump(mode="json"))
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


@router.get("/{event_id}/og-meta")
@limiter.limit("600/minute")
def get_event_og_meta(
    event_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Lightweight metadata endpoint consumed by the Cloudflare Pages
    Function that pre-renders Open Graph tags for crawlers.

    Kept deliberately minimal (no view counts, no tags, no attendees) so
    the edge function can be cached aggressively and respond within the
    crawler's tight timeout budgets. Returned fields mirror the OG/SEO
    surface only.
    """
    event = session.exec(
        select(CachedEvent).where(
            CachedEvent.event_id == event_id,
            CachedEvent.deleted_at == None,  # noqa: E711 (SQLAlchemy comparison)
            CachedEvent.is_hidden == False,  # noqa: E712
        )
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    calendar = session.exec(
        select(CalendarSetting).where(
            CalendarSetting.calendar_id == event.calendar_id,
            CalendarSetting.enabled == True,  # noqa: E712
        )
    ).first()
    if not calendar:
        raise HTTPException(status_code=404, detail="Event not found")

    # Truncate description for the meta tag — most crawlers cap previews
    # around 200 chars and trailing whitespace looks ugly in cards.
    description = (event.description or "").strip()
    if len(description) > 200:
        description = description[:197].rstrip() + "…"

    payload = {
        "event_id": event.event_id,
        "title": event.title,
        "description": description or None,
        "location": event.location,
        "start": event.start.isoformat() if event.start else None,
        "end": event.end.isoformat() if event.end else None,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "price_is_free": event.price_is_free,
        "price_min": event.price_min,
        "price_currency": event.price_currency,
    }
    response = JSONResponse(content=payload)
    # Cache aggressively — bots re-fetch frequently and event metadata
    # changes rarely. 5min browser, 1h shared cache (CDN).
    response.headers["Cache-Control"] = "public, max-age=300, s-maxage=3600"
    return response


@router.get("/seo/sitemap.xml")
@limiter.limit("10/minute")
def get_sitemap(
    request: Request,
    session: Session = Depends(get_session),
):
    """Dynamic sitemap listing all reviewed events from enabled calendars."""
    import os

    base_url = os.getenv("PUBLIC_URL", "https://example.com")

    enabled_calendars = session.exec(
        select(CalendarSetting).where(CalendarSetting.enabled == True)
    ).all()
    calendar_ids = [c.calendar_id for c in enabled_calendars]

    if not calendar_ids:
        events = []
    else:
        events = session.exec(
            select(CachedEvent).where(
                CachedEvent.calendar_id.in_(calendar_ids),
                CachedEvent.deleted_at == None,
                CachedEvent.is_hidden == False,
            )
        ).all()

    urls = [
        f"  <url>\n    <loc>{base_url}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>"
    ]
    for e in events:
        lastmod = (
            e.updated_at.strftime("%Y-%m-%d")
            if e.updated_at
            else e.start.strftime("%Y-%m-%d")
        )
        urls.append(
            f"  <url>\n"
            f"    <loc>{base_url}/event/{e.event_id}</loc>\n"
            f"    <lastmod>{lastmod}</lastmod>\n"
            f"    <changefreq>weekly</changefreq>\n"
            f"  </url>"
        )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>"
    )
    return Response(content=xml, media_type="application/xml")
