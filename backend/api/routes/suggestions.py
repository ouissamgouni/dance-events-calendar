import logging
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, col, select

from backend.api.deps import get_client_ip, get_current_user_optional, require_admin
from backend.db.models import User
from backend.api.schemas import (
    EventSuggestionCreate,
    EventSuggestionPublicResponse,
    EventSuggestionResponse,
    GeocodeSuggestion,
    SuggestionApproveRequest,
    SuggestionOccurrence,
    SuggestionOccurrencesResponse,
    SuggestionRejectRequest,
    SuggestionUpdateRequest,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    EventPromoCode,
    EventSeries,
    EventSeriesMember,
    EventSuggestion,
    EventTag,
    Tag,
    TagSuggestion,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.email import send_suggestion_notification
from backend.services.geocoding import geocode_location
from backend.services.ip_geolocation import geolocate_ip
from backend.services.reach import sync_event_reach
from backend.services.recurrence import expand_occurrences
from backend.services import activity_instant
from backend.services.notifications import fan_out_going, fan_out_suggested

logger = logging.getLogger(__name__)

router = APIRouter(tags=["suggestions"])

limiter = Limiter(key_func=client_ip)

USER_SUBMISSION_CALENDAR_ID = "user-submissions"

# A pending suggestion is already publicly visible, so the submitter should be
# able to see the shape of their series straight away. Fanning out all 52
# occurrences would put that many unreviewed rows into the listings, so submit
# materialises a bounded preview and approval expands the rest.
PREVIEW_OCCURRENCE_LIMIT = 10
PREVIEW_HORIZON_DAYS = 90


def _ensure_user_submission_calendar(session: Session) -> CalendarSetting:
    calendar = session.get(CalendarSetting, USER_SUBMISSION_CALENDAR_ID)
    if calendar is None:
        calendar = CalendarSetting(
            calendar_id=USER_SUBMISSION_CALENDAR_ID,
            name="User submissions",
            enabled=True,
            show_events=True,
        )
        session.add(calendar)
    return calendar


def _occurrence_event_id(suggestion: EventSuggestion, index: int) -> str:
    # Occurrence 0 keeps the historical id so created_event_id, BlockedEvent
    # rows and already-sent notifications keep resolving.
    if index == 0:
        return suggestion.created_event_id or f"suggestion-{suggestion.id}"
    return f"suggestion-{suggestion.id}-{index}"


def _upsert_occurrences_from_suggestion(
    session: Session,
    suggestion: EventSuggestion,
    *,
    review_status: str,
    calendar_id: str,
    latitude: float | None,
    longitude: float | None,
    limit: int | None = None,
    horizon_end: datetime | None = None,
) -> list[CachedEvent]:
    """Materialise one CachedEvent per recurrence occurrence.

    Occurrences are always expanded from the suggestion's original start so an
    occurrence's index — and therefore its event id — is stable across calls.
    """
    occurrences = expand_occurrences(
        suggestion.start,
        suggestion.end,
        suggestion.recurrence_rule,
        suggestion.recurrence_dates,
        limit=limit,
        horizon_end=horizon_end,
    )

    events: list[CachedEvent] = []
    for index, (start, end) in enumerate(occurrences):
        event_id = _occurrence_event_id(suggestion, index)
        cached_event = session.get(CachedEvent, event_id)
        if cached_event is None:
            cached_event = CachedEvent(
                event_id=event_id,
                calendar_id=calendar_id,
                title=suggestion.title,
                description=suggestion.description,
                location=suggestion.location,
                start=start,
                end=end,
                all_day=suggestion.all_day,
                latitude=latitude,
                longitude=longitude,
                links=suggestion.links,
                price_min=suggestion.price_min,
                price_max=suggestion.price_max,
                price_currency=suggestion.price_currency,
                price_is_free=suggestion.price_is_free,
                review_status=review_status,
            )
        else:
            cached_event.calendar_id = calendar_id
            cached_event.title = suggestion.title
            cached_event.description = suggestion.description
            cached_event.location = suggestion.location
            cached_event.start = start
            cached_event.end = end
            cached_event.all_day = suggestion.all_day
            cached_event.latitude = latitude
            cached_event.longitude = longitude
            cached_event.links = suggestion.links
            cached_event.price_min = suggestion.price_min
            cached_event.price_max = suggestion.price_max
            cached_event.price_currency = suggestion.price_currency
            cached_event.price_is_free = suggestion.price_is_free
            cached_event.review_status = review_status
            cached_event.is_hidden = False
            cached_event.deleted_at = None
        cached_event.suggestion_id = suggestion.id
        session.add(cached_event)
        events.append(cached_event)

    suggestion.created_event_id = events[0].event_id
    _hide_orphaned_occurrences(session, suggestion, {e.event_id for e in events})
    return events


def _hide_orphaned_occurrences(
    session: Session, suggestion: EventSuggestion, keep_event_ids: set[str]
) -> None:
    """Hide rows left behind when an admin edit shrinks the occurrence set."""
    existing = session.exec(
        select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
    ).all()
    for event in existing:
        if event.event_id not in keep_event_ids and not event.is_hidden:
            event.is_hidden = True
            session.add(event)


def _link_occurrences_to_series(
    session: Session,
    suggestion: EventSuggestion,
    events: list[CachedEvent],
    admin_email: str | None,
) -> EventSeries | None:
    """Group a declared recurrence's occurrences under one EventSeries.

    Reuses the series that fuzzy detection populates, but pre-resolved: the
    grouping is declared by the submitter, not inferred, so there is nothing
    for an admin to confirm. Members already carry a series (``event_id`` is
    globally unique in ``event_series_members``) are left alone.
    """
    if len(events) < 2:
        return None

    members = session.exec(
        select(EventSeriesMember).where(
            col(EventSeriesMember.event_id).in_([e.event_id for e in events])
        )
    ).all()
    series = None
    if members:
        series = session.get(EventSeries, members[0].series_id)
    if series is None:
        series = EventSeries(
            status="resolved",
            source="manual",
            canonical_title=suggestion.title[:200],
            resolved_at=datetime.utcnow(),
            resolved_by_admin=admin_email,
        )
        session.add(series)
        session.flush()

    linked = {member.event_id for member in members}
    for event in events:
        if event.event_id not in linked:
            session.add(EventSeriesMember(series_id=series.id, event_id=event.event_id))
    return series


def _apply_suggestion_tags(
    session: Session, event_id: str, suggested_tag_ids: list[int]
) -> None:
    event = session.get(CachedEvent, event_id)
    if event is not None:
        sync_event_reach(session, event, suggested_tag_ids)
    for tag_id in suggested_tag_ids:
        tag = session.get(Tag, tag_id)
        if not tag:
            continue
        existing = session.exec(
            select(EventTag).where(
                EventTag.event_id == event_id,
                EventTag.tag_id == tag_id,
            )
        ).first()
        if existing is None:
            session.add(EventTag(event_id=event_id, tag_id=tag_id))


def _upsert_creator_going(
    session: Session, actor: User, event_id: str, audience: str
) -> None:
    existing = session.exec(
        select(UserEventAttendance).where(
            UserEventAttendance.user_id == actor.id,
            UserEventAttendance.event_id == event_id,
        )
    ).first()
    if existing is None:
        session.add(
            UserEventAttendance(
                device_id=str(actor.id),
                event_id=event_id,
                user_id=actor.id,
                share_publicly=audience == "public",
                share_audience=audience,
            )
        )
        return
    existing.device_id = str(actor.id)
    existing.user_id = actor.id
    existing.share_publicly = audience == "public"
    existing.share_audience = audience
    session.add(existing)


def _apply_creator_going(
    session: Session,
    suggestion: EventSuggestion,
    events: list[CachedEvent],
    *,
    fan_out: bool,
) -> None:
    """Replay the submitter's "I'm going" onto ``events``.

    Called from every wave that materialises occurrences (submit, approve, the
    rolling extension job) so the RSVP covers the whole declared recurrence
    rather than whichever occurrences happened to exist at submit time.

    ``fan_out`` is True only on submit: notifications dedupe on ``event_id``,
    so notifying per occurrence would send each follower one "is going" per
    date. The series is announced once, anchored on the first occurrence.
    """
    if not suggestion.creator_going or suggestion.submitter_user_id is None:
        return
    if not events:
        return
    actor = session.get(User, suggestion.submitter_user_id)
    if actor is None:
        return

    audience = (
        suggestion.creator_going_audience
        or actor.share_attendance_default_audience
        or "friends"
    )
    for event in events:
        _upsert_creator_going(session, actor, event.event_id, audience)
    if fan_out:
        fan_out_going(session, actor, events[0].event_id, audience=audience)


# --- Background tasks ---


async def _geolocate_and_update(suggestion_id: UUID, ip: str):
    """Background task: geolocate IP and update the suggestion row."""
    from backend.db.database import get_engine
    from sqlmodel import Session as SyncSession

    geo = await geolocate_ip(ip)
    if not geo:
        return

    engine = get_engine()
    with SyncSession(engine) as session:
        suggestion = session.get(EventSuggestion, suggestion_id)
        if suggestion:
            suggestion.submitter_city = geo.get("city")
            suggestion.submitter_country = geo.get("country")
            suggestion.submitter_lat = geo.get("lat")
            suggestion.submitter_lng = geo.get("lon")
            session.add(suggestion)
            session.commit()


def _notify_admin(suggestion):
    """Background task: send email notification."""
    admin_email = get_admin_email()
    if admin_email:
        send_suggestion_notification(suggestion, admin_email)


# --- Public endpoints ---


@router.post(
    "/api/suggestions",
    response_model=EventSuggestionPublicResponse,
    status_code=201,
)
@limiter.limit("5/hour")
def submit_suggestion(
    body: EventSuggestionCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    current_user: User | None = Depends(get_current_user_optional),
):
    """Public endpoint: submit an event suggestion."""
    # Honeypot check — silent reject
    if body.website:
        return EventSuggestionPublicResponse(
            id="00000000-0000-0000-0000-000000000000",
            message="Thank you! Your suggestion is under review.",
        )

    client_ip = get_client_ip(request)

    suggestion = EventSuggestion(
        title=body.title,
        description=body.description,
        location=body.location,
        links=[link.model_dump() for link in body.links] if body.links else None,
        latitude=body.latitude,
        longitude=body.longitude,
        start=body.start,
        end=body.end,
        all_day=body.all_day,
        recurrence_rule=body.recurrence_rule,
        recurrence_dates=[
            item.model_dump(mode="json") for item in body.recurrence_dates
        ]
        if body.recurrence_dates
        else None,
        submitter_name=body.submitter_name,
        submitter_email=body.submitter_email,
        submitter_user_id=current_user.id if current_user else None,
        submitter_ip=client_ip,
        submitter_user_agent=request.headers.get("user-agent"),
        submitter_language=request.headers.get("accept-language"),
        submitter_referrer=request.headers.get("referer"),
        submitter_screen_size=body.screen_size,
        submitter_timezone=body.timezone,
        suggested_tag_ids=body.suggested_tag_ids if body.suggested_tag_ids else None,
        suggested_new_tags=[item.model_dump() for item in body.suggested_new_tags]
        if body.suggested_new_tags
        else None,
        promo_code=body.promo_code,
        promo_description=body.promo_description,
        promo_source_url=body.promo_source_url,
        price_min=body.price_min,
        price_max=body.price_max,
        price_currency=body.price_currency,
        price_is_free=body.price_is_free,
        auto_save=body.auto_save,
        creator_going=bool(body.going) and current_user is not None,
        creator_going_audience=body.going_audience if body.going else None,
    )

    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    if current_user is not None:
        _ensure_user_submission_calendar(session)
        # Materialise a bounded preview of the recurrence so the submitter sees
        # every upcoming date rather than just the first one. Approval expands
        # the series to the full horizon.
        cached_events = _upsert_occurrences_from_suggestion(
            session,
            suggestion,
            review_status="pending",
            calendar_id=USER_SUBMISSION_CALENDAR_ID,
            latitude=body.latitude,
            longitude=body.longitude,
            limit=PREVIEW_OCCURRENCE_LIMIT,
            horizon_end=datetime.utcnow() + timedelta(days=PREVIEW_HORIZON_DAYS),
        )
        cached_event = cached_events[0]
        for occurrence in cached_events:
            _apply_suggestion_tags(
                session, occurrence.event_id, suggestion.suggested_tag_ids or []
            )
        # Group the preview occurrences so the listings collapse them into one
        # series instead of showing the same event ten times.
        _link_occurrences_to_series(session, suggestion, cached_events, None)
        _apply_creator_going(session, suggestion, cached_events, fan_out=True)
        session.add(suggestion)
        session.commit()
        session.refresh(suggestion)
        if body.going and current_user is not None:
            # Instant "friends going" email for the creator's own Going,
            # when that feature is configured for instant delivery.
            try:
                activity_instant.dispatch_activity_instant(
                    session,
                    kind="subscription_going",
                    actor=current_user,
                    event_id=cached_event.event_id,
                )
            except Exception:  # noqa: BLE001 — best-effort
                logger.warning("Instant friends-going email failed", exc_info=True)

    # Fire background tasks
    background_tasks.add_task(_geolocate_and_update, suggestion.id, client_ip)
    background_tasks.add_task(_notify_admin, suggestion)

    return EventSuggestionPublicResponse(
        id=suggestion.id,
        message="Thank you! Your suggestion is under review.",
    )


@router.get("/api/suggestions/geocode", response_model=list[GeocodeSuggestion])
@limiter.limit("10/minute")
def suggestion_geocode(
    request: Request,
    q: str = Query(..., min_length=3, max_length=200),
):
    """Public geocode search for the suggestion form address autocomplete."""
    from geopy.exc import GeocoderServiceError, GeocoderTimedOut
    from geopy.geocoders import Nominatim
    from backend.services.geocoding import (
        _language_preference_from_header,
        nominatim_suggestion,
    )

    geocoder = Nominatim(user_agent="movida", timeout=5)
    accept_language = request.headers.get("accept-language")
    language_pref = _language_preference_from_header(accept_language)
    try:
        results = geocoder.geocode(
            q,
            exactly_one=False,
            limit=5,
            language=language_pref,
            addressdetails=True,
            namedetails=True,
        )
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning("Geocode search failed: %s", e)
        return []
    except Exception:
        logger.exception("Unexpected geocode search error")
        return []

    if not results:
        return []

    return [GeocodeSuggestion(**nominatim_suggestion(result)) for result in results]


# --- Admin endpoints ---


@router.get("/api/admin/suggestions", response_model=list[EventSuggestionResponse])
def list_suggestions(
    status: str | None = Query(default=None),
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """List all suggestions, optionally filtered by status."""
    query = select(EventSuggestion).order_by(col(EventSuggestion.created_at).desc())
    if status:
        query = query.where(EventSuggestion.status == status)
    suggestions = session.exec(query).all()
    return suggestions


@router.get(
    "/api/admin/suggestions/{suggestion_id}", response_model=EventSuggestionResponse
)
def get_suggestion(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return suggestion


@router.get(
    "/api/admin/suggestions/{suggestion_id}/occurrences",
    response_model=SuggestionOccurrencesResponse,
)
def get_suggestion_occurrences(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    """Every date this suggestion expands to, for review before approval.

    Expanded from the recurrence rather than read from ``cached_events``, so an
    admin sees the full set approval would create — not just the bounded
    preview materialised at submit time.
    """
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    expanded = expand_occurrences(
        suggestion.start,
        suggestion.end,
        suggestion.recurrence_rule,
        suggestion.recurrence_dates,
    )
    materialised = {
        event.event_id
        for event in session.exec(
            select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
        ).all()
        if not event.is_hidden
    }

    occurrences = []
    for index, (start, end) in enumerate(expanded):
        event_id = _occurrence_event_id(suggestion, index)
        occurrences.append(
            SuggestionOccurrence(
                index=index,
                start=start,
                end=end,
                event_id=event_id if event_id in materialised else None,
                materialised=event_id in materialised,
            )
        )
    return SuggestionOccurrencesResponse(
        total=len(occurrences), occurrences=occurrences
    )


@router.patch(
    "/api/admin/suggestions/{suggestion_id}", response_model=EventSuggestionResponse
)
def update_suggestion(
    suggestion_id: UUID,
    body: SuggestionUpdateRequest,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    update_data = body.model_dump(exclude_unset=True)
    if "links" in update_data and update_data["links"] is not None:
        update_data["links"] = [
            link if isinstance(link, dict) else link.model_dump()
            for link in update_data["links"]
        ]

    for field, value in update_data.items():
        setattr(suggestion, field, value)

    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return suggestion


@router.post(
    "/api/admin/suggestions/{suggestion_id}/approve",
    response_model=EventSuggestionResponse,
)
def approve_suggestion(
    suggestion_id: UUID,
    body: SuggestionApproveRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )

    # Verify calendar exists
    calendar = session.get(CalendarSetting, body.calendar_id)
    if not calendar:
        raise HTTPException(status_code=404, detail="Calendar not found")

    # Geocode if needed
    lat, lng = suggestion.latitude, suggestion.longitude
    if not lat and not lng and suggestion.location:
        coords = geocode_location(suggestion.location)
        if coords:
            lat, lng = coords

    events = _upsert_occurrences_from_suggestion(
        session,
        suggestion,
        review_status="reviewed",
        calendar_id=body.calendar_id,
        latitude=lat,
        longitude=lng,
    )
    event_id = events[0].event_id

    # Create EventTags from suggested_tag_ids
    if suggestion.suggested_tag_ids:
        for event in events:
            _apply_suggestion_tags(
                session, event.event_id, suggestion.suggested_tag_ids
            )

    _link_occurrences_to_series(session, suggestion, events, admin.get("email"))

    # Approval expands the preview to the full horizon; the submitter's RSVP has
    # to cover the occurrences that only exist now. Already announced at submit,
    # so no fan-out here.
    _apply_creator_going(session, suggestion, events, fan_out=False)

    # Promote inline new-tag suggestions to TagSuggestion rows for admin review
    if suggestion.suggested_new_tags:
        for item in suggestion.suggested_new_tags:
            free_text = (item.get("free_text") or "").strip()
            if not free_text:
                continue
            session.add(
                TagSuggestion(
                    event_id=event_id,
                    free_text=free_text,
                    group_slug=item.get("group_slug"),
                    submitter_ip=suggestion.submitter_ip,
                    source="user",
                )
            )

    # Promote a submitted promo code into the moderated promo-codes queue.
    # Requires a signed-in submitter (EventPromoCode.submitter_user_id is
    # NOT NULL) — anonymous submissions cannot own a promo code entry.
    if suggestion.promo_code and suggestion.submitter_user_id is not None:
        code_norm = suggestion.promo_code.strip()
        if code_norm:
            existing_codes = session.exec(
                select(EventPromoCode)
                .where(EventPromoCode.event_id == event_id)
                .where(EventPromoCode.status != "rejected")
            ).all()
            if not any(row.code.lower() == code_norm.lower() for row in existing_codes):
                session.add(
                    EventPromoCode(
                        event_id=event_id,
                        code=code_norm,
                        description=suggestion.promo_description,
                        source_url=suggestion.promo_source_url,
                        submitter_user_id=suggestion.submitter_user_id,
                    )
                )

    # Update suggestion
    suggestion.status = "approved"
    suggestion.assigned_calendar_id = body.calendar_id
    suggestion.created_event_id = event_id
    suggestion.reviewed_at = datetime.utcnow()
    suggestion.reviewed_by = admin.get("email")
    session.add(suggestion)

    # Fan out the suggested-event notification to subscribers of the
    # submitter, and auto-save the new event to the submitter's Calendar
    # tab unless they opted out at submission time. This runs regardless
    # of whether a live "pending" event already existed (signed-in
    # submitters get one immediately at submission so they can preview
    # it) — subscribers should only be notified once the event is
    # actually approved. Idempotent: ``UniqueConstraint(device_id,
    # event_id)`` would block duplicate saves anyway; we pre-check for
    # clarity.
    if suggestion.submitter_user_id is not None:
        actor = session.get(User, suggestion.submitter_user_id)
        if actor is not None:
            fan_out_suggested(session, actor, event_id)
            if suggestion.auto_save:
                existing = session.exec(
                    select(UserSavedEvent).where(
                        UserSavedEvent.user_id == actor.id,
                        UserSavedEvent.event_id == event_id,
                    )
                ).first()
                if existing is None:
                    session.add(
                        UserSavedEvent(
                            device_id=str(actor.id),
                            event_id=event_id,
                            user_id=actor.id,
                            audience="public",
                        )
                    )

    session.commit()
    session.refresh(suggestion)
    # Instant "suggested events" email to the submitter's subscribers when
    # that feature is in instant mode (else the digest tick handles it).
    if suggestion.submitter_user_id is not None:
        actor = session.get(User, suggestion.submitter_user_id)
        if actor is not None:
            try:
                activity_instant.dispatch_activity_instant(
                    session,
                    kind="subscription_suggested",
                    actor=actor,
                    event_id=event_id,
                )
            except Exception:  # noqa: BLE001 — best-effort
                logger.warning("Instant suggested-event email failed", exc_info=True)
    return suggestion


@router.post(
    "/api/admin/suggestions/{suggestion_id}/reject",
    response_model=EventSuggestionResponse,
)
def reject_suggestion(
    suggestion_id: UUID,
    body: SuggestionRejectRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )

    suggestion.status = "rejected"
    suggestion.admin_notes = body.admin_notes or suggestion.admin_notes
    suggestion.reviewed_at = datetime.utcnow()
    suggestion.reviewed_by = admin.get("email")
    events = list(
        session.exec(
            select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
        ).all()
    )
    if not events and suggestion.created_event_id:
        legacy = session.get(CachedEvent, suggestion.created_event_id)
        if legacy is not None:
            events = [legacy]
    for event in events:
        event.is_hidden = True
        event.deleted_at = None
        session.add(event)
        if session.get(BlockedEvent, event.event_id) is None:
            session.add(BlockedEvent(event_id=event.event_id))
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return suggestion


@router.post(
    "/api/admin/suggestions/{suggestion_id}/sync-to-google",
    response_model=EventSuggestionResponse,
)
def sync_suggestion_to_google(
    suggestion_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "approved":
        raise HTTPException(
            status_code=400, detail="Only approved suggestions can be synced"
        )
    if suggestion.synced_to_google:
        raise HTTPException(status_code=400, detail="Already synced to Google Calendar")
    if not suggestion.assigned_calendar_id:
        raise HTTPException(status_code=400, detail="No calendar assigned")

    # Prefer the event's current calendar: an admin may have re-assigned it on
    # the event detail page after approval, and that reassignment updates the
    # CachedEvent, not the suggestion's approval-time assigned_calendar_id.
    target_calendar_id = suggestion.assigned_calendar_id
    if suggestion.created_event_id:
        cached_event = session.get(CachedEvent, suggestion.created_event_id)
        if cached_event and cached_event.calendar_id:
            target_calendar_id = cached_event.calendar_id

    calendar_service = request.app.state.calendar_service
    try:
        google_event_id = calendar_service.create_event(
            calendar_id=target_calendar_id,
            title=suggestion.title,
            description=suggestion.description,
            location=suggestion.location,
            start=suggestion.start,
            end=suggestion.end,
            all_day=suggestion.all_day,
        )
    except Exception as exc:
        message = str(exc)
        if "requiredAccessLevel" in message or "writer access" in message.lower():
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Cannot sync to calendar '{target_calendar_id}': the app only "
                    "has read access. Re-assign this event to a calendar the app "
                    "can write to, then try again."
                ),
            ) from exc
        logger.exception("Failed to sync suggestion to Google Calendar")
        raise HTTPException(
            status_code=502, detail=f"Google Calendar error: {exc}"
        ) from exc

    suggestion.synced_to_google = True
    suggestion.google_event_id = google_event_id
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return suggestion
