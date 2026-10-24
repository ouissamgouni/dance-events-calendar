"""Turn interest alerts on for users whose onboarding left them off by accident.

Until the onboarding fix, the "New event alerts" toggle was pre-filled from the
signup bootstrap profile (``matches_enabled=False``), so most users onboarded
since the new flow shipped (2026-08-24) never got interest matches. This flips
``matches_enabled`` on their active profile. Email/push interest-match flags on
``User`` are left untouched and still gate delivery.

Usage:
    python -m backend.scripts.backfill_interest_alerts --dry-run
    python -m backend.scripts.backfill_interest_alerts --commit
"""

import argparse
from datetime import datetime, timezone

from sqlmodel import Session, col, select

from backend.db.database import get_engine
from backend.db.models import User, UserInterestProfile

ONBOARDING_FLOW_RELEASE = datetime(2026, 8, 24, tzinfo=timezone.utc)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--commit", action="store_true")
    args = parser.parse_args()

    with Session(get_engine()) as session:
        rows = session.exec(
            select(UserInterestProfile, User)
            .join(User, User.id == UserInterestProfile.user_id)
            .where(UserInterestProfile.is_active == True)  # noqa: E712
            .where(UserInterestProfile.matches_enabled == False)  # noqa: E712
            .where(col(User.deleted_at).is_(None))
            .where(col(User.onboarded_at).is_not(None))
            .where(User.created_at >= ONBOARDING_FLOW_RELEASE)
            .order_by(User.created_at)
        ).all()
        for profile, user in rows:
            print(
                f"{user.handle or user.id}\tjoined {user.created_at:%Y-%m-%d}"
                f"\tprofile {profile.id} {profile.label!r} ({profile.area_label})"
            )
            if args.commit:
                profile.matches_enabled = True
                session.add(profile)
        if args.commit:
            session.commit()
        print(f"{'Updated' if args.commit else 'Would update'} {len(rows)} profile(s)")


if __name__ == "__main__":
    main()
