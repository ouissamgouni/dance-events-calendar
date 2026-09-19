import logging
import math

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


def _validate_area(min_lat, min_lng, max_lat, max_lng) -> None:
    if None in (min_lat, min_lng, max_lat, max_lng):
        raise HTTPException(
            status_code=400,
            detail="Interest profile requires min_lat/min_lng/max_lat/max_lng",
        )
    if min_lat >= max_lat or min_lng >= max_lng:
        raise HTTPException(status_code=400, detail="Invalid area: min must be < max")


def _radius_bbox(center_lat: float, center_lng: float, radius_km: float):
    lat_delta = radius_km / 111.0
    cos_lat = math.cos(math.radians(center_lat))
    lng_delta = radius_km / (111.0 * cos_lat) if abs(cos_lat) > 1e-6 else 180.0
    return (
        max(-90.0, center_lat - lat_delta),
        max(-180.0, center_lng - lng_delta),
        min(90.0, center_lat + lat_delta),
        min(180.0, center_lng + lng_delta),
    )


def _resolved_geo(
    geo_kind,
    min_lat,
    min_lng,
    max_lat,
    max_lng,
    center_lat,
    center_lng,
    radius_km,
):
    if geo_kind == "radius":
        if None in (center_lat, center_lng, radius_km):
            raise HTTPException(
                status_code=400,
                detail="Radius profile requires center_lat/center_lng/radius_km",
            )
        min_lat, min_lng, max_lat, max_lng = _radius_bbox(
            center_lat, center_lng, radius_km
        )
    else:
        _validate_area(min_lat, min_lng, max_lat, max_lng)
        center_lat = center_lng = radius_km = None
    return min_lat, min_lng, max_lat, max_lng, center_lat, center_lng, radius_km


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


def _reach_filter_from_tag_ids(session: Session, tag_ids: list[int]) -> str:
    if not tag_ids:
        return "any"
    slugs = set(
        session.exec(
            select(Tag.slug)
            .join(TagGroup, TagGroup.id == Tag.group_id)
            .where(TagGroup.slug == "reach", Tag.id.in_(tag_ids))
        ).all()
    )
    if "local" in slugs:
        return "any"
    if "regional" in slugs:
        return "regional_plus"
    return "international" if "international" in slugs else "any"


def _reach_tag_ids_for_filter(session: Session, reach_filter: str) -> list[int]:
    if reach_filter == "any":
        return []
    slugs = ["international"]
    if reach_filter == "regional_plus":
        slugs.append("regional")
    return sorted(
        int(tag_id)
        for tag_id in session.exec(
            select(Tag.id)
            .join(TagGroup, TagGroup.id == Tag.group_id)
            .where(
                TagGroup.slug == "reach",
                Tag.slug.in_(slugs),
                Tag.enabled == True,  # noqa: E712
            )
        ).all()
    )


def _serialize_profile(
    session: Session, profile: UserInterestProfile
) -> InterestProfileResponse:
    dance_tag_ids, reach_tag_ids = _load_profile_tag_ids(session, profile.id)
    return InterestProfileResponse(
        id=profile.id,
        label=profile.label,
        area_label=profile.area_label,
        geo_kind=profile.geo_kind,
        min_lat=profile.min_lat,
        min_lng=profile.min_lng,
        max_lat=profile.max_lat,
        max_lng=profile.max_lng,
        center_lat=profile.center_lat,
        center_lng=profile.center_lng,
        radius_km=profile.radius_km,
        dance_tag_ids=dance_tag_ids,
        reach_filter=profile.reach_filter,
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
    geo = _resolved_geo(
        payload.geo_kind,
        payload.min_lat,
        payload.min_lng,
        payload.max_lat,
        payload.max_lng,
        payload.center_lat,
        payload.center_lng,
        payload.radius_km,
    )
    dance_ids = _validate_tag_ids(session, payload.dance_tag_ids)
    legacy_reach_ids = _validate_tag_ids(session, payload.reach_tag_ids)
    reach_filter = payload.reach_filter or _reach_filter_from_tag_ids(
        session, legacy_reach_ids
    )
    reach_ids = _reach_tag_ids_for_filter(session, reach_filter)

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
        area_label=payload.area_label or payload.label,
        geo_kind=payload.geo_kind,
        min_lat=geo[0],
        min_lng=geo[1],
        max_lat=geo[2],
        max_lng=geo[3],
        center_lat=geo[4],
        center_lng=geo[5],
        radius_km=geo[6],
        reach_filter=reach_filter,
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

    geo_kind = payload.geo_kind if "geo_kind" in fields_set else profile.geo_kind
    min_lat = payload.min_lat if "min_lat" in fields_set else profile.min_lat
    min_lng = payload.min_lng if "min_lng" in fields_set else profile.min_lng
    max_lat = payload.max_lat if "max_lat" in fields_set else profile.max_lat
    max_lng = payload.max_lng if "max_lng" in fields_set else profile.max_lng
    center_lat = (
        payload.center_lat if "center_lat" in fields_set else profile.center_lat
    )
    center_lng = (
        payload.center_lng if "center_lng" in fields_set else profile.center_lng
    )
    radius_km = payload.radius_km if "radius_km" in fields_set else profile.radius_km
    geo_fields = {
        "geo_kind",
        "min_lat",
        "min_lng",
        "max_lat",
        "max_lng",
        "center_lat",
        "center_lng",
        "radius_km",
    }
    if geo_fields & fields_set:
        geo = _resolved_geo(
            geo_kind,
            min_lat,
            min_lng,
            max_lat,
            max_lng,
            center_lat,
            center_lng,
            radius_km,
        )
        min_lat, min_lng, max_lat, max_lng, center_lat, center_lng, radius_km = geo

    if "label" in fields_set:
        profile.label = payload.label
    if "area_label" in fields_set:
        profile.area_label = payload.area_label
    profile.geo_kind = geo_kind
    profile.min_lat = min_lat
    profile.min_lng = min_lng
    profile.max_lat = max_lat
    profile.max_lng = max_lng
    profile.center_lat = center_lat
    profile.center_lng = center_lng
    profile.radius_km = radius_km
    if "matches_enabled" in fields_set and payload.matches_enabled is not None:
        profile.matches_enabled = payload.matches_enabled
    # Legacy alias — accept the older key for one release.
    if "notify_enabled" in fields_set and payload.notify_enabled is not None:
        profile.matches_enabled = payload.notify_enabled
    if "reach_filter" in fields_set and payload.reach_filter is not None:
        profile.reach_filter = payload.reach_filter

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

    if (
        "dance_tag_ids" in fields_set
        or "reach_tag_ids" in fields_set
        or "reach_filter" in fields_set
    ):
        dance_ids, reach_ids = _load_profile_tag_ids(session, profile.id)
        if "dance_tag_ids" in fields_set:
            dance_ids = _validate_tag_ids(session, payload.dance_tag_ids or [])
        if "reach_filter" in fields_set and payload.reach_filter is not None:
            reach_ids = _reach_tag_ids_for_filter(session, payload.reach_filter)
        elif "reach_tag_ids" in fields_set:
            legacy_reach_ids = _validate_tag_ids(session, payload.reach_tag_ids or [])
            profile.reach_filter = _reach_filter_from_tag_ids(session, legacy_reach_ids)
            reach_ids = _reach_tag_ids_for_filter(session, profile.reach_filter)
            session.add(profile)
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
    if profile.is_active:
        raise HTTPException(
            status_code=400,
            detail="To delete the default profile, set another profile as default first.",
        )
    session.exec(
        delete(UserInterestProfileTag).where(
            UserInterestProfileTag.profile_id == profile.id
        )
    )
    session.delete(profile)
    session.commit()
