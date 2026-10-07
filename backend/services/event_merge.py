"""Merge duplicate events into one kept event.

The kept event takes the chosen value of each field; people's saves, Going,
reviews, messages and pictures move over; the other events are removed with
reason ``merged`` and their URLs redirect to the kept one. Not reversible.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, col, func, select

from backend.db.models import (
    BlockedEvent,
    CachedEvent,
    EventDuplicateGroup,
    EventDuplicateMember,
    EventMessage,
    EventPromoCode,
    EventRating,
    EventRatingAspectScore,
    EventRatingAspectTag,
    EventRevision,
    EventSeriesMember,
    EventUserAsset,
    MyPlanShareToken,
    TagSuggestion,
    UserEventAttendance,
    UserEventMute,
    UserPlanAudience,
    UserSavedEvent,
)
from backend.services import event_revisions
from backend.services.event_images import resolve_event_image
from backend.services.event_visibility import (
    REASON_MERGED,
    STATUS_REMOVED,
    is_private,
    set_event_status,
)

MAX_EVENTS = 6

# Merge choice -> the event columns it carries.
FIELD_COLUMNS: dict[str, tuple[str, ...]] = {
    "title": ("title",),
    "description": ("description",),
    "location": ("location", "latitude", "longitude"),
    "time": ("start", "end", "all_day", "timezone"),
    "links": ("links",),
    "price": ("price_min", "price_max", "price_currency", "price_is_free"),
    "picture": ("image_key", "image_url"),
}
FIELD_LABELS = {
    "title": "Title",
    "description": "Description",
    "location": "Venue",
    "time": "Date & time",
    "links": "Links",
    "price": "Price",
    "picture": "Picture",
}


class MergeError(ValueError):
    pass


def _series_key(session: Session, event: CachedEvent):
    if event.suggestion_id is not None:
        return ("suggestion", event.suggestion_id)
    member = session.exec(
        select(EventSeriesMember).where(EventSeriesMember.event_id == event.event_id)
    ).first()
    return ("series", member.series_id) if member else None


def load_events(session: Session, event_ids: list[str]) -> list[CachedEvent]:
    ids = list(dict.fromkeys(event_ids))
    if len(ids) < 2:
        raise MergeError("Pick at least two events to merge")
    if len(ids) > MAX_EVENTS:
        raise MergeError(f"At most {MAX_EVENTS} events can be merged at once")
    events = []
    for event_id in ids:
        event = session.get(CachedEvent, event_id)
        if event is None:
            raise MergeError(f"Event {event_id} not found")
        if event.status == STATUS_REMOVED:
            raise MergeError(f"{event.title} is removed")
        if is_private(event):
            raise MergeError(f"{event.title} is private")
        events.append(event)
    keys = [k for k in (_series_key(session, e) for e in events) if k is not None]
    if len(keys) != len(set(keys)):
        raise MergeError("Dates of the same series can't be merged")
    return events


def _value(event: CachedEvent, key: str):
    if key == "picture":
        _full, thumb = resolve_event_image(event)
        return thumb or _full
    columns = FIELD_COLUMNS[key]
    if len(columns) == 1 or key == "location":
        return event_revisions.to_json(getattr(event, columns[0]))
    return {c: event_revisions.to_json(getattr(event, c)) for c in columns}


def _counts(session: Session, event_id: str) -> dict[str, int]:
    def count(model, *where) -> int:
        return session.exec(
            select(func.count())
            .select_from(model)
            .where(model.event_id == event_id, *where)
        ).one()

    return {
        "saved": count(UserSavedEvent),
        "going": count(UserEventAttendance),
        "reviews": count(EventRating),
        "messages": count(EventMessage, col(EventMessage.deleted_at).is_(None)),
        "pictures": count(EventUserAsset),
        "promo_codes": count(EventPromoCode, EventPromoCode.status != "rejected"),
    }


def preview(session: Session, event_ids: list[str]) -> dict:
    events = load_events(session, event_ids)
    values = {e.event_id: {k: _value(e, k) for k in FIELD_COLUMNS} for e in events}
    fields = [
        {
            "key": key,
            "label": FIELD_LABELS[key],
            "identical": len({repr(values[e.event_id][key]) for e in events}) == 1,
        }
        for key in FIELD_COLUMNS
    ]
    tag_ids = {
        e.event_id: event_revisions.current_tag_ids(session, e.event_id) for e in events
    }
    affected = event_revisions.engaged_user_ids(session, [e.event_id for e in events])
    return {
        "events": [
            {
                "event_id": e.event_id,
                "calendar_id": e.calendar_id,
                "status": e.status,
                "is_submission": e.suggestion_id is not None,
                "values": values[e.event_id],
                "tag_ids": tag_ids[e.event_id],
                "counts": _counts(session, e.event_id),
            }
            for e in events
        ],
        "fields": fields,
        "affected_users": len(affected),
    }


def _delete_rating(session: Session, rating: EventRating) -> None:
    for model in (EventRatingAspectScore, EventRatingAspectTag):
        for child in session.exec(
            select(model).where(model.rating_id == rating.id)
        ).all():
            session.delete(child)
    session.delete(rating)


def _move_per_user(
    session: Session, model, source_id: str, target_id: str, moved: dict, key: str
) -> None:
    """Move rows keyed by user (and device); the target's own row wins."""
    has_device = hasattr(model, "device_id")
    for row in session.exec(select(model).where(model.event_id == source_id)).all():
        clash = None
        if row.user_id is not None:
            clash = session.exec(
                select(model).where(
                    model.event_id == target_id, model.user_id == row.user_id
                )
            ).first()
        if clash is None and has_device:
            clash = session.exec(
                select(model).where(
                    model.event_id == target_id, model.device_id == row.device_id
                )
            ).first()
        if clash is not None:
            session.delete(row)
            continue
        row.event_id = target_id
        session.add(row)
        moved[key] = moved.get(key, 0) + 1


def _move_ratings(
    session: Session, source_id: str, target_id: str, moved: dict
) -> None:
    for rating in session.exec(
        select(EventRating).where(EventRating.event_id == source_id)
    ).all():
        clash = (
            session.exec(
                select(EventRating).where(
                    EventRating.event_id == target_id,
                    EventRating.user_id == rating.user_id,
                    EventRating.scope == rating.scope,
                )
            ).first()
            if rating.user_id is not None
            else None
        )
        if clash is not None:
            # The person's most recent review wins.
            if (rating.updated_at or rating.created_at) <= (
                clash.updated_at or clash.created_at
            ):
                _delete_rating(session, rating)
                continue
            _delete_rating(session, clash)
            session.flush()
        rating.event_id = target_id
        session.add(rating)
        moved["reviews"] = moved.get("reviews", 0) + 1


def _move_all(
    session: Session,
    model,
    source_id: str,
    target_id: str,
    moved: dict,
    key: str,
    *where,
) -> None:
    rows = session.exec(select(model).where(model.event_id == source_id, *where)).all()
    for row in rows:
        row.event_id = target_id
        session.add(row)
    if rows:
        moved[key] = moved.get(key, 0) + len(rows)


def _move_promo_codes(
    session: Session, source_id: str, target_id: str, moved: dict
) -> None:
    taken = {
        code.lower()
        for code in session.exec(
            select(EventPromoCode.code).where(
                EventPromoCode.event_id == target_id,
                EventPromoCode.status != "rejected",
            )
        ).all()
    }
    for promo in session.exec(
        select(EventPromoCode).where(
            EventPromoCode.event_id == source_id, EventPromoCode.status != "rejected"
        )
    ).all():
        if promo.code.lower() in taken:
            continue
        taken.add(promo.code.lower())
        promo.event_id = target_id
        session.add(promo)
        moved["promo_codes"] = moved.get("promo_codes", 0) + 1


def _resolve_duplicate_groups(
    session: Session, event_ids: list[str], target_id: str, admin_email: str | None
) -> None:
    now = datetime.now(timezone.utc)
    group_ids = set(
        session.exec(
            select(EventDuplicateMember.group_id).where(
                col(EventDuplicateMember.event_id).in_(event_ids)
            )
        ).all()
    )
    for group_id in group_ids:
        group = session.get(EventDuplicateGroup, group_id)
        if group is None or group.status != "pending":
            continue
        group.status = "resolved"
        group.kept_event_id = target_id
        group.resolved_at = now
        group.resolved_by_admin = admin_email
        session.add(group)


def merge(
    session: Session,
    *,
    target_id: str,
    event_ids: list[str],
    fields: dict[str, str],
    combine_tags: bool,
    combine_links: bool,
    note: str | None,
    notify: bool,
    admin_email: str | None,
) -> dict:
    events = load_events(session, [target_id, *event_ids])
    target, sources = events[0], events[1:]
    by_id = {e.event_id: e for e in events}
    for key, event_id in fields.items():
        if key not in FIELD_COLUMNS or event_id not in by_id:
            raise MergeError(f"Invalid choice for {key}")

    # The kept event's new values, recorded as an applied admin change.
    before = {
        c: event_revisions.to_json(getattr(target, c))
        for cs in FIELD_COLUMNS.values()
        for c in cs
    }
    after = dict(before)
    for key, event_id in fields.items():
        for column in FIELD_COLUMNS[key]:
            after[column] = event_revisions.to_json(getattr(by_id[event_id], column))
    if combine_links:
        links: list = []
        for event in events:
            for link in event.links or []:
                url = (link.get("url") if isinstance(link, dict) else None) or ""
                if url and url not in {(l.get("url") or "") for l in links}:
                    links.append(link)
        after["links"] = links or None
    changes = {
        c: {"old": before[c], "new": after[c]} for c in before if before[c] != after[c]
    }
    old_tags = event_revisions.current_tag_ids(session, target.event_id)
    if combine_tags:
        new_tags = sorted(
            {
                t
                for e in events
                for t in event_revisions.current_tag_ids(session, e.event_id)
            }
        )
        if new_tags != old_tags:
            changes[event_revisions.TAG_FIELD] = {"old": old_tags, "new": new_tags}

    # Told before rows move: who followed only a merged-away event.
    target_people = set(event_revisions.engaged_user_ids(session, [target.event_id]))
    source_ids = [e.event_id for e in sources]
    source_people = (
        set(event_revisions.engaged_user_ids(session, source_ids)) - target_people
    )
    titles = {e.event_id: e.title for e in sources}
    kept_title = after["title"]

    removed_key = None
    if notify:
        removed_key = event_revisions.notify_event_removed(
            session,
            source_ids,
            title=sources[0].title,
            reason=f"It was listed twice; your plans moved to {kept_title}.",
            replacement_event_id=target.event_id,
            exclude_user_ids=frozenset(target_people),
        )

    moved: dict[str, int] = {}
    for source in sources:
        sid = source.event_id
        _move_per_user(session, UserSavedEvent, sid, target.event_id, moved, "saved")
        _move_per_user(
            session, UserEventAttendance, sid, target.event_id, moved, "going"
        )
        _move_per_user(session, UserEventMute, sid, target.event_id, moved, "mutes")
        _move_per_user(
            session, UserPlanAudience, sid, target.event_id, moved, "plan_audiences"
        )
        _move_per_user(
            session, MyPlanShareToken, sid, target.event_id, moved, "plan_shares"
        )
        _move_ratings(session, sid, target.event_id, moved)
        _move_all(session, EventMessage, sid, target.event_id, moved, "messages")
        _move_all(session, EventUserAsset, sid, target.event_id, moved, "pictures")
        _move_all(
            session,
            TagSuggestion,
            sid,
            target.event_id,
            moved,
            "tag_suggestions",
            TagSuggestion.status == "pending",
        )
        _move_promo_codes(session, sid, target.event_id, moved)
        if target.organizer_user_id is None and source.organizer_user_id is not None:
            target.organizer_user_id = source.organizer_user_id
    session.flush()

    _resolve_duplicate_groups(
        session, [target.event_id, *source_ids], target.event_id, admin_email
    )
    now = datetime.now(timezone.utc)
    for source in sources:
        # Earlier merges into this event now point at the kept one.
        for earlier in session.exec(
            select(CachedEvent).where(
                CachedEvent.merged_into_event_id == source.event_id
            )
        ).all():
            earlier.merged_into_event_id = target.event_id
            session.add(earlier)
        source.merged_into_event_id = target.event_id
        source.rejected_duplicate_reason = (
            f"Merged into {target.event_id} — {kept_title}"
        )
        set_event_status(source, STATUS_REMOVED, REASON_MERGED)
        session.add(source)
        if session.get(BlockedEvent, source.event_id) is None:
            session.add(
                BlockedEvent(
                    event_id=source.event_id,
                    reason="merged",
                    reason_detail=source.rejected_duplicate_reason,
                )
            )

    revision = None
    if changes:
        revision = EventRevision(
            event_id=target.event_id,
            source=event_revisions.SOURCE_ADMIN,
            status=event_revisions.STATUS_DRAFT,
            changes=changes,
            proposed_by_admin_email=admin_email,
        )
        event_revisions.apply_to_event(target, changes)
        if event_revisions.TAG_FIELD in changes:
            event_revisions.replace_event_tags(
                session, target, changes[event_revisions.TAG_FIELD]["new"]
            )
        event_revisions.mark_decided(
            revision, event_revisions.STATUS_ACCEPTED, admin_email
        )
        session.add(revision)
        session.flush()
        event_revisions.supersede_overlapping(session, target.event_id, revision)

    target.merge_summary = [
        *(target.merge_summary or []),
        {
            "at": now.isoformat(),
            "by": admin_email,
            "note": (note or "").strip() or None,
            "source_ids": source_ids,
            "source_titles": titles,
            "fields": fields,
            "moved": moved,
        },
    ]
    session.add(target)

    notified = 0
    if notify and revision is not None and event_revisions.material_changes(changes):
        actor = event_revisions.admin_actor(session, admin_email)
        notified = len(
            event_revisions.notify_event_changed(
                session,
                revision,
                [target.event_id],
                actor,
                title=target.title,
                exclude_user_ids=frozenset(source_people),
            )
        )
    session.commit()
    if notified:
        event_revisions.enqueue_change_emails(revision)
    event_revisions.enqueue_removed_notices(removed_key)
    return {
        "target_event_id": target.event_id,
        "merged_event_ids": source_ids,
        "moved": moved,
        "notified": notified,
    }


def resolve_merged(session: Session, event: CachedEvent) -> str | None:
    """The live event a merged-away event now lives on, if any."""
    seen: set[str] = set()
    current = event
    while (
        current is not None
        and current.merged_into_event_id
        and current.event_id not in seen
    ):
        seen.add(current.event_id)
        current = session.get(CachedEvent, current.merged_into_event_id)
    if (
        current is None
        or current.event_id == event.event_id
        or current.status == STATUS_REMOVED
    ):
        return None
    return current.event_id
