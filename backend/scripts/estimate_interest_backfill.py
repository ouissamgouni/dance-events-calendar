"""READ-ONLY: estimate interest-notification backfill flooding.

Mirrors ``interest_notification_service._candidate_events`` +
``_load_active_profiles`` + tag/geo matching, but with a caller-supplied
lookback window (default 90d), so we can preview how many
``interest_event`` rows a wide first-tick backfill would create in prod.

Also reports which users would actually receive an email/push, per
per-user channel gates (``email_interest_matches_enabled`` /
``push_interest_matches_enabled``).

Because the activity digest coalesces all pending rows per user into one
email/push, the per-user match count IS the per-user notification burden
for that first tick.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from backend.db.database import get_engine
from backend.db.models import (
    CachedEvent,
    EventTag,
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
)


def _utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _geo_match(profile: UserInterestProfile, lat: float, lng: float) -> bool:
    if None in (profile.min_lat, profile.min_lng, profile.max_lat, profile.max_lng):
        return False
    return (
        profile.min_lat <= lat <= profile.max_lat
        and profile.min_lng <= lng <= profile.max_lng
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--lookback-days",
        type=int,
        default=90,
        help="Backfill window in days (default 90).",
    )
    args = p.parse_args()

    now = _utcnow_naive()
    since = now - timedelta(days=args.lookback_days)

    with Session(get_engine()) as session:
        # 1. Candidate events (mirror _candidate_events but with wide window).
        events = session.exec(
            select(CachedEvent)
            .where(CachedEvent.deleted_at.is_(None))  # type: ignore[union-attr]
            .where(CachedEvent.is_hidden == False)  # noqa: E712
            .where(CachedEvent.updated_at > since)
            .where(CachedEvent.updated_at <= now)
            .where(CachedEvent.start > now)
            .where(CachedEvent.latitude.is_not(None))  # type: ignore[union-attr]
            .where(CachedEvent.longitude.is_not(None))  # type: ignore[union-attr]
        ).all()

        # 2. Enabled profiles + user.
        profiles = session.exec(
            select(UserInterestProfile, User)
            .join(User, User.id == UserInterestProfile.user_id)  # type: ignore[arg-type]
            .where(UserInterestProfile.matches_enabled == True)  # noqa: E712
            .where(User.deleted_at.is_(None))  # type: ignore[union-attr]
        ).all()

        # 3. Event tag map.
        event_ids = [e.event_id for e in events]
        event_tags: dict[str, set[int]] = {}
        if event_ids:
            for eid, tid in session.exec(
                select(EventTag.event_id, EventTag.tag_id).where(
                    EventTag.event_id.in_(event_ids)  # type: ignore[union-attr]
                )
            ).all():
                event_tags.setdefault(eid, set()).add(int(tid))

        # 4. Profile tags split by reach vs dance.
        reach_group_id = session.exec(
            select(TagGroup.id).where(TagGroup.slug == "reach")
        ).first()
        profile_ids = [pr.id for pr, _ in profiles]
        profile_tags: dict[int, tuple[set[int], set[int]]] = {
            pid: (set(), set()) for pid in profile_ids
        }
        if profile_ids:
            for pid, tid, gid in session.exec(
                select(UserInterestProfileTag.profile_id, Tag.id, Tag.group_id)
                .join(Tag, Tag.id == UserInterestProfileTag.tag_id)  # type: ignore[arg-type]
                .where(UserInterestProfileTag.profile_id.in_(profile_ids))  # type: ignore[union-attr]
            ).all():
                dance, reach = profile_tags[pid]
                if reach_group_id is not None and gid == reach_group_id:
                    reach.add(int(tid))
                else:
                    dance.add(int(tid))

        # 5. Match per (user, event).
        per_user_events: dict[int, set[str]] = {}
        per_user_obj: dict[int, User] = {}
        profiles_no_dance = 0
        for profile, user in profiles:
            per_user_obj[user.id] = user
            dance_ids, reach_ids = profile_tags.get(profile.id, (set(), set()))
            if not dance_ids:
                profiles_no_dance += 1
                continue
            for event in events:
                tags = event_tags.get(event.event_id, set())
                if not (dance_ids & tags):
                    continue
                if reach_ids and not (reach_ids & tags):
                    continue
                if not _geo_match(profile, event.latitude, event.longitude):
                    continue
                per_user_events.setdefault(user.id, set()).add(event.event_id)

        # 6. Aggregate totals + channel breakdown.
        total_users_prod = session.exec(
            select(User).where(User.deleted_at.is_(None))
        ).all()
        total_users_ct = len(total_users_prod)

        users_with_profile = {u.id for _p, u in profiles}
        users_with_matches = set(per_user_events.keys())

        rows_created = sum(len(v) for v in per_user_events.values())

        email_recipients = 0
        push_recipients = 0
        neither = 0
        email_rows = 0
        push_rows = 0
        for uid, ev_ids in per_user_events.items():
            u = per_user_obj[uid]
            gets_email = bool(getattr(u, "email_interest_matches_enabled", True))
            gets_push = bool(getattr(u, "push_interest_matches_enabled", True))
            if gets_email:
                email_recipients += 1
                email_rows += len(ev_ids)
            if gets_push:
                push_recipients += 1
                push_rows += len(ev_ids)
            if not gets_email and not gets_push:
                neither += 1

        # 7. Per-user match count histogram.
        counts = sorted(len(v) for v in per_user_events.values())

        def _pct(p: float) -> int:
            if not counts:
                return 0
            k = max(0, min(len(counts) - 1, int(round(p * (len(counts) - 1)))))
            return counts[k]

        histo = Counter()
        for c in counts:
            if c == 0:
                bucket = "0"
            elif c <= 5:
                bucket = "1-5"
            elif c <= 20:
                bucket = "6-20"
            elif c <= 50:
                bucket = "21-50"
            elif c <= 100:
                bucket = "51-100"
            else:
                bucket = "100+"
            histo[bucket] += 1

        print(
            "Backfill window          :",
            f"{args.lookback_days}d (since {since.isoformat(timespec='minutes')}Z)",
        )
        print("Candidate events         :", len(events))
        print(
            "Active profiles          :",
            len(profiles),
            f"(skipped no-dance-tag: {profiles_no_dance})",
        )
        print()
        print("Users total (non-deleted):", total_users_ct)
        print("Users w/ active profile  :", len(users_with_profile))
        print("Users w/ ≥1 match        :", len(users_with_matches))
        print()
        print("If backfill runs, per-channel delivery (single digest each):")
        print(
            "  → email digests to     :",
            email_recipients,
            f"users, {email_rows} total rows coalesced",
        )
        print(
            "  → push digests to      :",
            push_recipients,
            f"users, {push_rows} total rows coalesced",
        )
        print("  → neither (in-app only):", neither, "users")
        print()
        print("Per-user match count distribution (rows per digest):")
        if counts:
            print(
                f"  min / p50 / p90 / p95 / max : {counts[0]} / {_pct(0.5)} / {_pct(0.9)} / {_pct(0.95)} / {counts[-1]}"
            )
            print(f"  mean                        : {sum(counts) / len(counts):.1f}")
        for bucket in ("1-5", "6-20", "21-50", "51-100", "100+"):
            if histo[bucket]:
                print(f"  {bucket:<8} rows/user           : {histo[bucket]} users")
        print()
        print("Total notification rows would create:", rows_created)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
