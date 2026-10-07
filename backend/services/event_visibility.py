from collections.abc import Iterable
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import event as sa_event, inspect
from sqlalchemy.orm import Session as OrmSession
from sqlmodel import Session, and_, col, or_, select

from backend.db.models import CachedEvent, EventSuggestion, SiteSetting


SHOW_PENDING_EVENTS_KEY = "show_pending_events"

VISIBILITY_PUBLIC = "public"
VISIBILITY_PRIVATE = "private"
AUDIENCES = (VISIBILITY_PUBLIC, VISIBILITY_PRIVATE)

STATUS_NEW = "new"
STATUS_PUBLISHED = "published"
STATUS_UNPUBLISHED = "unpublished"
STATUS_CANCELLED = "cancelled"
STATUS_REMOVED = "removed"
EVENT_STATUSES = (
    STATUS_NEW,
    STATUS_PUBLISHED,
    STATUS_UNPUBLISHED,
    STATUS_CANCELLED,
    STATUS_REMOVED,
)
LISTED_STATUSES = (STATUS_PUBLISHED, STATUS_CANCELLED)
PROCESSABLE_STATUSES = (STATUS_NEW, STATUS_PUBLISHED, STATUS_UNPUBLISHED)

REASON_ADMIN = "admin"
REASON_DUPLICATE = "duplicate"
REASON_OWNER = "owner"
REASON_GOOGLE_CALENDAR = "google_calendar"
REASON_SERIES_EDIT = "series_edit"
# A new event an admin turned down.
REASON_REJECTED = "rejected"
REASON_MERGED = "merged"
REMOVAL_REASONS = (
    REASON_ADMIN,
    REASON_DUPLICATE,
    REASON_OWNER,
    REASON_GOOGLE_CALENDAR,
    REASON_SERIES_EDIT,
    REASON_REJECTED,
    REASON_MERGED,
)

_LEGACY_STATUS_COLUMNS = ("review_status", "is_hidden", "is_cancelled", "deleted_at")


def set_event_status(
    event: CachedEvent, status: str, reason: str | None = None
) -> None:
    """The one writer of ``status``; mirrors the legacy columns until they are dropped."""
    now = datetime.now(timezone.utc)
    event.status = status
    event.status_reason = reason if status == STATUS_REMOVED else None
    event.status_changed_at = now
    event.updated_at = now
    from_source = status == STATUS_REMOVED and reason == REASON_GOOGLE_CALENDAR
    # A source deletion is undone by the next sync, so it only sets deleted_at.
    event.is_hidden = status == STATUS_UNPUBLISHED or (
        status == STATUS_REMOVED and not from_source
    )
    event.is_cancelled = status == STATUS_CANCELLED
    event.deleted_at = (event.deleted_at or now) if from_source else None
    if status == STATUS_NEW:
        event.review_status = "pending"
    elif status != STATUS_REMOVED:
        event.review_status = "reviewed"


def legacy_status(event: CachedEvent) -> tuple[str, str | None]:
    if event.deleted_at is not None:
        return STATUS_REMOVED, REASON_GOOGLE_CALENDAR
    if event.is_hidden:
        return STATUS_UNPUBLISHED, None
    if event.is_cancelled:
        return STATUS_CANCELLED, None
    if event.review_status == "pending":
        return STATUS_NEW, None
    return STATUS_PUBLISHED, None


def _sync_status_with_legacy(event: CachedEvent) -> None:
    state = inspect(event)
    if state.pending:
        if event.status is None:
            event.status, event.status_reason = legacy_status(event)
        return
    if state.attrs.status.history.has_changes() or not any(
        state.attrs[name].history.has_changes() for name in _LEGACY_STATUS_COLUMNS
    ):
        return
    status, reason = legacy_status(event)
    # A hide flag on a removed event is the removal itself, not an admin hide.
    if status == STATUS_UNPUBLISHED and event.status == STATUS_REMOVED:
        return
    event.status, event.status_reason = status, reason
    event.status_changed_at = datetime.now(timezone.utc)


def _newly_removed(event: CachedEvent) -> bool:
    if event.status != STATUS_REMOVED:
        return False
    state = inspect(event)
    return state.pending or state.attrs.status.history.has_changes()


def dismiss_open_review_items(session, event_ids: list[str]) -> None:
    """Close what still waits on removed events; nobody is notified."""
    from backend.db.models import (
        EventDuplicateGroup,
        EventDuplicateMember,
        EventMessage,
        EventMessageReport,
        EventPromoCode,
        EventRevision,
        EventSeries,
        EventSeriesMember,
        TagSuggestion,
    )

    if not event_ids:
        return
    now = datetime.now(timezone.utc)

    def rows(statement):
        return session.execute(statement).scalars().all()

    # Rows can carry unflushed decisions, so filter on the loaded objects.
    for suggestion in rows(
        select(TagSuggestion).where(col(TagSuggestion.event_id).in_(event_ids))
    ):
        if suggestion.status == "pending":
            suggestion.status = "rejected"
            suggestion.admin_notes = suggestion.admin_notes or "auto: event removed"
            suggestion.reviewed_at = now
            session.add(suggestion)
    for revision in rows(
        select(EventRevision).where(col(EventRevision.event_id).in_(event_ids))
    ):
        if revision.status in ("draft", "pending"):
            revision.status = "closed"
            revision.decided_by = "system"
            revision.decided_at = now
            session.add(revision)
    for promo in rows(
        select(EventPromoCode).where(col(EventPromoCode.event_id).in_(event_ids))
    ):
        if promo.status == "pending":
            promo.status = "rejected"
            session.add(promo)
    for report in rows(
        select(EventMessageReport)
        .join(EventMessage, EventMessage.id == EventMessageReport.message_id)
        .where(col(EventMessage.event_id).in_(event_ids))
    ):
        if report.resolved_at is None:
            report.resolved_at = now
            report.resolved_by = "system"
            session.add(report)
    for group_model, member_model, key in (
        (EventDuplicateGroup, EventDuplicateMember, "group_id"),
        (EventSeries, EventSeriesMember, "series_id"),
    ):
        members = rows(
            select(member_model).where(col(member_model.event_id).in_(event_ids))
        )
        for group_id in {getattr(m, key) for m in members}:
            group = session.get(group_model, group_id)
            if group is None or group.status != "pending":
                continue
            others = [
                m
                for m in rows(
                    select(member_model).where(getattr(member_model, key) == group_id)
                )
                if m.event_id not in event_ids
            ]
            for member in members:
                if getattr(member, key) == group_id:
                    session.delete(member)
            if len(others) < 2:
                group.status = "dismissed"
                group.resolved_at = now
                group.resolved_by_admin = "system"
                session.add(group)


def _awaits_creation(event: CachedEvent) -> bool:
    return event.status == STATUS_NEW and event.visibility == VISIBILITY_PUBLIC


def _mirror_creation(session, event: CachedEvent, deferred: list) -> None:
    """Keep one open ``create`` change while a public event is new."""
    from backend.services import event_revisions as er

    state = inspect(event)
    if state.pending:
        if _awaits_creation(event):
            deferred.append(event)
        return
    if not (
        state.attrs.status.history.has_changes()
        or state.attrs.visibility.history.has_changes()
    ):
        return
    change = er.open_change(session, er.KIND_CREATE, event_id=event.event_id)
    if _awaits_creation(event):
        if change is None:
            session.add(er.open_creation(event))
    elif change is not None and event.status != STATUS_REMOVED:
        # Removal is closed by dismiss_open_review_items.
        er.mark_decided(
            change,
            er.STATUS_ACCEPTED if event.status != STATUS_NEW else er.STATUS_CLOSED,
            None,
        )
        session.add(change)


def _mirror_go_public(session, suggestion: EventSuggestion, deferred: list) -> None:
    """Keep one open ``go_public`` change while a submission asks to go public."""
    from backend.services import event_revisions as er

    state = inspect(suggestion)
    if state.pending:
        if suggestion.status == "pending":
            deferred.append(suggestion)
        return
    if not state.attrs.status.history.has_changes():
        return
    change = er.open_change(session, er.KIND_GO_PUBLIC, suggestion_id=suggestion.id)
    if suggestion.status == "pending":
        if change is None:
            session.add(er.open_go_public(suggestion))
    elif change is not None:
        er.mark_decided(
            change,
            er.GO_PUBLIC_OUTCOMES.get(suggestion.status, er.STATUS_CLOSED),
            suggestion.reviewed_by,
        )
        session.add(change)


@sa_event.listens_for(OrmSession, "before_flush")
def _event_statuses(session, _flush_context, _instances) -> None:
    from backend.db.models import EventRevision
    from backend.services import event_revisions as er

    # Code that still writes the legacy columns keeps ``status`` in step.
    removed: list[str] = []
    deferred: list = []
    session.info["deferred_changes"] = deferred
    with session.no_autoflush:
        for obj in (*session.new, *session.dirty):
            if isinstance(obj, CachedEvent):
                _sync_status_with_legacy(obj)
                if _newly_removed(obj):
                    removed.append(obj.event_id)
                _mirror_creation(session, obj, deferred)
            elif isinstance(obj, EventSuggestion):
                _mirror_go_public(session, obj, deferred)
            elif isinstance(obj, EventRevision) and obj.kind in (None, *er.EDIT_KINDS):
                obj.kind = er.derive_kind(obj.changes or {})
        if removed:
            dismiss_open_review_items(session, removed)


@sa_event.listens_for(OrmSession, "after_flush_postexec")
def _add_deferred_changes(session, _flush_context) -> None:
    # Rows inserted in this flush get their change once they exist (FK order).
    from backend.services import event_revisions as er

    deferred = session.info.pop("deferred_changes", [])
    for obj in deferred:
        if isinstance(obj, CachedEvent):
            if _awaits_creation(obj):
                session.add(er.open_creation(obj))
        elif obj.status == "pending":
            session.add(er.open_go_public(obj))


def event_status(event: CachedEvent) -> str:
    return event.status or legacy_status(event)[0]


def is_listed(event: CachedEvent) -> bool:
    return event_status(event) in LISTED_STATUSES


def is_processable(event: CachedEvent) -> bool:
    return event_status(event) in PROCESSABLE_STATUSES


def listed_clause():
    return col(CachedEvent.status).in_(LISTED_STATUSES)


def discovery_clause():
    # Cancelled events stay reachable by link and in people's own lists only.
    return col(CachedEvent.status) != STATUS_CANCELLED


def processable_clause():
    return col(CachedEvent.status).in_(PROCESSABLE_STATUSES)


def show_pending_events_enabled(session: Session) -> bool:
    row = session.get(SiteSetting, SHOW_PENDING_EVENTS_KEY)
    value = getattr(row, "value", None)
    return bool(row and isinstance(value, str) and value.strip().lower() == "true")


def is_private(event: CachedEvent) -> bool:
    return event.visibility == VISIBILITY_PRIVATE


def _discoverable_clause(session: Session):
    # The toggle only releases unreviewed public (synced) events; a private
    # event never reaches anyone but its owner.
    statuses = LISTED_STATUSES
    if show_pending_events_enabled(session):
        statuses = (*LISTED_STATUSES, STATUS_NEW)
    return and_(
        CachedEvent.visibility == VISIBILITY_PUBLIC,
        col(CachedEvent.status).in_(statuses),
    )


def event_is_user_facing(session: Session, event: CachedEvent) -> bool:
    if is_private(event):
        return False
    return is_listed(event) or (
        event_status(event) == STATUS_NEW and show_pending_events_enabled(session)
    )


def is_event_owner(event: CachedEvent, viewer_id: UUID | None) -> bool:
    return viewer_id is not None and event.owner_user_id == viewer_id


def viewer_can_see_event(
    session: Session,
    event: CachedEvent,
    viewer_id: UUID | None,
    *,
    is_admin: bool = False,
) -> bool:
    return (
        is_admin
        or event_is_user_facing(session, event)
        or is_event_owner(event, viewer_id)
    )


def pending_request_ids(session: Session, suggestion_ids: Iterable[UUID]) -> set[UUID]:
    """Suggestions among ``suggestion_ids`` whose owner asked to go public."""
    ids = {sid for sid in suggestion_ids if sid is not None}
    if not ids:
        return set()
    return set(
        session.exec(
            select(EventSuggestion.id).where(
                col(EventSuggestion.id).in_(ids),
                EventSuggestion.status == "pending",
            )
        ).all()
    )


def audience(event: CachedEvent) -> str:
    """Who could see the event; whether it is shown at all is ``status``."""
    return VISIBILITY_PRIVATE if is_private(event) else VISIBILITY_PUBLIC


def event_wants_public(session: Session, event: CachedEvent) -> bool:
    return bool(
        event.suggestion_id and pending_request_ids(session, [event.suggestion_id])
    )


def audience_clause(value: str):
    return CachedEvent.visibility == value


def wants_public_clause():
    return col(CachedEvent.suggestion_id).in_(
        select(EventSuggestion.id).where(EventSuggestion.status == "pending")
    )


def apply_event_visibility(statement, session: Session, viewer_id: UUID | None = None):
    clause = _discoverable_clause(session)
    if viewer_id is not None:
        clause = or_(clause, CachedEvent.owner_user_id == viewer_id)
    return statement.where(clause)


def eligible_event_ids(
    session: Session, event_ids: Iterable[str], viewer_id: UUID | None = None
) -> set[str]:
    ids = list(dict.fromkeys(event_ids))
    if not ids:
        return set()
    statement = select(CachedEvent.event_id).where(col(CachedEvent.event_id).in_(ids))
    statement = apply_event_visibility(statement, session, viewer_id)
    return set(session.exec(statement).all())
