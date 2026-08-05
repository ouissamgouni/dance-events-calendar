"""Dance Passport API — a dancer's private journey (self-only)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlmodel import Session, select

from backend.api.deps import get_current_user_optional, require_user
from backend.api.event_serializer import serialize_events
from backend.api.schemas import (
    AckMilestonesRequest,
    AckMilestonesResponse,
    CreatePassportShareRequest,
    PassportCollections,
    PassportMapEvent,
    PassportMilestone,
    PassportResponse,
    PassportStats,
    PassportTimelineItem,
    PassportTimelineMarker,
    PassportTimelineResponse,
    ShareTokenResponse,
    SharedPassportResponse,
)
from backend.db.database import get_session
from backend.db.models import PassportShareToken, User, UserFollow
from backend.services import passport as passport_service

router = APIRouter(prefix="/api/passport", tags=["passport"])


def _public_display_name(user: User) -> str | None:
    """First name only — never expose the owner's email or full name publicly."""
    raw = (user.display_name or "").strip()
    if raw:
        return raw.split()[0]
    if user.handle:
        return f"@{user.handle}"
    if user.email:
        return user.email.split("@", 1)[0]
    return None


def _soft_location(city: str | None, country: str | None) -> str | None:
    """City-level location for shared/profile timelines — never the exact
    venue string the owner sees on their own private timeline."""
    parts = [p for p in (city, country) if p]
    return ", ".join(parts) if parts else None


def owner_passport_sections(owner: User) -> list[str]:
    """Sections the owner has opted to share, in display order.

    Stats are always shown and are not represented here. Timeline defaults
    OFF; the other three default ON.
    """
    sections: list[str] = []
    if getattr(owner, "passport_show_badges", True):
        sections.append("milestones")
    if getattr(owner, "passport_show_timeline", False):
        sections.append("timeline")
    if getattr(owner, "passport_show_cities", True):
        sections.append("cities")
    if getattr(owner, "passport_show_countries", True):
        sections.append("countries")
    return sections


def build_shared_passport(
    session: Session,
    owner: User,
    *,
    display_name: str | None,
    viewer: User | None = None,
) -> SharedPassportResponse:
    """Assemble a read-only passport honoring the owner's per-section flags.

    Shared by the public share-link endpoint and the relationship-checked
    profile passport endpoint. Only the sections the owner opted into are
    populated; everything else stays empty so nothing leaks past the toggle.
    The timeline is softened to city-level (never the exact venue). Follow
    fields (``handle`` / ``is_self`` / ``is_following``) are computed relative
    to ``viewer`` so the client can render a Follow CTA.
    """
    sections = owner_passport_sections(owner)
    show_map = "cities" in sections or "countries" in sections
    show_timeline = "timeline" in sections

    ctx = passport_service.build_stats_context(session, owner)
    stats = PassportStats(
        total_events_attended=ctx["total_events"],
        cities_visited=len(ctx["cities"]),
        countries_visited=len(ctx["countries"]),
        reviews_written=ctx["reviews"],
        styles_danced=len(ctx["styles"]),
        longest_month_streak=ctx["longest_streak"],
        events_last_30_days=ctx["events_last_30d"],
        avg_gap_days=ctx["avg_gap_days"],
        first_event_date=ctx["first_event_date"],
        member_since=ctx["member_since"],
    )

    milestones: list[PassportMilestone] = []
    if "milestones" in sections:
        milestones = [
            PassportMilestone(**{**m, "is_new": False})
            for m in passport_service.milestone_view(session, owner, ctx)
        ]

    # Named city/country collections leak place names, so gate them behind the
    # map sections (the count-only stats above are always safe to show).
    collections = (
        passport_service.collections(ctx["events"])
        if show_map
        else {"cities": [], "countries": []}
    )

    attended = (
        passport_service.attended_events(session, owner.id)
        if show_map or show_timeline
        else []
    )

    events: list[PassportMapEvent] = []
    if show_map:
        place_by_id = {e.event_id: (e.city, e.country) for e in attended}
        for ev in serialize_events(session, attended):
            city, country = place_by_id.get(ev.event_id, (None, None))
            events.append(
                PassportMapEvent(**ev.model_dump(), city=city, country=country)
            )

    timeline_items: list[PassportTimelineItem] = []
    timeline_markers: list[PassportTimelineMarker] = []
    if show_timeline:
        # City-level softening: drop the exact venue string and coordinates so
        # the shared timeline never pinpoints where the dancer was.
        timeline_items = [
            PassportTimelineItem(
                event_id=e.event_id,
                title=e.title,
                start=e.start,
                location=_soft_location(e.city, e.country),
                city=e.city,
                country=e.country,
                latitude=None,
                longitude=None,
            )
            for e in attended
        ]
        intl_ids = passport_service.international_event_ids(
            session, [e.event_id for e in attended]
        )
        timeline_markers = [
            PassportTimelineMarker(**m)
            for m in passport_service.timeline_milestone_markers(attended, intl_ids)
        ]

    is_self = viewer is not None and viewer.id == owner.id
    is_following = False
    if viewer is not None and not is_self:
        is_following = (
            session.exec(
                select(UserFollow.id)
                .where(UserFollow.follower_id == viewer.id)
                .where(UserFollow.followee_id == owner.id)
                .where(UserFollow.status == "approved")
            ).first()
            is not None
        )

    return SharedPassportResponse(
        display_name=display_name,
        stats=stats,
        collections=PassportCollections(**collections),
        milestones=milestones,
        events=events,
        sections=sections,
        timeline_items=timeline_items,
        timeline_markers=timeline_markers,
        handle=owner.handle,
        is_self=is_self,
        is_following=is_following,
    )


@router.get("", response_model=PassportResponse)
def get_passport(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> PassportResponse:
    # Lazy unlock on passport open so newly-earned milestones surface (and the
    # celebration toast fires). Phase C moves the source of truth to the
    # background scheduler; this stays idempotent.
    passport_service.evaluate_and_persist(session, user)
    ctx = passport_service.build_stats_context(session, user)
    stats = PassportStats(
        total_events_attended=ctx["total_events"],
        cities_visited=len(ctx["cities"]),
        countries_visited=len(ctx["countries"]),
        reviews_written=ctx["reviews"],
        styles_danced=len(ctx["styles"]),
        longest_month_streak=ctx["longest_streak"],
        events_last_30_days=ctx["events_last_30d"],
        avg_gap_days=ctx["avg_gap_days"],
        first_event_date=ctx["first_event_date"],
        member_since=ctx["member_since"],
    )
    collections = passport_service.collections(ctx["events"])
    milestones = [
        PassportMilestone(**m)
        for m in passport_service.milestone_view(session, user, ctx)
    ]
    return PassportResponse(
        stats=stats,
        collections=PassportCollections(**collections),
        milestones=milestones,
    )


@router.get("/events", response_model=list[PassportMapEvent])
def get_passport_events(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> list[PassportMapEvent]:
    """Attended events hydrated as full events for the Cities/Countries map."""
    events = passport_service.attended_events(session, user.id)
    place_by_id = {e.event_id: (e.city, e.country) for e in events}
    result: list[PassportMapEvent] = []
    for ev in serialize_events(session, events):
        city, country = place_by_id.get(ev.event_id, (None, None))
        result.append(PassportMapEvent(**ev.model_dump(), city=city, country=country))
    return result


@router.post("/milestones/ack", response_model=AckMilestonesResponse)
def ack_milestones(
    payload: AckMilestonesRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> AckMilestonesResponse:
    acknowledged = passport_service.acknowledge_milestones(session, user, payload.keys)
    return AckMilestonesResponse(acknowledged=acknowledged)


@router.get("/timeline", response_model=PassportTimelineResponse)
def get_passport_timeline(
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> PassportTimelineResponse:
    events = passport_service.attended_events(session, user.id)
    page = events[offset : offset + limit]
    items = [
        PassportTimelineItem(
            event_id=e.event_id,
            title=e.title,
            start=e.start,
            location=e.location,
            city=e.city,
            country=e.country,
            latitude=e.latitude,
            longitude=e.longitude,
        )
        for e in page
    ]
    intl_ids = passport_service.international_event_ids(
        session, [e.event_id for e in events]
    )
    markers = [
        PassportTimelineMarker(**m)
        for m in passport_service.timeline_milestone_markers(events, intl_ids)
    ]
    return PassportTimelineResponse(items=items, markers=markers, total=len(events))


@router.post("/share", response_model=ShareTokenResponse, status_code=201)
def create_passport_share(
    body: CreatePassportShareRequest | None = None,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> ShareTokenResponse:
    """Mint (or reuse) an opt-in public share link for the user's passport.

    The optional ``require_signin`` flag is (re)applied on every call so the
    share dialog can flip it without needing a separate endpoint.
    """
    require_signin = bool(body.require_signin) if body else False
    existing = session.exec(
        select(PassportShareToken).where(PassportShareToken.user_id == user.id)
    ).first()
    if existing:
        if existing.require_signin != require_signin:
            existing.require_signin = require_signin
            session.add(existing)
            session.commit()
        return ShareTokenResponse(
            token=existing.token, require_signin=existing.require_signin
        )
    token = str(uuid.uuid4())
    session.add(
        PassportShareToken(token=token, user_id=user.id, require_signin=require_signin)
    )
    session.commit()
    return ShareTokenResponse(token=token, require_signin=require_signin)


@router.get("/share", response_model=ShareTokenResponse | None)
def get_passport_share(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> ShareTokenResponse | None:
    """Return the caller's existing passport share link, or ``null`` if the
    passport isn't currently shared. Lets the share dialog show the live link
    (and offer "Stop sharing") without minting a new token on open.
    """
    existing = session.exec(
        select(PassportShareToken).where(PassportShareToken.user_id == user.id)
    ).first()
    if existing is None:
        return None
    return ShareTokenResponse(
        token=existing.token, require_signin=existing.require_signin
    )


@router.delete("/share", status_code=204)
def revoke_passport_share(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
) -> Response:
    """Stop sharing: delete the caller's share token so the public link 404s.
    A subsequent ``POST /share`` mints a brand-new (different) token.
    """
    existing = session.exec(
        select(PassportShareToken).where(PassportShareToken.user_id == user.id)
    ).first()
    if existing is not None:
        session.delete(existing)
        session.commit()
    return Response(status_code=204)


@router.get("/shared/{token}", response_model=SharedPassportResponse)
def get_shared_passport(
    token: str,
    viewer: User | None = Depends(get_current_user_optional),
    session: Session = Depends(get_session),
) -> SharedPassportResponse:
    """Public, read-only passport — stats, collections, milestones and the
    attended-event map. Reuses the owner-facing surface but never exposes the
    private timeline or the owner's email/full name.

    When the share was minted with ``require_signin`` the link only resolves
    for an authenticated viewer (401 otherwise).
    """
    share = session.exec(
        select(PassportShareToken).where(PassportShareToken.token == token)
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Passport link not found")
    if share.require_signin and viewer is None:
        raise HTTPException(status_code=401, detail="Sign in to view this passport")
    owner = session.get(User, share.user_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="Passport link not found")

    return build_shared_passport(
        session,
        owner,
        display_name=_public_display_name(owner),
        viewer=viewer,
    )
