import logging
from datetime import datetime
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
    SuggestionRejectRequest,
    SuggestionUpdateRequest,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    CachedEvent,
    CalendarSetting,
    EventSuggestion,
    EventTag,
    Tag,
    TagSuggestion,
)
from backend.services.email import send_suggestion_notification
from backend.services.geocoding import geocode_location
from backend.services.ip_geolocation import geolocate_ip
from backend.services.notifications import fan_out_suggested

logger = logging.getLogger(__name__)

router = APIRouter(tags=["suggestions"])

limiter = Limiter(key_func=client_ip)


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
        price_min=body.price_min,
        price_max=body.price_max,
        price_currency=body.price_currency,
        price_is_free=body.price_is_free,
        auto_save=body.auto_save,
    )

    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

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

    geocoder = Nominatim(user_agent="movida", timeout=5)
    try:
        results = geocoder.geocode(q, exactly_one=False, limit=5)
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        logger.warning("Geocode search failed: %s", e)
        return []
    except Exception:
        logger.exception("Unexpected geocode search error")
        return []

    if not results:
        return []

    return [
        GeocodeSuggestion(
            display_name=r.address,
            latitude=r.latitude,
            longitude=r.longitude,
        )
        for r in results
    ]


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

    # Create CachedEvent
    import uuid

    event_id = f"suggestion-{suggestion.id}"
    cached_event = CachedEvent(
        event_id=event_id,
        calendar_id=body.calendar_id,
        title=suggestion.title,
        description=suggestion.description,
        location=suggestion.location,
        start=suggestion.start,
        end=suggestion.end,
        all_day=suggestion.all_day,
        latitude=lat,
        longitude=lng,
        links=suggestion.links,
        price_min=suggestion.price_min,
        price_max=suggestion.price_max,
        price_currency=suggestion.price_currency,
        price_is_free=suggestion.price_is_free,
        review_status="reviewed",
    )
    session.add(cached_event)

    # Create EventTags from suggested_tag_ids
    if suggestion.suggested_tag_ids:
        for tid in suggestion.suggested_tag_ids:
            tag = session.get(Tag, tid)
            if tag:
                session.add(EventTag(event_id=event_id, tag_id=tid))

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

    # Update suggestion
    suggestion.status = "approved"
    suggestion.assigned_calendar_id = body.calendar_id
    suggestion.created_event_id = event_id
    suggestion.reviewed_at = datetime.utcnow()
    suggestion.reviewed_by = admin.get("email")
    session.add(suggestion)

    # Phase C: fan out subscription_suggested notifications when the
    # suggestion was submitted by an authenticated user.
    if suggestion.submitter_user_id is not None:
        actor = session.get(User, suggestion.submitter_user_id)
        if actor is not None:
            fan_out_suggested(session, actor, event_id)
            # Auto-save the new event to the submitter's Calendar tab
            # unless they opted out at submission time. Idempotent:
            # ``UniqueConstraint(device_id, event_id)`` would block
            # duplicates anyway; we pre-check for clarity.
            if suggestion.auto_save:
                from backend.db.models import UserSavedEvent

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

    calendar_service = request.app.state.calendar_service
    try:
        google_event_id = calendar_service.create_event(
            calendar_id=suggestion.assigned_calendar_id,
            title=suggestion.title,
            description=suggestion.description,
            location=suggestion.location,
            start=suggestion.start,
            end=suggestion.end,
            all_day=suggestion.all_day,
        )
    except Exception as exc:
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
