"""Post-signup bootstrapping helpers.

Keeps user-lifecycle side-effects out of the auth route so the same
logic can also be invoked from data migrations and tests.
"""

from __future__ import annotations

from sqlmodel import Session, select

from backend.db.models import (
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
)

# Frontend keeps the canonical copy in ``frontend/src/constants/area.ts``.
# We duplicate the numbers here rather than import a JSON fixture — they
# change rarely and always together with a coordinated frontend release.
DEFAULT_AREA_BBOX = {
    "min_lat": 24.0,
    "min_lng": -18.0,
    "max_lat": 69.0,
    "max_lng": 50.0,
    "label": "Europe & nearby",
}


def ensure_default_interest_profile(
    session: Session, user: User
) -> UserInterestProfile | None:
    """Guarantee the user owns at least one InterestProfile row.

    Every signed-in user surface (Explorer defaults, For You, alerts)
    reads from the profile list — see design note in the Interest
    Profiles PRD §12 (unified prefs+profiles). We create a permissive
    default with ``matches_enabled=False`` so first sign-in never emails
    the user until they opt in through onboarding or Settings.

    Idempotent: returns ``None`` when a profile already exists so the
    caller can rely on it in migrations and re-signup flows.
    """
    existing = session.exec(
        select(UserInterestProfile.id).where(UserInterestProfile.user_id == user.id)
    ).first()
    if existing is not None:
        return None

    profile = UserInterestProfile(
        user_id=user.id,
        label="Default",
        min_lat=DEFAULT_AREA_BBOX["min_lat"],
        min_lng=DEFAULT_AREA_BBOX["min_lng"],
        max_lat=DEFAULT_AREA_BBOX["max_lat"],
        max_lng=DEFAULT_AREA_BBOX["max_lng"],
        matches_enabled=False,
        is_active=True,
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)

    # Seed reach=international if the tag exists so the "wide area" is
    # not paired with implicit local matching.
    international_tag_id = session.exec(
        select(Tag.id)
        .join(TagGroup, TagGroup.id == Tag.group_id)
        .where(
            TagGroup.slug == "reach", Tag.slug == "international", Tag.enabled.is_(True)
        )
    ).first()
    if international_tag_id is not None:
        session.add(
            UserInterestProfileTag(
                profile_id=profile.id, tag_id=int(international_tag_id)
            )
        )
        session.commit()

    return profile
