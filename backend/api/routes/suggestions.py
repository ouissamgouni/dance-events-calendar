import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.encoders import jsonable_encoder
from slowapi import Limiter
from backend.api.rate_limit import client_ip
from sqlmodel import Session, col, select

from backend.api.deps import (
    require_admin,
    require_user,
)
from backend.db.models import User
from backend.api.schemas import (
    EventImageFromUrlRequest,
    EventSuggestionCreate,
    EventSuggestionPublicResponse,
    EventSuggestionResponse,
    GeocodeSuggestion,
    OwnSuggestionResponse,
    OwnSuggestionUpdate,
    SimilarEventResponse,
    SuggestionApproveRequest,
    SuggestionAuditEntry,
    SuggestionImageResponse,
    SuggestionOccurrence,
    SuggestionOccurrencesResponse,
    SuggestionRejectRequest,
    SuggestionUpdateRequest,
)
from backend.config.loader import get_admin_email
from backend.db.database import get_session
from backend.db.models import (
    EventRevision,
    BlockedEvent,
    CachedEvent,
    CalendarSetting,
    EventPromoCode,
    EventSeries,
    EventSeriesMember,
    EventSuggestion,
    EventTag,
    Notification,
    SuggestionAuditLog,
    Tag,
    UserEventAttendance,
    UserSavedEvent,
)
from backend.services.email import (
    send_suggestion_decision_email,
    send_suggestion_notification,
)
from backend.services import event_images, job_queue
from backend.services.duplicate_detection import find_candidate_matches
from backend.services.event_visibility import (
    REASON_ADMIN,
    REASON_OWNER,
    REASON_SERIES_EDIT,
    STATUS_REMOVED,
    eligible_event_ids,
    set_event_status,
)
from backend.services.image_processing import ImageValidationError
from backend.services.geocoding import geocode_location
from backend.services.reach import sync_event_reach
from backend.services.recurrence import expand_occurrences, normalize_all_day
from backend.services.timezones import resolve_event_timezone, valid_timezone
from backend.services import event_revisions
from backend.services.notifications import (
    SUGGESTION_APPROVED,
    SUGGESTION_CHANGE_APPLIED,
    SUGGESTION_CHANGE_DISCARDED,
    SUGGESTION_DECLINED,
    SUGGESTION_REJECTED,
    fan_out_going,
    fan_out_suggested,
    notify_submitter,
)

logger = logging.getLogger(__name__)

SUGGESTION_DECISION_JOB = "suggestion_decision_email"

router = APIRouter(tags=["suggestions"])

limiter = Limiter(key_func=client_ip)

USER_SUBMISSION_CALENDAR_ID = "user-submissions"

# A pending suggestion is already publicly visible, so the submitter should be
# able to see the shape of their series straight away. Fanning out all 52
# occurrences would put that many unreviewed rows into the listings, so submit
# materialises a bounded preview and approval expands the rest.
PREVIEW_OCCURRENCE_LIMIT = 10
PREVIEW_HORIZON_DAYS = 90

# Per-user caps: events kept for themselves, and open requests to go public.
MAX_OWN_UPCOMING_EVENTS = 20
MAX_PENDING_PUBLIC_REQUESTS = 5

OWNER_ACTIVE_STATUSES = ("private", "pending", "declined")
OWNER_EDITABLE_STATUSES = (*OWNER_ACTIVE_STATUSES, "approved")


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
    review_status: str | None,
    visibility: str,
    calendar_id: str,
    latitude: float | None,
    longitude: float | None,
    limit: int | None = None,
    horizon_end: datetime | None = None,
    freeze_before: datetime | None = None,
) -> list[CachedEvent]:
    """Materialise one CachedEvent per recurrence occurrence.

    Existing rows are matched by ``occurrence_key`` first, then leftover rows
    are paired with leftover dates in order, so an edited schedule moves rows
    (and their RSVPs, ratings, pictures) rather than replacing them. Rows that
    start before ``freeze_before`` are never moved, rewritten or hidden.
    ``review_status=None`` keeps each row's status (new rows are reviewed).
    """
    occurrences = expand_occurrences(
        suggestion.start,
        suggestion.end,
        suggestion.recurrence_rule,
        suggestion.recurrence_dates,
        limit=limit,
        horizon_end=horizon_end,
        timezone_name=None if suggestion.all_day else suggestion.timezone,
    )

    existing = list(
        session.exec(
            select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
        ).all()
    )
    if suggestion.created_event_id and all(
        row.event_id != suggestion.created_event_id for row in existing
    ):
        legacy = session.get(CachedEvent, suggestion.created_event_id)
        if legacy is not None:
            existing.append(legacy)

    def is_frozen(moment: datetime) -> bool:
        return freeze_before is not None and _as_utc(moment) < freeze_before

    by_key = {_as_utc(row.occurrence_key or row.start): row for row in existing}
    claimed: set[str] = set()
    matched: list[CachedEvent | None] = []
    for start, _ in occurrences:
        row = by_key.get(start)
        if row is not None:
            claimed.add(row.event_id)
        matched.append(row)

    spare = sorted(
        (
            row
            for row in existing
            if row.event_id not in claimed
            and not row.is_hidden
            and not is_frozen(row.start)
        ),
        key=lambda row: _as_utc(row.start),
    )
    for index, (start, _) in enumerate(occurrences):
        if matched[index] is None and spare and not is_frozen(start):
            row = spare.pop(0)
            claimed.add(row.event_id)
            matched[index] = row

    used_ids = {row.event_id for row in existing}
    prefix = f"suggestion-{suggestion.id}-"
    next_suffix = 1 + max(
        (
            int(event_id[len(prefix) :])
            for event_id in used_ids
            if event_id.startswith(prefix) and event_id[len(prefix) :].isdigit()
        ),
        default=len(occurrences) - 1,
    )

    events: list[CachedEvent] = []
    for index, (start, end) in enumerate(occurrences):
        cached_event = matched[index]
        if cached_event is not None and is_frozen(cached_event.start):
            events.append(cached_event)
            continue
        if cached_event is None and existing and is_frozen(start):
            continue
        if cached_event is None:
            event_id = _occurrence_event_id(suggestion, index)
            if event_id in used_ids or session.get(CachedEvent, event_id):
                event_id = f"{prefix}{next_suffix}"
                next_suffix += 1
            used_ids.add(event_id)
            cached_event = CachedEvent(
                event_id=event_id,
                calendar_id=calendar_id,
                title=suggestion.title,
                description=suggestion.description,
                location=suggestion.location,
                start=start,
                end=end,
                all_day=suggestion.all_day,
                timezone=suggestion.timezone,
                latitude=latitude,
                longitude=longitude,
                links=suggestion.links,
                price_min=suggestion.price_min,
                price_max=suggestion.price_max,
                price_currency=suggestion.price_currency,
                price_is_free=suggestion.price_is_free,
                review_status=review_status or "reviewed",
            )
            # Pictures wait for a curator, so only public rows carry one.
            if review_status == "reviewed" and visibility == "public":
                cached_event.image_key = suggestion.image_key
        else:
            cached_event.calendar_id = calendar_id
            cached_event.title = suggestion.title
            cached_event.description = suggestion.description
            cached_event.location = suggestion.location
            cached_event.start = start
            cached_event.end = end
            cached_event.all_day = suggestion.all_day
            cached_event.timezone = suggestion.timezone
            cached_event.latitude = latitude
            cached_event.longitude = longitude
            cached_event.links = suggestion.links
            cached_event.price_min = suggestion.price_min
            cached_event.price_max = suggestion.price_max
            cached_event.price_currency = suggestion.price_currency
            cached_event.price_is_free = suggestion.price_is_free
            if review_status is not None:
                cached_event.review_status = review_status
            cached_event.is_hidden = False
            cached_event.deleted_at = None
        cached_event.occurrence_key = start
        cached_event.suggestion_id = suggestion.id
        cached_event.visibility = visibility
        cached_event.owner_user_id = suggestion.submitter_user_id
        session.add(cached_event)
        events.append(cached_event)

    kept_ids = {e.event_id for e in events}
    if events and suggestion.created_event_id not in kept_ids:
        suggestion.created_event_id = events[0].event_id
    _hide_orphaned_occurrences(session, suggestion, kept_ids, freeze_before)
    return events


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _set_events_review_status(
    session: Session, suggestion: EventSuggestion, review_status: str
) -> None:
    for event in session.exec(
        select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
    ).all():
        event.review_status = review_status
        session.add(event)


def _hide_orphaned_occurrences(
    session: Session,
    suggestion: EventSuggestion,
    keep_event_ids: set[str],
    freeze_before: datetime | None = None,
) -> None:
    """Hide rows left behind when an edit shrinks the occurrence set."""
    existing = session.exec(
        select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
    ).all()
    for event in existing:
        if freeze_before is not None and _as_utc(event.start) < freeze_before:
            continue
        if event.event_id not in keep_event_ids and not event.is_hidden:
            set_event_status(event, STATUS_REMOVED, REASON_SERIES_EDIT)
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
            resolved_at=datetime.now(timezone.utc),
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


def _attribute_to_organizer_submitter(
    session: Session, suggestion: EventSuggestion, events: list[CachedEvent]
) -> None:
    """Public occurrences of an organizer's own submission show them as organizer."""
    if not suggestion.submitter_is_organizer or suggestion.submitter_user_id is None:
        return
    organizer = session.get(User, suggestion.submitter_user_id)
    if organizer is None or not organizer.is_verified_organizer:
        return
    for event in events:
        if event.organizer_user_id is None and event.visibility == "public":
            event.organizer_user_id = organizer.id
            session.add(event)


# --- Background tasks ---


def _notify_admin(suggestion):
    """Background task: send email notification."""
    admin_email = get_admin_email()
    if admin_email:
        send_suggestion_notification(suggestion, admin_email)


def _count_owned(session: Session, user_id: UUID, statuses: tuple[str, ...]) -> int:
    now = datetime.now(timezone.utc)
    return sum(
        1
        for suggestion in session.exec(
            select(EventSuggestion).where(
                EventSuggestion.submitter_user_id == user_id,
                col(EventSuggestion.status).in_(statuses),
            )
        ).all()
        if suggestion.recurrence_rule
        or suggestion.recurrence_dates
        or _as_utc(suggestion.end) >= now
    )


def _guard_public_request(
    session: Session, user_id: UUID, end: datetime, recurring: bool
):
    if not recurring and _as_utc(end) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=422,
            detail="Past events can only be kept for yourself",
        )
    if _count_owned(session, user_id, ("pending",)) >= MAX_PENDING_PUBLIC_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=f"You can have at most {MAX_PENDING_PUBLIC_REQUESTS} events waiting to go public",
        )


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
    current_user: User = Depends(require_user),
):
    """Add an event: kept for its owner, or sent to curators to go public."""
    # Honeypot check — silent reject
    if body.website:
        return EventSuggestionPublicResponse(
            id="00000000-0000-0000-0000-000000000000",
            message="Thank you! Your suggestion is under review.",
        )

    if body.image_key and (
        not body.image_key.startswith(
            event_images.suggestion_image_prefix(current_user.id)
        )
        or not event_images.suggestion_image_exists(body.image_key)
    ):
        raise HTTPException(status_code=400, detail="Image is not valid")
    try:
        tag_ids = event_revisions.validate_tag_ids(session, body.suggested_tag_ids)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    start, end = (
        normalize_all_day(body.start, body.end)
        if body.all_day
        else (body.start, body.end)
    )
    share_publicly = body.share_publicly
    recurring = bool(body.recurrence_rule or body.recurrence_dates)
    if share_publicly:
        _guard_public_request(session, current_user.id, end, recurring)
    if (recurring or _as_utc(end) >= datetime.now(timezone.utc)) and _count_owned(
        session, current_user.id, OWNER_ACTIVE_STATUSES
    ) >= MAX_OWN_UPCOMING_EVENTS:
        raise HTTPException(
            status_code=429,
            detail=f"You can have at most {MAX_OWN_UPCOMING_EVENTS} upcoming events of your own",
        )
    suggestion = EventSuggestion(
        status="pending" if share_publicly else "private",
        title=body.title,
        description=body.description,
        location=body.location,
        links=[link.model_dump() for link in body.links] if body.links else None,
        latitude=body.latitude,
        longitude=body.longitude,
        start=start,
        end=end,
        all_day=body.all_day,
        timezone=resolve_event_timezone(
            explicit=body.event_timezone,
            latitude=body.latitude,
            longitude=body.longitude,
            submitter=body.timezone,
        ),
        recurrence_rule=body.recurrence_rule,
        recurrence_dates=[
            item.model_dump(mode="json") for item in body.recurrence_dates
        ]
        if body.recurrence_dates
        else None,
        submitter_name=body.submitter_name,
        submitter_email=body.submitter_email,
        submitter_user_id=current_user.id,
        submitter_timezone=body.timezone,
        suggested_tag_ids=tag_ids or None,
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
        creator_going=bool(body.going),
        creator_going_audience=body.going_audience if body.going else None,
        submitter_is_organizer=bool(
            body.is_organizer and current_user.is_verified_organizer
        ),
        image_key=body.image_key,
    )

    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    _ensure_user_submission_calendar(session)
    # Materialise a bounded preview of the recurrence so the owner sees every
    # upcoming date rather than just the first one. Approval expands the series
    # to the full horizon.
    cached_events = _upsert_occurrences_from_suggestion(
        session,
        suggestion,
        review_status="reviewed",
        visibility="private",
        calendar_id=USER_SUBMISSION_CALENDAR_ID,
        latitude=body.latitude,
        longitude=body.longitude,
        limit=PREVIEW_OCCURRENCE_LIMIT,
        horizon_end=datetime.now(timezone.utc) + timedelta(days=PREVIEW_HORIZON_DAYS),
    )
    for occurrence in cached_events:
        _apply_suggestion_tags(
            session, occurrence.event_id, suggestion.suggested_tag_ids or []
        )
    # Group the preview occurrences so the listings collapse them into one
    # series instead of showing the same event ten times.
    _link_occurrences_to_series(session, suggestion, cached_events, None)
    # Only the owner can see the preview, so followers hear about the Going
    # once the event is approved, not now.
    _apply_creator_going(session, suggestion, cached_events, fan_out=False)
    if cached_events and suggestion.suggested_new_tags:
        event_revisions.request_new_tags(
            session,
            cached_events[0].event_id,
            suggestion.suggested_new_tags,
            current_user.id,
        )
        suggestion.suggested_new_tags = None
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)

    # Fire background tasks
    if share_publicly:
        background_tasks.add_task(_notify_admin, suggestion)

    return EventSuggestionPublicResponse(
        id=suggestion.id,
        message="Thank you! Your suggestion is under review."
        if share_publicly
        else "Added to your events.",
    )


def _suggestion_image_response(key: str) -> SuggestionImageResponse:
    thumb_url, _ = event_images.image_urls(key)
    return SuggestionImageResponse(image_key=key, image_thumb_url=thumb_url)


@router.post("/api/suggestions/images", response_model=SuggestionImageResponse)
@limiter.limit("20/hour")
async def upload_suggestion_image(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(require_user),
):
    """Stage a picture for a suggestion the user is about to submit."""
    try:
        key = event_images.store_suggestion_image(
            user.id, await file.read(), file.content_type
        )
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _suggestion_image_response(key)


@router.post("/api/suggestions/images/from-url", response_model=SuggestionImageResponse)
@limiter.limit("20/hour")
def import_suggestion_image(
    request: Request,
    body: EventImageFromUrlRequest,
    user: User = Depends(require_user),
):
    """Stage a picture fetched from a public https URL."""
    try:
        data, content_type = event_images.fetch_remote_image(str(body.url))
        key = event_images.store_suggestion_image(user.id, data, content_type)
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _suggestion_image_response(key)


@router.get("/api/suggestions/similar", response_model=list[SimilarEventResponse])
@limiter.limit("30/minute")
def similar_events(
    request: Request,
    title: str = Query(..., min_length=3, max_length=200),
    start: datetime = Query(...),
    end: datetime | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """Public events that look like the one being added, so it isn't added twice."""
    probe = CachedEvent(
        event_id="__similar_probe__",
        calendar_id="",
        title=title,
        start=start,
        end=end or start,
    )
    matches = find_candidate_matches(session, probe)
    visible = eligible_event_ids(session, [m.event_id for m in matches])
    return [
        SimilarEventResponse(
            event_id=m.event_id,
            title=m.title,
            start=m.start,
            end=m.end,
            all_day=m.all_day,
            location=m.location,
        )
        for m in sorted(matches, key=lambda m: _as_utc(m.start))
        if m.event_id in visible
    ][:5]


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


# --- Submitter endpoints ---


def _audit_value(value):
    if isinstance(value, datetime):
        return _as_utc(value).isoformat()
    return jsonable_encoder(value)


def _diff_suggestion(suggestion: EventSuggestion, update_data: dict) -> dict:
    changes = {}
    for field, value in update_data.items():
        old = _audit_value(getattr(suggestion, field))
        new = _audit_value(value)
        if old != new:
            changes[field] = [old, new]
    return changes


def _record_audit(
    session: Session,
    suggestion: EventSuggestion,
    action: str,
    changes: dict | None = None,
    *,
    actor_user_id: UUID | None = None,
    admin_email: str | None = None,
) -> None:
    session.add(
        SuggestionAuditLog(
            suggestion_id=suggestion.id,
            actor_user_id=actor_user_id,
            actor_admin_email=admin_email,
            action=action,
            changes=changes,
        )
    )


def _get_owned_suggestion(
    session: Session, suggestion_id: UUID, user: User
) -> EventSuggestion:
    suggestion = session.get(EventSuggestion, suggestion_id)
    # 404 rather than 403 so other users can't probe which ids exist.
    if suggestion is None or suggestion.submitter_user_id != user.id:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return suggestion


def _owner_can_edit(suggestion: EventSuggestion) -> bool:
    # Approved suggestions are editable too, but those edits wait for review.
    return suggestion.status in OWNER_EDITABLE_STATUSES and not suggestion.edit_locked


def _pending_submitter_revision(
    session: Session, suggestion: EventSuggestion
) -> EventRevision | None:
    return session.exec(
        select(EventRevision)
        .where(EventRevision.suggestion_id == suggestion.id)
        .where(EventRevision.source == event_revisions.SOURCE_SUBMITTER)
        .where(col(EventRevision.kind).in_(event_revisions.EDIT_KINDS))
        .where(EventRevision.status == event_revisions.STATUS_PENDING)
    ).first()


def _revision_values(revision: EventRevision) -> dict:
    values = {}
    for field, change in revision.changes.items():
        value = change["new"]
        if field in ("start", "end") and isinstance(value, str):
            value = datetime.fromisoformat(value)
        values[field] = value
    return values


def _own_response(
    suggestion: EventSuggestion, session: Session | None = None
) -> OwnSuggestionResponse:
    pending = (
        _pending_submitter_revision(session, suggestion)
        if session is not None and suggestion.status == "approved"
        else None
    )
    return OwnSuggestionResponse.model_validate(
        {
            **suggestion.model_dump(),
            "can_edit": _owner_can_edit(suggestion),
            "rejection_reason": suggestion.admin_notes
            if suggestion.status in ("declined", "blocked")
            else None,
            "pending_changes": pending.changes if pending else None,
        }
    )


@router.get("/api/me/suggestions", response_model=list[OwnSuggestionResponse])
def list_own_suggestions(
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Everything the viewer submitted, newest first (My submissions)."""
    suggestions = session.exec(
        select(EventSuggestion)
        .where(EventSuggestion.submitter_user_id == user.id)
        .order_by(col(EventSuggestion.created_at).desc())
    ).all()
    return [_own_response(suggestion, session) for suggestion in suggestions]


@router.get(
    "/api/me/suggestions/for-event/{event_id}",
    response_model=OwnSuggestionResponse | None,
)
def get_own_suggestion_for_event(
    event_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """The viewer's own suggestion behind ``event_id``, or null."""
    event = session.get(CachedEvent, event_id)
    if event is None or event.suggestion_id is None:
        return None
    suggestion = session.get(EventSuggestion, event.suggestion_id)
    if suggestion is None or suggestion.submitter_user_id != user.id:
        return None
    return _own_response(suggestion, session)


@router.get("/api/me/suggestions/{suggestion_id}", response_model=OwnSuggestionResponse)
def get_own_suggestion(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    return _own_response(_get_owned_suggestion(session, suggestion_id, user), session)


@router.patch(
    "/api/me/suggestions/{suggestion_id}", response_model=OwnSuggestionResponse
)
@limiter.limit("30/hour")
def update_own_suggestion(
    suggestion_id: UUID,
    body: OwnSuggestionUpdate,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Submitter edit of their suggestion.

    Awaiting review: applied straight away. Approved: becomes a pending
    revision; the live event is unchanged until an admin applies it.
    """
    suggestion = _get_owned_suggestion(session, suggestion_id, user)
    if suggestion.edit_locked:
        raise HTTPException(
            status_code=409, detail="This event has been locked by an admin"
        )
    if suggestion.status not in OWNER_EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409, detail="This event can no longer be edited"
        )

    update_data = body.model_dump(exclude_unset=True)
    for required in ("title", "start", "end", "all_day"):
        if required in update_data and update_data[required] is None:
            raise HTTPException(status_code=422, detail=f"{required} is required")
    if "event_timezone" in update_data:
        update_data["timezone"] = (
            valid_timezone(update_data.pop("event_timezone")) or suggestion.timezone
        )
    if body.recurrence_dates:
        update_data["recurrence_dates"] = [
            item.model_dump(mode="json") for item in body.recurrence_dates
        ]
        update_data["recurrence_rule"] = None
    elif body.recurrence_rule:
        update_data["recurrence_dates"] = None
    if "suggested_tag_ids" in update_data:
        try:
            update_data["suggested_tag_ids"] = (
                event_revisions.validate_tag_ids(
                    session,
                    update_data["suggested_tag_ids"] or [],
                    suggestion.suggested_tag_ids or [],
                )
                or None
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    new_tags = update_data.pop("suggested_new_tags", None) or []

    def request_new_tags() -> None:
        if new_tags and suggestion.created_event_id:
            event_revisions.request_new_tags(
                session, suggestion.created_event_id, new_tags, user.id
            )

    new_image = update_data.get("image_key")
    if (
        new_image
        and new_image != suggestion.image_key
        and (
            not new_image.startswith(event_images.suggestion_image_prefix(user.id))
            or not event_images.suggestion_image_exists(new_image)
        )
    ):
        raise HTTPException(status_code=400, detail="Image is not valid")
    existing_revision = (
        _pending_submitter_revision(session, suggestion)
        if suggestion.status == "approved"
        else None
    )
    if existing_revision is not None:
        # A second edit builds on the change already awaiting review.
        update_data = {**_revision_values(existing_revision), **update_data}
    new_start = update_data.get("start", suggestion.start)
    new_end = update_data.get("end", suggestion.end)
    if (
        update_data.get("all_day", suggestion.all_day)
        and {
            "start",
            "end",
            "all_day",
        }
        & update_data.keys()
    ):
        new_start, new_end = normalize_all_day(new_start, new_end)
        update_data["start"], update_data["end"] = new_start, new_end
    if _as_utc(new_end) <= _as_utc(new_start):
        raise HTTPException(status_code=422, detail="End must be after start")

    changes = _diff_suggestion(suggestion, update_data)
    if suggestion.status == "approved":
        _propose_submitter_revision(
            session, suggestion, changes, user, existing_revision
        )
        request_new_tags()
        session.commit()
        session.refresh(suggestion)
        return _own_response(suggestion, session)
    if not changes:
        if new_tags:
            request_new_tags()
            session.commit()
        return _own_response(suggestion, session)

    old_tag_ids = set(suggestion.suggested_tag_ids or [])
    for field, value in update_data.items():
        setattr(suggestion, field, value)

    _ensure_user_submission_calendar(session)
    now = datetime.now(timezone.utc)
    events = _upsert_occurrences_from_suggestion(
        session,
        suggestion,
        review_status=None,
        visibility="private",
        calendar_id=USER_SUBMISSION_CALENDAR_ID,
        latitude=suggestion.latitude,
        longitude=suggestion.longitude,
        limit=PREVIEW_OCCURRENCE_LIMIT,
        horizon_end=now + timedelta(days=PREVIEW_HORIZON_DAYS),
        freeze_before=now,
    )
    new_tag_ids = suggestion.suggested_tag_ids or []
    removed_tag_ids = old_tag_ids - set(new_tag_ids)
    if removed_tag_ids and events:
        for row in session.exec(
            select(EventTag).where(
                col(EventTag.event_id).in_([e.event_id for e in events]),
                col(EventTag.tag_id).in_(removed_tag_ids),
            )
        ).all():
            session.delete(row)
    for event in events:
        _apply_suggestion_tags(session, event.event_id, new_tag_ids)
    _link_occurrences_to_series(session, suggestion, events, None)
    _apply_creator_going(session, suggestion, events, fan_out=False)
    _record_audit(session, suggestion, "owner_edit", changes, actor_user_id=user.id)
    request_new_tags()

    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return _own_response(suggestion, session)


@router.post(
    "/api/me/suggestions/{suggestion_id}/withdraw",
    response_model=OwnSuggestionResponse,
)
def withdraw_own_suggestion(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Cancel a request to go public; the event stays the owner's."""
    suggestion = _get_owned_suggestion(session, suggestion_id, user)
    if suggestion.edit_locked:
        raise HTTPException(
            status_code=409, detail="This event has been locked by an admin"
        )
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=409, detail="Only events awaiting review can be withdrawn"
        )

    suggestion.status = "private"
    _record_audit(session, suggestion, "withdraw", actor_user_id=user.id)
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return _own_response(suggestion, session)


@router.post(
    "/api/me/suggestions/{suggestion_id}/request-public",
    response_model=OwnSuggestionResponse,
)
def request_public(
    suggestion_id: UUID,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Ask curators to make an event the owner kept for themselves public."""
    suggestion = _get_owned_suggestion(session, suggestion_id, user)
    if suggestion.edit_locked:
        raise HTTPException(
            status_code=409, detail="This event has been locked by an admin"
        )
    if suggestion.status not in ("private", "declined"):
        raise HTTPException(
            status_code=409, detail="Only private events can be shared publicly"
        )
    _guard_public_request(
        session,
        user.id,
        suggestion.end,
        bool(suggestion.recurrence_rule or suggestion.recurrence_dates),
    )
    suggestion.status = "pending"
    _record_audit(session, suggestion, "request_public", actor_user_id=user.id)
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    background_tasks.add_task(_notify_admin, suggestion)
    return _own_response(suggestion, session)


@router.delete(
    "/api/me/suggestions/{suggestion_id}",
    response_model=OwnSuggestionResponse,
)
def delete_own_suggestion(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Remove an event that is not public; its dates are hidden."""
    suggestion = _get_owned_suggestion(session, suggestion_id, user)
    if suggestion.edit_locked:
        raise HTTPException(
            status_code=409, detail="This event has been locked by an admin"
        )
    if suggestion.status not in OWNER_ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="Public events can't be deleted")

    suggestion.status = "withdrawn"
    for event in session.exec(
        select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
    ).all():
        set_event_status(event, STATUS_REMOVED, REASON_OWNER)
        session.add(event)
    _record_audit(session, suggestion, "delete", actor_user_id=user.id)
    session.add(suggestion)
    session.commit()
    session.refresh(suggestion)
    return _own_response(suggestion, session)


@router.post(
    "/api/me/suggestions/{suggestion_id}/changes/withdraw",
    response_model=OwnSuggestionResponse,
)
def withdraw_own_suggestion_changes(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    user: User = Depends(require_user),
):
    """Drop the submitter's edit of an approved event before it is reviewed."""
    suggestion = _get_owned_suggestion(session, suggestion_id, user)
    revision = _pending_submitter_revision(session, suggestion)
    if revision is None:
        raise HTTPException(status_code=404, detail="No changes awaiting review")
    revision.status = event_revisions.STATUS_SUPERSEDED
    revision.updated_at = datetime.now(timezone.utc)
    session.add(revision)
    _record_audit(session, suggestion, "change_withdrawn", actor_user_id=user.id)
    session.commit()
    session.refresh(suggestion)
    return _own_response(suggestion, session)


def _propose_submitter_revision(
    session: Session,
    suggestion: EventSuggestion,
    changes: dict,
    user: User,
    existing: EventRevision | None,
) -> EventRevision | None:
    revision_changes = {
        field: {"old": old, "new": new} for field, (old, new) in changes.items()
    }
    now = datetime.now(timezone.utc)
    if not revision_changes:
        # Edited back to what is live: nothing left to review.
        if existing is not None:
            existing.status = event_revisions.STATUS_SUPERSEDED
            existing.updated_at = now
            session.add(existing)
        return None
    if existing is None:
        existing = EventRevision(
            suggestion_id=suggestion.id,
            source=event_revisions.SOURCE_SUBMITTER,
            status=event_revisions.STATUS_PENDING,
            changes=revision_changes,
            proposed_by_user_id=user.id,
        )
    else:
        existing.changes = revision_changes
        existing.updated_at = now
    session.add(existing)
    _record_audit(
        session, suggestion, "change_proposed", changes, actor_user_id=user.id
    )
    return existing


def apply_submitter_revision(
    session: Session,
    revision: EventRevision,
    admin_email: str | None,
    notify: bool | None,
) -> None:
    """Publish a submitter's edit across every occurrence of the series."""
    suggestion = session.get(EventSuggestion, revision.suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    update = _revision_values(revision)
    old_tag_ids = set(suggestion.suggested_tag_ids or [])
    for field, value in update.items():
        setattr(suggestion, field, value)

    calendar_id = suggestion.assigned_calendar_id
    if calendar_id is None and suggestion.created_event_id:
        live = session.get(CachedEvent, suggestion.created_event_id)
        calendar_id = live.calendar_id if live else None
    events = _upsert_occurrences_from_suggestion(
        session,
        suggestion,
        review_status="reviewed",
        visibility="public",
        calendar_id=calendar_id or USER_SUBMISSION_CALENDAR_ID,
        latitude=suggestion.latitude,
        longitude=suggestion.longitude,
        freeze_before=datetime.now(timezone.utc),
    )
    if "image_key" in update:
        for event in events:
            event.image_key = suggestion.image_key
            session.add(event)
    new_tag_ids = suggestion.suggested_tag_ids or []
    removed_tag_ids = old_tag_ids - set(new_tag_ids)
    if removed_tag_ids and events:
        for row in session.exec(
            select(EventTag).where(
                col(EventTag.event_id).in_([e.event_id for e in events]),
                col(EventTag.tag_id).in_(removed_tag_ids),
            )
        ).all():
            session.delete(row)
    for event in events:
        _apply_suggestion_tags(session, event.event_id, new_tag_ids)
    _link_occurrences_to_series(session, suggestion, events, admin_email)
    _apply_creator_going(session, suggestion, events, fan_out=False)
    _record_audit(
        session,
        suggestion,
        "change_applied",
        {field: [c["old"], c["new"]] for field, c in revision.changes.items()},
        admin_email=admin_email,
    )
    event_revisions.mark_decided(revision, event_revisions.STATUS_ACCEPTED, admin_email)
    session.add(revision)
    session.add(suggestion)
    session.flush()

    actor = event_revisions.admin_actor(session, admin_email)
    notifications = []
    if events and event_revisions.resolve_notify(notify, revision.changes):
        notifications = event_revisions.notify_event_changed(
            session,
            revision,
            [e.event_id for e in events],
            actor,
            title=suggestion.title,
            exclude_user_ids=frozenset({suggestion.submitter_user_id}),
        )
    submitter = (
        session.get(User, suggestion.submitter_user_id)
        if suggestion.submitter_user_id
        else None
    )
    if submitter is not None:
        notify_submitter(
            session,
            submitter,
            SUGGESTION_CHANGE_APPLIED,
            subject_key=f"revision:{revision.id}",
            actor=actor,
            event_id=suggestion.created_event_id,
            context=suggestion.title,
        )
    session.commit()
    if notifications:
        event_revisions.enqueue_change_emails(revision)


def discard_submitter_revision(
    session: Session, revision: EventRevision, admin_email: str | None
) -> None:
    suggestion = session.get(EventSuggestion, revision.suggestion_id)
    event_revisions.mark_decided(revision, event_revisions.STATUS_REJECTED, admin_email)
    session.add(revision)
    if suggestion is not None:
        _record_audit(session, suggestion, "change_discarded", admin_email=admin_email)
        submitter = (
            session.get(User, suggestion.submitter_user_id)
            if suggestion.submitter_user_id
            else None
        )
        if submitter is not None:
            notify_submitter(
                session,
                submitter,
                SUGGESTION_CHANGE_DISCARDED,
                subject_key=f"revision:{revision.id}",
                actor=event_revisions.admin_actor(session, admin_email),
                event_id=suggestion.created_event_id,
                context=suggestion.title,
            )
    session.commit()


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
    unreviewed = set(
        session.exec(
            select(CachedEvent.suggestion_id)
            .where(
                col(CachedEvent.suggestion_id).is_not(None),
                CachedEvent.review_status == "pending",
                CachedEvent.is_hidden == False,  # noqa: E712
            )
            .distinct()
        ).all()
    )
    return [
        EventSuggestionResponse.model_validate(s, from_attributes=True).model_copy(
            update={
                "needs_review": s.status not in ("blocked", "withdrawn")
                and s.id in unreviewed
            }
        )
        for s in suggestions
    ]


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
    return _suggestion_occurrences(session, suggestion)


@router.get(
    "/api/admin/suggestions/{suggestion_id}/audit",
    response_model=list[SuggestionAuditEntry],
)
def get_suggestion_audit(
    suggestion_id: UUID,
    session: Session = Depends(get_session),
    _admin: dict = Depends(require_admin),
):
    return session.exec(
        select(SuggestionAuditLog)
        .where(SuggestionAuditLog.suggestion_id == suggestion_id)
        .order_by(col(SuggestionAuditLog.created_at).desc())
    ).all()


def _suggestion_occurrences(
    session: Session, suggestion: EventSuggestion
) -> SuggestionOccurrencesResponse:
    expanded = expand_occurrences(
        suggestion.start,
        suggestion.end,
        suggestion.recurrence_rule,
        suggestion.recurrence_dates,
        timezone_name=None if suggestion.all_day else suggestion.timezone,
    )
    materialised = {
        _as_utc(event.occurrence_key or event.start): event.event_id
        for event in session.exec(
            select(CachedEvent).where(CachedEvent.suggestion_id == suggestion.id)
        ).all()
        if not event.is_hidden
    }

    occurrences = []
    for index, (start, end) in enumerate(expanded):
        event_id = materialised.get(start)
        occurrences.append(
            SuggestionOccurrence(
                index=index,
                start=start,
                end=end,
                event_id=event_id,
                materialised=event_id is not None,
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
    admin: dict = Depends(require_admin),
):
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    update_data = body.model_dump(exclude_unset=True)
    if update_data.get("edit_locked", False) is None:
        update_data.pop("edit_locked")
    if "links" in update_data and update_data["links"] is not None:
        update_data["links"] = [
            link if isinstance(link, dict) else link.model_dump()
            for link in update_data["links"]
        ]

    changes = _diff_suggestion(suggestion, update_data)
    for field, value in update_data.items():
        setattr(suggestion, field, value)
    if changes:
        _record_audit(
            session,
            suggestion,
            "admin_edit",
            changes,
            admin_email=admin.get("email"),
        )

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
        visibility="public",
        calendar_id=body.calendar_id,
        latitude=lat,
        longitude=lng,
    )
    event_id = events[0].event_id

    # Preview rows were created pending, without the picture.
    for event in events:
        if event.image_key is None and suggestion.image_key:
            event.image_key = suggestion.image_key
            session.add(event)

    # Create EventTags from suggested_tag_ids
    if suggestion.suggested_tag_ids:
        for event in events:
            _apply_suggestion_tags(
                session, event.event_id, suggestion.suggested_tag_ids
            )

    _link_occurrences_to_series(session, suggestion, events, admin.get("email"))

    # Approval expands the preview to the full horizon; the submitter's RSVP has
    # to cover the occurrences that only exist now. The event just became
    # public, so this is when followers hear about the Going.
    _apply_creator_going(session, suggestion, events, fan_out=True)
    _attribute_to_organizer_submitter(session, suggestion, events)

    # Submissions without a materialised date keep their new-tag requests until now.
    if suggestion.suggested_new_tags:
        event_revisions.request_new_tags(
            session,
            event_id,
            suggestion.suggested_new_tags,
            suggestion.submitter_user_id,
        )
        suggestion.suggested_new_tags = None

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
    suggestion.reviewed_at = datetime.now(timezone.utc)
    suggestion.reviewed_by = admin.get("email")
    session.add(suggestion)
    _record_audit(session, suggestion, "approve", admin_email=admin.get("email"))

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

    submitter = (
        session.get(User, suggestion.submitter_user_id)
        if suggestion.submitter_user_id is not None
        else None
    )
    if submitter is not None:
        notify_submitter(
            session,
            submitter,
            SUGGESTION_APPROVED,
            subject_key=f"suggestion:{suggestion.id}",
            actor=event_revisions.admin_actor(session, admin.get("email")),
            event_id=event_id,
            context=suggestion.title,
        )

    session.commit()
    session.refresh(suggestion)
    if submitter is not None:
        _enqueue_decision_email(suggestion, SUGGESTION_APPROVED)
    return suggestion


@router.post(
    "/api/admin/suggestions/{suggestion_id}/decline",
    response_model=EventSuggestionResponse,
)
def decline_suggestion(
    suggestion_id: UUID,
    body: SuggestionRejectRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Refuse the request to go public; the event stays its owner's."""
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )
    return _refuse_suggestion(session, suggestion, body, admin, block=False)


@router.post(
    "/api/admin/suggestions/{suggestion_id}/block",
    response_model=EventSuggestionResponse,
)
def block_suggestion(
    suggestion_id: UUID,
    body: SuggestionRejectRequest,
    session: Session = Depends(get_session),
    admin: dict = Depends(require_admin),
):
    """Remove the event for everyone, its owner included."""
    suggestion = session.get(EventSuggestion, suggestion_id)
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status in ("blocked", "withdrawn"):
        raise HTTPException(
            status_code=400, detail=f"Suggestion is already {suggestion.status}"
        )
    return _refuse_suggestion(session, suggestion, body, admin, block=True)


def _refuse_suggestion(
    session: Session,
    suggestion: EventSuggestion,
    body: SuggestionRejectRequest,
    admin: dict,
    *,
    block: bool,
) -> EventSuggestion:
    suggestion.status = "blocked" if block else "declined"
    suggestion.admin_notes = body.admin_notes or suggestion.admin_notes
    suggestion.reviewed_at = datetime.now(timezone.utc)
    suggestion.reviewed_by = admin.get("email")
    _record_audit(
        session,
        suggestion,
        "block" if block else "decline",
        admin_email=admin.get("email"),
    )
    if block:
        # Unreferenced pictures are reclaimed by event_images.sweep_suggestion_images.
        suggestion.image_key = None
        _block_suggestion_events(session, suggestion)
    else:
        _set_events_review_status(session, suggestion, "reviewed")
    session.add(suggestion)
    submitter = (
        session.get(User, suggestion.submitter_user_id)
        if suggestion.submitter_user_id is not None
        else None
    )
    if submitter is not None:
        notify_submitter(
            session,
            submitter,
            SUGGESTION_REJECTED if block else SUGGESTION_DECLINED,
            subject_key=f"suggestion:{suggestion.id}",
            actor=event_revisions.admin_actor(session, admin.get("email")),
            event_id=None if block else suggestion.created_event_id,
            context=suggestion.title,
            description=suggestion.admin_notes,
        )
    session.commit()
    session.refresh(suggestion)
    if submitter is not None:
        _enqueue_decision_email(
            suggestion, SUGGESTION_REJECTED if block else SUGGESTION_DECLINED
        )
    return suggestion


_DECISION_STATUS = {
    SUGGESTION_APPROVED: "approved",
    SUGGESTION_DECLINED: "declined",
    SUGGESTION_REJECTED: "blocked",
}


def _enqueue_decision_email(suggestion: EventSuggestion, kind: str) -> None:
    job_queue.enqueue(SUGGESTION_DECISION_JOB, f"{suggestion.id}:{kind}")


def _deliver_decision_email(key: str) -> None:
    """Job: email the submitter an admin decision that still stands."""
    from backend.db.database import get_engine
    from backend.services.notification_delivery import record_delivery

    suggestion_id, _, kind = key.partition(":")
    with Session(get_engine()) as session:
        suggestion = session.get(EventSuggestion, UUID(suggestion_id))
        if (
            suggestion is None
            or suggestion.submitter_user_id is None
            or suggestion.status != _DECISION_STATUS[kind]
        ):
            return
        submitter = session.get(User, suggestion.submitter_user_id)
        if submitter is None or submitter.deleted_at is not None:
            return
        notification = session.exec(
            select(Notification)
            .where(
                Notification.recipient_user_id == submitter.id,
                Notification.kind == kind,
                Notification.subject_key == f"suggestion:{suggestion.id}",
                Notification.emailed_at.is_(None),
            )
            .with_for_update(skip_locked=True, of=Notification)
        ).first()
        if notification is None:
            return
        if kind == SUGGESTION_APPROVED:
            link_path = f"/event/{suggestion.created_event_id}"
        elif kind == SUGGESTION_REJECTED or not suggestion.created_event_id:
            link_path = "/me/submissions"
        else:
            link_path = f"/event/{suggestion.created_event_id}"
        sent = send_suggestion_decision_email(
            submitter,
            suggestion.title,
            approved=kind == SUGGESTION_APPROVED,
            reason=None if kind == SUGGESTION_APPROVED else suggestion.admin_notes,
            link_path=link_path,
            kept_private=kind == SUGGESTION_DECLINED,
        )
        if sent and notification is not None:
            now = datetime.now(timezone.utc)
            notification.emailed_at = now
            record_delivery(session, notification.id, "email", now, source="job")
            session.add(notification)
            session.commit()


job_queue.register(SUGGESTION_DECISION_JOB, _deliver_decision_email)


def _block_suggestion_events(session: Session, suggestion: EventSuggestion) -> None:
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
        set_event_status(event, STATUS_REMOVED, REASON_ADMIN)
        session.add(event)
        if session.get(BlockedEvent, event.event_id) is None:
            session.add(
                BlockedEvent(
                    event_id=event.event_id,
                    reason="rejected",
                    reason_detail=suggestion.admin_notes,
                )
            )


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
