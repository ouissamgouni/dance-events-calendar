import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, delete, select

from backend.api.deps import require_user
from backend.api.schemas import (
    InterestProfileRequest,
    InterestProfileResponse,
    InterestProfileUpdateRequest,
)
from backend.db.database import get_session
from backend.db.models import (
    Tag,
    TagGroup,
    User,
    UserInterestProfile,
    UserInterestProfileTag,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/interest-profiles", tags=["interest-profiles"])


def _validate_tag_ids(session: Session, tag_ids: list[int]) -> list[int]:
    """Return a deduped list of tag IDs that exist and are enabled.

    Mirrors ``auth._validate_tag_ids`` — fail loudly rather than silently
    dropping a profile's tags.
    """
    if not tag_ids:
        return []
    deduped = list(dict.fromkeys(int(t) for t in tag_ids))
    rows = session.exec(
        select(Tag.id).where(Tag.id.in_(deduped), Tag.enabled == True)  # noqa: E712
    ).all()
    found = {row for row in rows}
    missing = [t for t in deduped if t not in found]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown or disabled tag IDs: {missing}"
        )
    return deduped


def _validate_geo(min_lat, min_lng, max_lat, max_lng) -> None:
    if None in (min_lat, min_lng, max_lat, max_lng):
        raise HTTPException(
            status_code=400,
            detail="Interest profile requires min_lat/min_lng/max_lat/max_lng",
        )
    if min_lat >= max_lat or min_lng >= max_lng:
        raise HTTPException(status_code=400, detail="Invalid area: min must be < max")


def _load_profile_tag_ids(
    session: Session, profile_id: int
) -> tuple[list[int], list[int]]:
    """Return (dance_tag_ids, reach_tag_ids) for a profile, split by group slug."""
    rows = session.exec(
        select(Tag.id, Tag.group_id)
        .join(UserInterestProfileTag, UserInterestProfileTag.tag_id == Tag.id)
        .where(UserInterestProfileTag.profile_id == profile_id)
    ).all()
    if not rows:
        return [], []
    reach_group_id = session.exec(
        select(TagGroup.id).where(TagGroup.slug == "reach")
    ).first()
    dance_ids = []
    reach_ids = []
    for tag_id, group_id in rows:
        if reach_group_id is not None and group_id == reach_group_id:
            reach_ids.append(int(tag_id))
        else:
            dance_ids.append(int(tag_id))
    return sorted(dance_ids), sorted(reach_ids)


def _serialize_profile(
    session: Session, profile: UserInterestProfile
) -> InterestProfileResponse:
    dance_tag_ids, reach_tag_ids = _load_profile_tag_ids(session, profile.id)
    return InterestProfileResponse(
        id=profile.id,
        label=profile.label,
        min_lat=profile.min_lat,
        min_lng=profile.min_lng,
        max_lat=profile.max_lat,
        max_lng=profile.max_lng,
        dance_tag_ids=dance_tag_ids,
        reach_tag_ids=reach_tag_ids,
        matches_enabled=profile.matches_enabled,
        # Legacy alias mirror (removed in cleanup PR).
        notify_enabled=profile.matches_enabled,
        is_active=profile.is_active,
        created_at=profile.created_at,
    )


def _deactivate_other_profiles(
    session: Session, user: User, keep_id: int | None
) -> None:
    """Ensure at most one active profile per user.

    Unsets ``is_active`` on every profile owned by ``user`` except
    ``keep_id`` (which may be None to clear all).
    """
    rows = session.exec(
        select(UserInterestProfile).where(
            UserInterestProfile.user_id == user.id,
            UserInterestProfile.is_active == True,  # noqa: E712
        )
    ).all()
    for row in rows:
        if row.id != keep_id:
            row.is_active = False
            session.add(row)


def _get_owned_profile(
    session: Session, user: User, profile_id: int
) -> UserInterestProfile:
    profile = session.get(UserInterestProfile, profile_id)
    if profile is None or profile.user_id != user.id:
        raise HTTPException(status_code=404, detail="Interest profile not found")
    return profile


def _replace_profile_tags(
    session: Session, profile_id: int, tag_ids: list[int]
) -> None:
    session.exec(
        delete(UserInterestProfileTag).where(
            UserInterestProfileTag.profile_id == profile_id
        )
    )
    for tid in tag_ids:
        session.add(UserInterestProfileTag(profile_id=profile_id, tag_id=tid))


@router.get("", response_model=list[InterestProfileResponse])
def list_interest_profiles(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    profiles = session.exec(
        select(UserInterestProfile)
        .where(UserInterestProfile.user_id == user.id)
        .order_by(UserInterestProfile.created_at)
    ).all()
    return [_serialize_profile(session, p) for p in profiles]


@router.post("", response_model=InterestProfileResponse, status_code=201)
def create_interest_profile(
    payload: InterestProfileRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    _validate_geo(
        payload.min_lat,
        payload.min_lng,
        payload.max_lat,
        payload.max_lng,
    )
    dance_ids = _validate_tag_ids(session, payload.dance_tag_ids)
    reach_ids = _validate_tag_ids(session, payload.reach_tag_ids)

    # First profile is auto-active regardless of payload flag; otherwise
    # respect the flag.
    existing_count = session.exec(
        select(UserInterestProfile.id).where(UserInterestProfile.user_id == user.id)
    ).first()
    is_active = True if existing_count is None else payload.is_active

    # Accept legacy ``notify_enabled`` alias for one release.
    matches_enabled = (
        payload.notify_enabled
        if payload.notify_enabled is not None
        else payload.matches_enabled
    )

    profile = UserInterestProfile(
        user_id=user.id,
        label=payload.label,
        min_lat=payload.min_lat,
        min_lng=payload.min_lng,
        max_lat=payload.max_lat,
        max_lng=payload.max_lng,
        matches_enabled=matches_enabled,
        is_active=is_active,
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)

    if is_active:
        _deactivate_other_profiles(session, user, keep_id=profile.id)
        session.commit()

    _replace_profile_tags(session, profile.id, dance_ids + reach_ids)
    session.commit()

    return _serialize_profile(session, profile)


@router.patch("/{profile_id}", response_model=InterestProfileResponse)
def update_interest_profile(
    profile_id: int,
    payload: InterestProfileUpdateRequest,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    profile = _get_owned_profile(session, user, profile_id)
    fields_set = payload.model_fields_set

    min_lat = payload.min_lat if "min_lat" in fields_set else profile.min_lat
    min_lng = payload.min_lng if "min_lng" in fields_set else profile.min_lng
    max_lat = payload.max_lat if "max_lat" in fields_set else profile.max_lat
    max_lng = payload.max_lng if "max_lng" in fields_set else profile.max_lng

    if {"min_lat", "min_lng", "max_lat", "max_lng"} & fields_set:
        _validate_geo(min_lat, min_lng, max_lat, max_lng)

    if "label" in fields_set:
        profile.label = payload.label
    profile.min_lat = min_lat
    profile.min_lng = min_lng
    profile.max_lat = max_lat
    profile.max_lng = max_lng
    if "matches_enabled" in fields_set and payload.matches_enabled is not None:
        profile.matches_enabled = payload.matches_enabled
    # Legacy alias — accept the older key for one release.
    if "notify_enabled" in fields_set and payload.notify_enabled is not None:
        profile.matches_enabled = payload.notify_enabled

    if "is_active" in fields_set:
        if payload.is_active is True:
            profile.is_active = True
            session.add(profile)
            session.commit()
            _deactivate_other_profiles(session, user, keep_id=profile.id)
        elif payload.is_active is False and profile.is_active:
            raise HTTPException(
                status_code=400,
                detail="Cannot deactivate the active profile directly; activate another profile instead.",
            )

    session.add(profile)
    session.commit()

    if "dance_tag_ids" in fields_set or "reach_tag_ids" in fields_set:
        dance_ids, reach_ids = _load_profile_tag_ids(session, profile.id)
        if "dance_tag_ids" in fields_set:
            dance_ids = _validate_tag_ids(session, payload.dance_tag_ids or [])
        if "reach_tag_ids" in fields_set:
            reach_ids = _validate_tag_ids(session, payload.reach_tag_ids or [])
        _replace_profile_tags(session, profile.id, dance_ids + reach_ids)
        session.commit()

    session.refresh(profile)
    return _serialize_profile(session, profile)


@router.delete("/{profile_id}", status_code=204)
def delete_interest_profile(
    profile_id: int,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
):
    profile = _get_owned_profile(session, user, profile_id)
    was_active = profile.is_active
    session.exec(
        delete(UserInterestProfileTag).where(
            UserInterestProfileTag.profile_id == profile.id
        )
    )
    session.delete(profile)
    session.commit()

    # If we just deleted the active profile, promote the oldest remaining.
    if was_active:
        next_active = session.exec(
            select(UserInterestProfile)
            .where(UserInterestProfile.user_id == user.id)
            .order_by(UserInterestProfile.created_at, UserInterestProfile.id)
        ).first()
        if next_active is not None:
            next_active.is_active = True
            session.add(next_active)
            session.commit()
