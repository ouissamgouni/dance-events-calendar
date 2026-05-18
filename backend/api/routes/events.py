from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter
from sqlalchemy import func
from sqlmodel import Session, select

from backend.api.deps import (
    _audience_passes,
    can_view,
    get_current_user_optional,
)
from backend.api.rate_limit import client_ip
from backend.api.routes.settings import _get_since_date
from backend.api.schemas import (
    CalendarSettingResponse,
    EventBatchRequest,
    EventResponse,
)
from backend.api.routes.tags import get_event_tags
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
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


def _viewer_friend_ids(session: Session, viewer: Optional[User]) -> list:
    """Return the user_ids of the viewer's friends (mutual followers).

    Returns an empty list for anonymous viewers (no follow graph anchor).
    Used by the explorer friend filter on ``GET /api/events``.
    """
    if viewer is None or viewer.id is None:
        return []
    # Self-join: x is a friend of viewer iff viewer follows x AND x follows
    # viewer. Single SELECT with a sub-query avoids two round-trips.
    out = (
        select(UserFollow.followee_id)
        .where(UserFollow.follower_id == viewer.id)
        .where(
            UserFollow.followee_id.in_(
                select(UserFollow.follower_id).where(
                    UserFollow.followee_id == viewer.id
                )
            )
        )
    )
    return [row for row in session.exec(out).all()]


def _friend_filtered_event_ids(
    *,
    session: Session,
    viewer: Optional[User],
    friends_going: bool,
    friends_saved: bool,
    friend_handle: Optional[str],
) -> list[str]:
    """Compute the set of event_ids visible to the viewer via the friend filter.

    Resolution order:

    1. If ``friend_handle`` is supplied, narrow the friend set to that single
       user. The handle's owner must currently pass ``can_view`` for each
       requested scope; failures silently drop that scope so a private
       attendance list cannot be probed via this endpoint.
    2. Otherwise, the friend set is the viewer's mutual followers.
    3. For each enabled scope, collect event_ids from
       ``user_event_attendance`` (going) and ``user_saved_event`` (saved)
       restricted to friends whose own visibility allows the viewer to see
       that scope.

    The returned list is the UNION across enabled scopes (empty list means
    "no matches" — caller short-circuits the parent query).
    """
    # Resolve the candidate friend set up front so each scope check operates
    # on a stable list of (User, id) pairs.
    candidates: list[User] = []
    if friend_handle is not None:
        h = (friend_handle or "").strip().lower()
        if not h:
            return []
        target = session.exec(select(User).where(func.lower(User.handle) == h)).first()
        if target is None or target.deleted_at is not None:
            return []
        candidates = [target]
        # If the viewer asked for the friend filter via handle, we don't
        # require the target to actually be a mutual follower — discovery by
        # handle is intentional and the visibility of each scope is still
        # enforced below.
    else:
        if viewer is None:
            return []
        friend_ids = _viewer_friend_ids(session, viewer)
        if not friend_ids:
            return []
        candidates = list(
            session.exec(select(User).where(User.id.in_(friend_ids))).all()
        )

    # Default: at least one of the two scopes must be enabled. If a caller
    # passes friend_handle alone, treat it as "any activity from this friend"
    # (going OR saved) so the explorer chip "Show what alice is up to" works.
    if not friends_going and not friends_saved:
        friends_going = True
        friends_saved = True

    going_owner_ids: list = []
    saved_owner_ids: list = []
    owner_by_id: dict = {}
    for friend in candidates:
        # Single account-level gate: per-row audience further narrows
        # which events of each owner show up.
        if not can_view(session, viewer, friend):
            continue
        owner_by_id[friend.id] = friend
        if friends_going:
            going_owner_ids.append(friend.id)
        if friends_saved:
            saved_owner_ids.append(friend.id)

    if not going_owner_ids and not saved_owner_ids:
        return []

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
    friends_going: bool = Query(
        False,
        description=(
            "Restrict to events at least one of the viewer's friends "
            "(mutual followers) is going to. Requires auth; returns an "
            "empty list for anonymous viewers."
        ),
    ),
    friends_saved: bool = Query(
        False,
        description=(
            "Restrict to events at least one of the viewer's friends has "
            "saved. Requires auth; returns an empty list for anonymous "
            "viewers. Combines with friends_going as a UNION when both are "
            "true."
        ),
    ),
    friend_handle: Optional[str] = Query(
        None,
        description=(
            "Narrow the friend filter to a specific @handle. The handle's "
            "owner must currently pass can_view for the relevant scope; "
            "otherwise an empty list is returned (privacy chokepoint — "
            "never 403 / 404)."
        ),
    ),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
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

    # Friend filter (Phase B): restrict to events that one or more friends
    # have marked going / saved. The viewer's "friends" are mutual followers
    # (or just the single user named by ``friend_handle``). Each filtered
    # source is gated by ``can_view`` on the owner so we never leak activity
    # the owner has chosen to hide.
    if friends_going or friends_saved or friend_handle is not None:
        friend_event_ids = _friend_filtered_event_ids(
            session=session,
            viewer=current_user,
            friends_going=friends_going,
            friends_saved=friends_saved,
            friend_handle=friend_handle,
        )
        if not friend_event_ids:
            # Empty match — short-circuit so we don't pay for any of the
            # downstream batch queries (and so anonymous viewers get a
            # consistently empty list).
            response = JSONResponse(content=[])
            response.headers["Cache-Control"] = "private, max-age=0"
            return response
        query = query.where(CachedEvent.event_id.in_(friend_event_ids))

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

    # Batch-fetch tags
    tags_map = get_event_tags(session, event_ids)

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
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
        )
        for e in events
    ]

    response = JSONResponse(content=[d.model_dump(mode="json") for d in data])
    response.headers["Cache-Control"] = "public, max-age=60"
    return response


@router.post("/by-ids", response_model=list[EventResponse])
@limiter.limit("120/minute")
def get_events_by_ids(
    request: Request,
    payload: EventBatchRequest,
    session: Session = Depends(get_session),
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

    tags_map = get_event_tags(session, event_ids)

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
            price_min=e.price_min,
            price_max=e.price_max,
            price_currency=e.price_currency,
            price_is_free=e.price_is_free,
            links=e.links,
            tags=tags_map.get(e.event_id, []),
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
