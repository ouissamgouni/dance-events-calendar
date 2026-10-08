"""Staged changes to already-published events.

Edits that reach an event after it was published (``review_status ==
"reviewed"``) do not overwrite it. They become an ``EventRevision`` that an
admin applies or discards, and applying one tells everyone who saved or is
going to the event exactly what changed. Unpublished events are still edited
in place: nobody but admins (and, for submissions, the submitter) sees them.

Callers own the transaction; nothing here commits.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlmodel import Session, col, select

from backend.db.models import CachedEvent, EventRevision, Notification, User
from backend.services import job_queue
from backend.services.notification_delivery import record_delivery

EVENT_CHANGED = "event_changed"
EVENT_CANCELLED = "event_cancelled"
CHANGE_EMAILS_JOB = "event_changed_emails"

SOURCE_SYNC = "sync"
SOURCE_ADMIN = "admin"
SOURCE_SUBMITTER = "submitter"
# Any signed-in user suggesting a change to a public event, and the event's
# organizer, whose changes go live straight away.
SOURCE_USER = "user"
SOURCE_ORGANIZER = "organizer"
# Tags live in EventTag rows, so user changes carry them as a pseudo-field.
TAG_FIELD = "tag_ids"
# A proposed removal; ``status_reason`` says why. Cancellation uses is_cancelled.
STATUS_FIELD = "status"
STATUS_REASON_FIELD = "status_reason"
_PSEUDO_FIELDS = (TAG_FIELD, STATUS_FIELD, STATUS_REASON_FIELD)

STATUS_DRAFT = "draft"
STATUS_PENDING = "pending"
STATUS_ACCEPTED = "accepted"
STATUS_REJECTED = "rejected"
STATUS_SUPERSEDED = "superseded"
# An accepted organizer or user change that an admin later undid.
STATUS_REVERTED = "reverted"
# The proposer pulled their change back before review.
STATUS_WITHDRAWN = "withdrawn"
# Closed by the system, e.g. its event was removed.
STATUS_CLOSED = "closed"
OPEN_STATUSES = (STATUS_DRAFT, STATUS_PENDING)

KIND_CREATE = "create"
KIND_EDIT = "edit"
KIND_CANCEL = "cancel"
KIND_REMOVE = "remove"
KIND_GO_PUBLIC = "go_public"
KINDS = (KIND_CREATE, KIND_EDIT, KIND_CANCEL, KIND_REMOVE, KIND_GO_PUBLIC)
# Changes to an existing event's content or lifecycle.
EDIT_KINDS = (KIND_EDIT, KIND_CANCEL, KIND_REMOVE)

REVISABLE_FIELDS = (
    "title",
    "description",
    "location",
    "start",
    "end",
    "all_day",
    "links",
    "price_min",
    "price_max",
    "price_currency",
    "price_is_free",
)
# An admin picking a venue also picks its coordinates; source syncs never
# change coordinates of an existing row, so only drafts carry them.
DRAFT_FIELDS = REVISABLE_FIELDS + ("latitude", "longitude", "timezone")
# Only an event's organizer proposes these; kept out of REVISABLE_FIELDS so
# source syncs never stage them.
CANCEL_FIELDS = ("is_cancelled", "cancellation_note")
# Changes attendees are told about; the rest is recorded silently. The
# recurrence fields only occur in submitter (series-level) revisions.
MATERIAL_FIELDS = frozenset(
    {
        "title",
        "location",
        "start",
        "end",
        "all_day",
        "is_cancelled",
        STATUS_FIELD,
        "recurrence_rule",
        "recurrence_dates",
    }
)
# Each date keeps its own time, so these never spread to the rest of a series.
TIME_FIELDS = frozenset({"start", "end", "all_day"})


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def to_json(value):
    if isinstance(value, datetime):
        return _as_utc(value).isoformat()
    return value


def _from_json(field: str, value):
    if field in ("start", "end") and isinstance(value, str):
        return datetime.fromisoformat(value)
    return value


def snapshot(event: CachedEvent) -> dict:
    return {field: to_json(getattr(event, field)) for field in REVISABLE_FIELDS}


def diff(before: dict, after: dict) -> dict:
    return {
        field: {"old": before.get(field), "new": after.get(field)}
        for field in REVISABLE_FIELDS
        if field in after and before.get(field) != after.get(field)
    }


def _hash_changes(changes: dict) -> str:
    payload = json.dumps(
        {field: change["new"] for field, change in changes.items()},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def group_hash(changes: dict) -> str:
    """Like ``_hash_changes`` but with times as offsets, so moving every date
    of a series by an hour hashes the same."""
    shape = {}
    for field, change in changes.items():
        old, new = change.get("old"), change.get("new")
        if field in ("start", "end") and old and new:
            moved = _as_utc(_from_json(field, new)) - _as_utc(_from_json(field, old))
            shape[field] = ["moved", moved.total_seconds()]
        else:
            shape[field] = new
    payload = json.dumps(shape, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


def has_time_change(changes: dict) -> bool:
    return bool(TIME_FIELDS & changes.keys())


def rebase_changes(session: Session, event: CachedEvent, changes: dict) -> dict:
    """``changes`` for another date of the series: same new values, its own old ones."""
    rebased = {}
    for field, change in changes.items():
        new = sorted(change["new"] or []) if field == TAG_FIELD else change["new"]
        old = _current_value(session, event, field)
        if old != new:
            rebased[field] = {"old": old, "new": new}
    if STATUS_FIELD not in rebased:
        rebased.pop(STATUS_REASON_FIELD, None)
    elif STATUS_REASON_FIELD in changes:
        rebased[STATUS_REASON_FIELD] = {
            "old": event.status_reason,
            "new": changes[STATUS_REASON_FIELD]["new"],
        }
    return rebased


def open_revisions(session: Session, event_id: str) -> list[EventRevision]:
    return list(
        session.exec(
            select(EventRevision)
            .where(EventRevision.event_id == event_id)
            .where(col(EventRevision.status).in_(OPEN_STATUSES))
            .where(col(EventRevision.kind).in_(EDIT_KINDS))
            .order_by(EventRevision.created_at)
        ).all()
    )


def pending_changes_clause():
    """``CachedEvent`` filter: an unpublished change exists — a source or
    submitter change awaiting review, or an admin draft not yet published."""
    from sqlmodel import or_

    pending = select(EventRevision).where(
        col(EventRevision.status).in_(OPEN_STATUSES),
        col(EventRevision.kind).in_(EDIT_KINDS),
    )
    return or_(
        col(CachedEvent.event_id).in_(
            pending.with_only_columns(EventRevision.event_id).where(
                col(EventRevision.event_id).is_not(None)
            )
        ),
        col(CachedEvent.suggestion_id).in_(
            pending.with_only_columns(EventRevision.suggestion_id).where(
                col(EventRevision.suggestion_id).is_not(None)
            )
        ),
    )


def _restore(event: CachedEvent, values: dict) -> None:
    for field, value in values.items():
        value = _from_json(field, value)
        current = getattr(event, field)
        # Keep the row's naive/aware form so later equality checks still hold.
        if (
            isinstance(value, datetime)
            and isinstance(current, datetime)
            and current.tzinfo is None
        ):
            value = _as_utc(value).replace(tzinfo=None)
        setattr(event, field, value)


def stage_source_changes(
    session: Session, event: CachedEvent, before: dict
) -> EventRevision | None:
    """Turn in-place edits a sync just made into a pending revision.

    ``before`` is ``snapshot(event)`` taken before the sync touched the row.
    Only fields the source changed since the previous sync are proposed, so
    a local edit the source never had is not offered back as a revert. The
    live values are put back; the incoming ones wait for an admin.
    Unpublished events keep the incoming values. Returns the open revision,
    or None when nothing needs review.
    """
    incoming = snapshot(event)
    baseline = event.source_values or before
    event.source_values = incoming
    withdraw_source_removal(session, event.event_id)
    if event.review_status != "reviewed":
        return None
    moved = {f for f in REVISABLE_FIELDS if incoming.get(f) != baseline.get(f)}
    _restore(event, before)

    existing = session.exec(
        select(EventRevision)
        .where(EventRevision.event_id == event.event_id)
        .where(EventRevision.source == SOURCE_SYNC)
        .where(EventRevision.status == STATUS_PENDING)
    ).first()
    if not moved:
        return existing
    proposed = set(moved)
    if existing is not None:
        # Keep earlier proposals the source still stands by.
        proposed |= {
            f for f, c in existing.changes.items() if c.get("new") == incoming.get(f)
        }
    changes = {
        f: {"old": before.get(f), "new": incoming.get(f)}
        for f in REVISABLE_FIELDS
        if f in proposed and incoming.get(f) != before.get(f)
    }
    if not changes:
        # The source went back to what is live; the old proposal is moot.
        if existing is not None:
            existing.status = STATUS_SUPERSEDED
            existing.updated_at = datetime.now(timezone.utc)
            session.add(existing)
        return None

    content_hash = _hash_changes(changes)
    if existing is not None and existing.content_hash == content_hash:
        return existing
    discarded = session.exec(
        select(EventRevision.id)
        .where(EventRevision.event_id == event.event_id)
        .where(EventRevision.source == SOURCE_SYNC)
        .where(EventRevision.status == STATUS_REJECTED)
        .where(EventRevision.content_hash == content_hash)
    ).first()
    if discarded is not None:
        return None
    if existing is not None:
        existing.status = STATUS_SUPERSEDED
        existing.updated_at = datetime.now(timezone.utc)
        session.add(existing)
    revision = EventRevision(
        event_id=event.event_id,
        source=SOURCE_SYNC,
        status=STATUS_PENDING,
        changes=changes,
        content_hash=content_hash,
        group_hash=group_hash(changes),
    )
    session.add(revision)
    return revision


def get_draft(session: Session, event_id: str) -> EventRevision | None:
    return session.exec(
        select(EventRevision)
        .where(EventRevision.event_id == event_id)
        .where(EventRevision.source == SOURCE_ADMIN)
        .where(EventRevision.status == STATUS_DRAFT)
    ).first()


def update_draft(
    session: Session, event: CachedEvent, updates: dict, admin_email: str | None
) -> EventRevision | None:
    """Merge admin field edits into the event's shared draft.

    A field edited back to its live value drops out of the draft; an empty
    draft is deleted. Returns the draft, or None when nothing is left.
    """
    live = {field: to_json(getattr(event, field)) for field in DRAFT_FIELDS}
    draft = get_draft(session, event.event_id)
    changes = dict(draft.changes) if draft else {}
    for field, value in updates.items():
        if field not in DRAFT_FIELDS:
            continue
        new = to_json(value)
        if new == live.get(field):
            changes.pop(field, None)
        else:
            changes[field] = {"old": live.get(field), "new": new}
    if not changes:
        if draft is not None:
            session.delete(draft)
        return None
    if draft is None:
        draft = EventRevision(
            event_id=event.event_id,
            source=SOURCE_ADMIN,
            status=STATUS_DRAFT,
            changes=changes,
            proposed_by_admin_email=admin_email,
        )
    else:
        draft.changes = changes
        draft.updated_at = datetime.now(timezone.utc)
    session.add(draft)
    return draft


def apply_to_event(event: CachedEvent, changes: dict) -> None:
    from backend.services.event_visibility import set_event_status

    _restore(
        event,
        {
            field: change["new"]
            for field, change in changes.items()
            if field not in _PSEUDO_FIELDS
        },
    )
    if STATUS_FIELD in changes:
        reason = (changes.get(STATUS_REASON_FIELD) or {}).get("new")
        set_event_status(event, changes[STATUS_FIELD]["new"], reason)
    event.updated_at = datetime.now(timezone.utc)


def open_status_revision(session: Session, event_id: str) -> EventRevision | None:
    """The pending removal or cancellation of an event, if any."""
    return next(
        (
            r
            for r in open_revisions(session, event_id)
            if r.status == STATUS_PENDING
            and ({STATUS_FIELD, "is_cancelled"} & r.changes.keys())
        ),
        None,
    )


def propose_removal(
    session: Session, event: CachedEvent, reason: str, *, source: str
) -> EventRevision | None:
    """Removal waits for an admin while people can see the event."""
    from backend.services.event_visibility import (
        STATUS_REMOVED,
        event_status,
        is_listed,
        set_event_status,
    )

    if event_status(event) == STATUS_REMOVED:
        return None
    if not is_listed(event):
        set_event_status(event, STATUS_REMOVED, reason)
        session.add(event)
        return None
    existing = open_status_revision(session, event.event_id)
    if existing is not None:
        return existing
    changes = {
        STATUS_FIELD: {"old": event_status(event), "new": STATUS_REMOVED},
        STATUS_REASON_FIELD: {"old": None, "new": reason},
    }
    revision = EventRevision(
        event_id=event.event_id,
        source=source,
        status=STATUS_PENDING,
        changes=changes,
        group_hash=group_hash(changes),
    )
    session.add(revision)
    return revision


def withdraw_source_removal(session: Session, event_id: str) -> None:
    """The event came back at its source, so its pending removal is moot."""
    for revision in open_revisions(session, event_id):
        if revision.source == SOURCE_SYNC and STATUS_FIELD in revision.changes:
            revision.status = STATUS_SUPERSEDED
            revision.updated_at = datetime.now(timezone.utc)
            session.add(revision)


def retarget_status(revision: EventRevision, status: str) -> None:
    """Let an admin cancel instead of remove, or remove instead of cancel."""
    from backend.services.event_visibility import (
        REASON_ADMIN,
        REASON_GOOGLE_CALENDAR,
        STATUS_CANCELLED,
        STATUS_REMOVED,
    )

    kept = {
        f: c
        for f, c in revision.changes.items()
        if f not in (STATUS_FIELD, STATUS_REASON_FIELD, "is_cancelled")
    }
    if status == STATUS_CANCELLED:
        kept["is_cancelled"] = {"old": False, "new": True}
    elif status == STATUS_REMOVED:
        kept.pop("cancellation_note", None)
        reason = (revision.changes.get(STATUS_REASON_FIELD) or {}).get("new") or (
            REASON_GOOGLE_CALENDAR if revision.source == SOURCE_SYNC else REASON_ADMIN
        )
        kept[STATUS_FIELD] = {"old": None, "new": STATUS_REMOVED}
        kept[STATUS_REASON_FIELD] = {"old": None, "new": reason}
    revision.changes = kept
    revision.content_hash = _hash_changes(kept)
    revision.group_hash = group_hash(kept)


def is_removal(changes: dict) -> bool:
    return (changes.get(STATUS_FIELD) or {}).get("new") == "removed"


def is_cancellation(changes: dict) -> bool:
    return bool((changes.get("is_cancelled") or {}).get("new"))


def derive_kind(changes: dict) -> str:
    if is_removal(changes):
        return KIND_REMOVE
    if "is_cancelled" in changes:
        return KIND_CANCEL
    return KIND_EDIT


def open_change(
    session: Session, kind: str, *, event_id: str | None = None, suggestion_id=None
) -> EventRevision | None:
    statement = select(EventRevision).where(
        EventRevision.kind == kind, col(EventRevision.status).in_(OPEN_STATUSES)
    )
    if event_id is not None:
        statement = statement.where(EventRevision.event_id == event_id)
    if suggestion_id is not None:
        statement = statement.where(EventRevision.suggestion_id == suggestion_id)
    return session.exec(statement).first()


def open_creation(event: CachedEvent) -> EventRevision:
    return EventRevision(
        event_id=event.event_id,
        kind=KIND_CREATE,
        source=SOURCE_SUBMITTER if event.suggestion_id else SOURCE_SYNC,
        status=STATUS_PENDING,
        changes={},
    )


def open_go_public(suggestion) -> EventRevision:
    return EventRevision(
        suggestion_id=suggestion.id,
        kind=KIND_GO_PUBLIC,
        source=SOURCE_SUBMITTER,
        status=STATUS_PENDING,
        changes={"visibility": {"old": "private", "new": "public"}},
        proposed_by_user_id=suggestion.submitter_user_id,
    )


# How a go-public request ends, by the suggestion status it moves to.
GO_PUBLIC_OUTCOMES = {
    "approved": STATUS_ACCEPTED,
    "declined": STATUS_REJECTED,
    "blocked": STATUS_REJECTED,
    "private": STATUS_WITHDRAWN,
    "withdrawn": STATUS_WITHDRAWN,
}


# Fields reverted together with the field they qualify.
_REVERT_WITH = {
    "cancellation_note": "is_cancelled",
    STATUS_REASON_FIELD: STATUS_FIELD,
    "latitude": "location",
    "longitude": "location",
}


def _current_value(session: Session, event: CachedEvent, field: str):
    from backend.services.event_visibility import event_status

    if field == TAG_FIELD:
        return current_tag_ids(session, event.event_id)
    if field == STATUS_FIELD:
        return event_status(event)
    if field == STATUS_REASON_FIELD:
        return event.status_reason
    return to_json(getattr(event, field, None))


def revert_changes(session: Session, event: CachedEvent, changes: dict) -> dict:
    """The inverse of ``changes``, limited to fields nobody has changed since."""

    def untouched(field: str) -> bool:
        new = changes[field]["new"]
        if field == TAG_FIELD:
            new = sorted(new or [])
        return _current_value(session, event, field) == new

    kept = {
        f
        for f in changes
        if (f not in _REVERT_WITH or _REVERT_WITH[f] not in changes) and untouched(f)
    }
    return {
        f: {"old": c["new"], "new": c["old"]}
        for f, c in changes.items()
        if f in kept or _REVERT_WITH.get(f) in kept
    }


def current_tag_ids(session: Session, event_id: str) -> list[int]:
    from backend.db.models import EventTag

    return sorted(
        session.exec(select(EventTag.tag_id).where(EventTag.event_id == event_id)).all()
    )


def validate_tag_ids(
    session: Session, tag_ids: list[int], current: list[int] = ()
) -> list[int]:
    """Deduplicated ``tag_ids``; ValueError unless each is an enabled event tag
    (or one of the ``current`` tags) and single-choice groups get at most one."""
    from backend.db.models import Tag, TagGroup

    wanted = list(dict.fromkeys(tag_ids))
    if not wanted:
        return []
    rows = session.exec(
        select(Tag, TagGroup)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(col(Tag.id).in_(wanted))
    ).all()
    found = {tag.id: (tag, group) for tag, group in rows}
    per_group: dict[int, list[str]] = {}
    groups = {}
    for tag_id in wanted:
        if tag_id not in found:
            raise ValueError(f"Unknown tag {tag_id}")
        tag, group = found[tag_id]
        usable = tag.enabled and group.enabled and group.scope == "event"
        if not usable and tag_id not in current:
            raise ValueError(f"The tag {tag.label} can't be used on events")
        per_group.setdefault(group.id, []).append(tag.label)
        groups[group.id] = group
    for group_id, labels in per_group.items():
        if not groups[group_id].allow_multiple and len(labels) > 1:
            raise ValueError(f"Pick only one {groups[group_id].label} tag")
    return wanted


def request_new_tags(
    session: Session, event_id: str, items: list[dict], user_id
) -> int:
    """Queue tags that don't exist yet as pending tag suggestions."""
    from sqlmodel import func

    from backend.db.models import TagSuggestion

    created = 0
    for item in items:
        free_text = (item.get("free_text") or "").strip()
        if not free_text:
            continue
        duplicate = session.exec(
            select(TagSuggestion.id).where(
                TagSuggestion.event_id == event_id,
                TagSuggestion.status == "pending",
                func.lower(TagSuggestion.free_text) == free_text.lower(),
            )
        ).first()
        if duplicate is not None:
            continue
        session.add(
            TagSuggestion(
                event_id=event_id,
                free_text=free_text,
                group_slug=item.get("group_slug"),
                source="user",
                submitter_user_id=user_id,
            )
        )
        created += 1
    return created


def replace_event_tags(
    session: Session, event: CachedEvent, tag_ids: list[int]
) -> None:
    """Make ``tag_ids`` the event's tags. Raises ValueError on a reach conflict."""
    from backend.db.models import EventTag, Tag
    from backend.services.reach import sync_event_reach

    have = set(current_tag_ids(session, event.event_id))
    # Tags disabled since a change was proposed are not added.
    wanted = [
        tid
        for tid in dict.fromkeys(tag_ids)
        if (tag := session.get(Tag, tid)) is not None and (tag.enabled or tid in have)
    ]
    sync_event_reach(session, event, wanted)
    for row in session.exec(
        select(EventTag).where(EventTag.event_id == event.event_id)
    ).all():
        if row.tag_id not in wanted:
            session.delete(row)
    for tid in wanted:
        if tid not in have:
            session.add(EventTag(event_id=event.event_id, tag_id=tid))


def supersede_overlapping(
    session: Session, event_id: str, applied: EventRevision
) -> None:
    """Drop fields a just-applied revision decided from other open proposals."""
    fields = set(applied.changes)
    for other in open_revisions(session, event_id):
        if other.id == applied.id or other.source == SOURCE_ADMIN:
            continue
        remaining = {f: c for f, c in other.changes.items() if f not in fields}
        if remaining == other.changes:
            continue
        other.updated_at = datetime.now(timezone.utc)
        if remaining:
            other.changes = remaining
            other.content_hash = _hash_changes(remaining)
            other.group_hash = group_hash(remaining)
        else:
            other.status = STATUS_SUPERSEDED
        session.add(other)


def mark_decided(revision: EventRevision, status: str, admin_email: str | None) -> None:
    now = datetime.now(timezone.utc)
    revision.status = status
    revision.decided_by = admin_email
    revision.decided_at = now
    revision.updated_at = now


def material_changes(changes: dict) -> dict:
    return {f: c for f, c in changes.items() if f in MATERIAL_FIELDS}


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo((name or "UTC").strip() or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _when(value, tz: ZoneInfo, all_day: bool) -> str:
    if value is None:
        return "?"
    moment = _as_utc(_from_json("start", value)).astimezone(tz)
    return moment.strftime("%a %d %b") if all_day else moment.strftime("%a %d %b %H:%M")


# How other fields are named when attendees are told about them. Coordinates
# move with the venue, so they are not mentioned separately.
_MINOR_FIELD_NAMES = {
    "description": "description",
    "links": "links",
    "price_min": "price",
    "price_max": "price",
    "price_currency": "price",
    "price_is_free": "price",
    "image_key": "picture",
    "suggested_tag_ids": "tags",
    TAG_FIELD: "tags",
    "cancellation_note": "cancellation note",
}


def describe_changes(changes: dict, tz_name: str | None = None) -> str:
    """Material changes in full (``Time: Fri 03 Oct 20:00 → 21:00``), other
    updated fields by name only."""
    tz = _zone(tz_name)
    parts: list[str] = []
    if is_removal(changes):
        return "Removed"
    if "is_cancelled" in changes:
        if changes["is_cancelled"]["new"]:
            note = (changes.get("cancellation_note") or {}).get("new")
            parts.append(f"Cancelled: {note}" if note else "Cancelled")
        else:
            parts.append("No longer cancelled")
        changes = {f: c for f, c in changes.items() if f != "cancellation_note"}
    if "title" in changes:
        parts.append(f"Title: {changes['title']['old']} → {changes['title']['new']}")
    if {"start", "end", "all_day"} & changes.keys():
        all_day_old = changes.get("all_day", {}).get("old", False)
        all_day_new = changes.get("all_day", {}).get("new", all_day_old)
        if "start" in changes:
            old = _when(changes["start"]["old"], tz, bool(all_day_old))
            new = _when(changes["start"]["new"], tz, bool(all_day_new))
            if old[:10] == new[:10] and not all_day_new:
                new = new[11:]
            parts.append(f"Time: {old} → {new}")
        elif "end" in changes:
            parts.append(
                "Ends: "
                f"{_when(changes['end']['old'], tz, bool(all_day_old))} → "
                f"{_when(changes['end']['new'], tz, bool(all_day_new))}"
            )
        else:
            parts.append("Now all day" if all_day_new else "No longer all day")
    if "location" in changes:
        parts.append(
            f"Venue: {changes['location']['old'] or '—'} → "
            f"{changes['location']['new'] or '—'}"
        )
    if {"recurrence_rule", "recurrence_dates"} & changes.keys():
        parts.append("Dates: the schedule changed")
    minor = list(
        dict.fromkeys(
            _MINOR_FIELD_NAMES[field]
            for field in changes
            if field in _MINOR_FIELD_NAMES
        )
    )
    if minor:
        prefix = "Also updated" if parts else "Updated"
        parts.append(f"{prefix}: {', '.join(minor)}")
    return "; ".join(parts)


def resolve_notify(notify: bool | None, changes: dict) -> bool:
    """Explicit admin choice wins; by default only material changes notify."""
    return bool(material_changes(changes)) if notify is None else notify


def engaged_user_ids(session: Session, event_ids: list[str]) -> dict:
    """``{user_id: first engaged event_id}`` for signed-in Going/Saved users."""
    from backend.db.models import UserEventAttendance, UserSavedEvent

    found: dict = {}
    for model in (UserEventAttendance, UserSavedEvent):
        rows = session.exec(
            select(model.user_id, model.event_id)
            .where(col(model.event_id).in_(event_ids))
            .where(col(model.user_id).is_not(None))
        ).all()
        for user_id, event_id in rows:
            found.setdefault(user_id, event_id)
    return found


def notify_event_changed(
    session: Session,
    revision: EventRevision,
    event_ids: list[str],
    actor: User | None,
    *,
    title: str | None,
    exclude_user_ids: frozenset = frozenset(),
) -> list[Notification]:
    """In-app ``event_changed`` to everyone engaged with ``event_ids``.

    The caller decides whether to notify (see ``resolve_notify``); the
    description covers every changed field.

    One notification per user (on the first occurrence they engaged with),
    deduped per revision via ``subject_key``. Returns them so the caller can
    email after commit.
    """
    if not revision.changes:
        return []
    kind = EVENT_CANCELLED if is_cancellation(revision.changes) else EVENT_CHANGED
    recipients = engaged_user_ids(session, event_ids)
    users = (
        {
            user.id: user
            for user in session.exec(
                select(User).where(col(User.id).in_(list(recipients)))
            ).all()
        }
        if recipients
        else {}
    )
    created: list[Notification] = []
    for user_id, event_id in recipients.items():
        user = users.get(user_id)
        if user is None or user.deleted_at is not None or user_id in exclude_user_ids:
            continue
        notification = Notification(
            recipient_user_id=user_id,
            # ``actor_user_id`` is required; an admin without a user row falls
            # back to the recipient (the row renders without an actor name).
            actor_user_id=actor.id if actor else user_id,
            kind=kind,
            event_id=event_id,
            subject_key=f"revision:{revision.id}",
            context=title,
            description=describe_changes(revision.changes, user.timezone)[:255],
        )
        session.add(notification)
        session.flush()
        record_delivery(session, notification.id, "app")
        created.append(notification)
    revision.notified_count = len(created)
    session.add(revision)
    return created


def admin_actor(session: Session, admin_email: str | None) -> User | None:
    """The admin's own user row, used as the notification actor."""
    from sqlmodel import func

    if not admin_email:
        return None
    return session.exec(
        select(User).where(func.lower(User.email) == admin_email.lower())
    ).first()


def enqueue_change_emails(revision: EventRevision) -> None:
    """Queue the emails for a revision's committed ``event_changed`` rows."""
    job_queue.enqueue(CHANGE_EMAILS_JOB, str(revision.id))


def deliver_change_emails(revision_id: str) -> None:
    """Job: email and push one revision's not-yet-delivered ``event_changed``
    rows to users who keep event-update emails / pushes on."""
    from sqlmodel import or_

    from backend.db.database import get_engine
    from backend.services.app_settings import (
        get_feature_email_instant,
        get_feature_push_enabled,
    )
    from backend.services.email import (
        send_event_cancelled_email,
        send_event_changed_email,
    )
    from backend.services.notification_delivery import tracked_url
    from backend.services.push_service import PushTransientError, send_push

    with Session(get_engine()) as session:
        email_on = get_feature_email_instant("schedule_updates", session)
        push_on = get_feature_push_enabled("schedule_updates", session)
        notifications = session.exec(
            select(Notification)
            .where(col(Notification.kind).in_((EVENT_CHANGED, EVENT_CANCELLED)))
            .where(Notification.subject_key == f"revision:{revision_id}")
            .where(
                or_(
                    col(Notification.emailed_at).is_(None),
                    col(Notification.pushed_at).is_(None),
                )
            )
            .with_for_update(skip_locked=True, of=Notification)
        ).all()
        for notification in notifications:
            user = session.get(User, notification.recipient_user_id)
            event = session.get(CachedEvent, notification.event_id)
            if user is None or user.deleted_at is not None or event is None:
                continue
            now = datetime.now(timezone.utc)
            cancelled = notification.kind == EVENT_CANCELLED
            if (
                email_on
                and notification.emailed_at is None
                and user.email_schedule_updates_enabled
                and (
                    send_event_cancelled_email(user, event)
                    if cancelled
                    else send_event_changed_email(
                        user, event, notification.description or ""
                    )
                )
            ):
                notification.emailed_at = now
                record_delivery(session, notification.id, "email", now, source="job")
            if (
                push_on
                and notification.pushed_at is None
                and user.push_schedule_updates_enabled
            ):
                tag = f"event-changed-{event.event_id}"
                try:
                    delivered = send_push(
                        user.id,
                        title=(
                            f"❌ Cancelled: {event.title}"
                            if cancelled
                            else f"Event updated: {event.title}"
                        ),
                        body=(
                            event.cancellation_note or "This event was cancelled."
                            if cancelled
                            else notification.description or ""
                        ),
                        url=tracked_url(
                            f"/event/{event.event_id}", notification.id, "push"
                        ),
                        tag=tag,
                        topic=tag,
                    )
                except PushTransientError:
                    delivered = 0
                if delivered:
                    notification.pushed_at = now
                    record_delivery(session, notification.id, "push", now, source="job")
            session.add(notification)
        session.commit()


job_queue.register(CHANGE_EMAILS_JOB, deliver_change_emails)


EVENT_REMOVED = "event_removed"
REMOVED_NOTICES_JOB = "event_removed_notices"


def notify_event_removed(
    session: Session,
    event_ids: list[str],
    *,
    title: str | None,
    reason: str | None = None,
    replacement_event_id: str | None = None,
    exclude_user_ids: frozenset = frozenset(),
) -> str | None:
    """In-app ``event_removed`` to everyone who saved or is going.

    The row points at the replacement event (a kept duplicate) or at no
    event, since the removed one is no longer visible. Returns the subject
    key to pass to :func:`enqueue_removed_notices` after commit, or None.
    """
    if not event_ids:
        return None
    subject_key = f"removed:{event_ids[0]}"
    recipients = engaged_user_ids(session, event_ids)
    created = False
    for user_id in recipients:
        user = session.get(User, user_id)
        if user is None or user.deleted_at is not None or user_id in exclude_user_ids:
            continue
        duplicate = session.exec(
            select(Notification.id).where(
                Notification.recipient_user_id == user_id,
                Notification.kind == EVENT_REMOVED,
                Notification.subject_key == subject_key,
            )
        ).first()
        if duplicate is not None:
            continue
        notification = Notification(
            recipient_user_id=user_id,
            actor_user_id=user_id,
            kind=EVENT_REMOVED,
            event_id=replacement_event_id,
            subject_key=subject_key,
            context=title,
            description=(reason or None) and reason[:255],
        )
        session.add(notification)
        session.flush()
        record_delivery(session, notification.id, "app")
        created = True
    return subject_key if created else None


def enqueue_removed_notices(subject_key: str | None) -> None:
    if subject_key:
        job_queue.enqueue(REMOVED_NOTICES_JOB, subject_key)


def deliver_removed_notices(subject_key: str) -> None:
    """Job: email and push not-yet-delivered ``event_removed`` rows."""
    from backend.db.database import get_engine
    from backend.services.app_settings import (
        get_feature_email_instant,
        get_feature_push_enabled,
    )
    from backend.services.email import send_event_removed_email
    from backend.services.notification_delivery import tracked_url
    from backend.services.push_service import PushTransientError, send_push

    with Session(get_engine()) as session:
        email_on = get_feature_email_instant("schedule_updates", session)
        push_on = get_feature_push_enabled("schedule_updates", session)
        notifications = session.exec(
            select(Notification)
            .where(Notification.kind == EVENT_REMOVED)
            .where(Notification.subject_key == subject_key)
            .with_for_update(skip_locked=True, of=Notification)
        ).all()
        for notification in notifications:
            user = session.get(User, notification.recipient_user_id)
            if user is None or user.deleted_at is not None:
                continue
            path = f"/event/{notification.event_id}" if notification.event_id else "/"
            now = datetime.now(timezone.utc)
            if (
                email_on
                and notification.emailed_at is None
                and user.email_schedule_updates_enabled
                and send_event_removed_email(
                    user, notification.context or "", notification.description, path
                )
            ):
                notification.emailed_at = now
                record_delivery(session, notification.id, "email", now, source="job")
            if (
                push_on
                and notification.pushed_at is None
                and user.push_schedule_updates_enabled
            ):
                try:
                    delivered = send_push(
                        user.id,
                        title=f"Event removed: {notification.context or 'an event'}",
                        body=notification.description or "",
                        url=tracked_url(path, notification.id, "push"),
                        tag=subject_key,
                        topic=subject_key,
                    )
                except PushTransientError:
                    delivered = 0
                if delivered:
                    notification.pushed_at = now
                    record_delivery(session, notification.id, "push", now, source="job")
            session.add(notification)
        session.commit()


job_queue.register(REMOVED_NOTICES_JOB, deliver_removed_notices)
