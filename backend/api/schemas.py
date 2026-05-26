from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class LinkItem(BaseModel):
    url: str
    label: Optional[str] = None


class TagResponse(BaseModel):
    id: int
    slug: str
    label: str
    color: Optional[str] = None
    ordinal: int = 0
    group_slug: str
    group_label: str
    group_color: Optional[str] = None
    event_count: Optional[int] = None
    enabled: bool = True
    is_hero_filter: bool = False
    hero_ordinal: Optional[int] = None


class EventResponse(BaseModel):
    event_id: str
    calendar_id: str
    title: str
    description: Optional[str] = None
    location: Optional[str] = None
    start: datetime
    end: datetime
    all_day: bool = False
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    color: Optional[str] = None
    view_count: int = 0
    going_count: int = 0
    # Number of distinct users/devices who saved the event (UserSavedEvent
    # rows). Defaults to 0 so existing callers that don't compute it stay
    # backward-compatible.
    saved_count: int = 0
    # Commitment-weighted, time-decayed score used by the "Trending" badge
    # and sort. Computed by ``backend.services.popularity`` when the
    # ``trending_enabled`` site setting is on; otherwise left at 0 and the
    # frontend falls back to the legacy view-count badge.
    popularity_score: float = 0.0
    # Total count of the viewer's mutual friends who are going to or have
    # saved this event (audience-gated). Drives the pin's "people" badge.
    # Only populated when ``following_badge_enabled`` is on AND the viewer
    # is signed in; defaults to 0 otherwise so back-compat serializers
    # keep working.
    following_friend_count: int = 0
    # Up to 5 friend mini-profiles (subset of the count above), used by
    # the card's inline avatar track to show *who* — friends first, then
    # the rest of the going set. Empty when the feature flag is off or
    # the viewer is anonymous.
    following_friends_preview: list["FriendMini"] = []
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    price_currency: Optional[str] = None
    price_is_free: bool = False
    review_status: str = "reviewed"
    links: Optional[list[LinkItem]] = None
    tags: list[TagResponse] = []
    is_hidden: bool = False
    is_blocked: bool = False
    # True when the event has at least one approved, non-expired promo
    # code. Powers the small "%" badge on event cards; gated by the
    # ``promo_codes_enabled`` site setting (always False when off).
    has_active_promo_codes: bool = False
    # Verified organizer mini-profile when an admin-approved
    # OrganizerClaimEvent maps this event to a user. Gated by the
    # ``organizer_claims_enabled`` site setting (always None when off).
    organizer: Optional["EventOrganizerMini"] = None


class EventOrganizerMini(BaseModel):
    user_id: UUID
    handle: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False


class FriendMini(BaseModel):
    user_id: UUID
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class CalendarSettingResponse(BaseModel):
    calendar_id: str
    name: str
    enabled: bool
    color: Optional[str] = None


class CalendarToggleRequest(BaseModel):
    enabled: Optional[bool] = None
    color: Optional[str] = None
    name: Optional[str] = None


class CalendarAddRequest(BaseModel):
    calendar_id: str


class EventViewRequest(BaseModel):
    event_id: str
    device_id: Optional[str] = Field(default=None, max_length=64)
    source: Optional[str] = Field(
        default=None,
        pattern="^(calendar|calendar-map|explorer-list|explorer-map|my-calendar|direct)$",
    )


class EventSaveRequest(BaseModel):
    event_id: str
    device_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., pattern="^(save|unsave)$")
    # When False, the route updates only the functional UserSavedEvent state
    # and skips writing the analytics EventSave log row.
    record_analytics: bool = True
    # 3-tier audience for the saved row (public/friends/private). When None
    # on a "save" action: keep existing row's value, otherwise default to
    # ``public`` for signed-in users (frontend may pre-fill from
    # localStorage "last used"). Ignored for logged-out callers.
    audience: Optional[str] = Field(default=None, pattern="^(public|friends|private)$")


class EventAttendanceRequest(BaseModel):
    event_id: str
    device_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., pattern="^(going|not_going)$")
    record_analytics: bool = True
    # Legacy boolean. When None on a "going" action: keep the existing value
    # if the row already exists, otherwise fall back to
    # ``user.share_attendance_default``. Logged-out callers always store
    # user_id=NULL so the field is ignored for them. Prefer ``share_audience``
    # in new clients; this field is mapped to public/private when no
    # ``share_audience`` is provided.
    share_publicly: Optional[bool] = None
    # 3-tier replacement for share_publicly. Same fallback chain as above
    # but resolves to ``user.share_attendance_default_audience``.
    share_audience: Optional[str] = Field(
        default=None, pattern="^(public|friends|private)$"
    )


class AttendeeResponse(BaseModel):
    user_id: UUID
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    handle: Optional[str] = None
    # Phase E (E8): viewer's follow status toward this user, so chips/buttons
    # can render the correct "Follow" / "Following" / "Requested" state on
    # first paint (no per-attendee status fetch needed).
    viewer_follow_status: Optional[str] = None


class AttendanceSummaryResponse(BaseModel):
    """Counts for one event. The ``public_*`` and ``anonymous_*`` breakdown is
    only populated for authenticated callers — logged-out viewers see only the
    total and a flag telling them to sign in for the rest."""

    event_id: str
    total_going: int = 0
    total_saved: int = 0
    public_going: int = 0
    anonymous_going: int = 0
    can_view_attendees: bool = False
    viewer_is_sharing: bool = False
    preview_attendees: list[AttendeeResponse] = []


class AttendanceSummaryBatchRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Phase: following-interest — per-user upcoming counts used by the
# explorer's interest filter picker.
# ---------------------------------------------------------------------------


class InterestSummaryItem(BaseModel):
    """Visibility-filtered upcoming counts for a single handle.

    Counts reflect what the viewer is permitted to see (per audience
    rules); unknown handles return zeros rather than 404 so the picker
    can render a row regardless.
    """

    handle: str
    upcoming_going_visible: int = 0
    upcoming_saved_visible: int = 0


class InterestSummaryResponse(BaseModel):
    items: list[InterestSummaryItem] = []


# ---------------------------------------------------------------------------
# Phase E (E5) — friends / FoF "going" wedge for the event modal.
# ---------------------------------------------------------------------------


class FofGoingAttendee(BaseModel):
    """A friend-of-friend attendee shown in the event modal wedge.

    ``via_friend_handle`` is one of the viewer's friends who also follows
    this attendee — surfaced as the "Followed by @alice" attribution
    line. We pick a deterministic single witness (lowest handle) so
    re-renders are stable.
    """

    user_id: UUID
    handle: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    via_friend_handle: Optional[str] = None
    via_friend_display_name: Optional[str] = None
    # Phase E (E8): viewer's follow status toward this FoF attendee.
    viewer_follow_status: Optional[str] = None


class GoingWedgeResponse(BaseModel):
    """Per-event "who's going" wedge for signed-in viewers.

    - ``friends_going`` — mutual friends of the viewer, regardless of
      audience (mutual-follow grants ``friends`` visibility).
    - ``fof_going`` — attendees whose ``share_audience == 'public'``
      AND who share at least one mutual friend with the viewer.
    - ``public_going_count`` — count of public-audience attendees who
      are neither friends nor FoF (so the wedge sums consistently).

    Private-audience rows and non-public strangers are NEVER counted or
    surfaced — see PHASE_E_FRIENDSHIP_ADOPTION.md "GDPR guardrail".
    """

    event_id: str
    friends_going: list[AttendeeResponse] = []
    fof_going: list[FofGoingAttendee] = []
    public_going_count: int = 0


class UpdatePreferencesRequest(BaseModel):
    share_attendance_default: Optional[bool] = None
    # Preferred map area as a bounding box. All four floats + label must be
    # provided together (all-or-nothing); pass an explicit ``None`` for the
    # whole ``preferred_area`` field to clear the saved area. Omitting it
    # leaves the area untouched.
    preferred_area: Optional["PreferredAreaPayload"] = None
    # Preferred dance-style tag IDs (full replacement when provided).
    # Omit to leave untouched; pass [] to clear.
    preferred_tag_ids: Optional[list[int]] = None


class PreferredAreaPayload(BaseModel):
    min_lat: float = Field(..., ge=-90, le=90)
    min_lng: float = Field(..., ge=-180, le=180)
    max_lat: float = Field(..., ge=-90, le=90)
    max_lng: float = Field(..., ge=-180, le=180)
    label: str = Field(..., min_length=1, max_length=120)


class PreferredAreaResponse(BaseModel):
    min_lat: float
    min_lng: float
    max_lat: float
    max_lng: float
    label: str


class UserPreferencesResponse(BaseModel):
    """Returned by ``/api/auth/me`` and ``PATCH /api/auth/preferences``.

    ``set_at`` is null until the user (or the anon→authed merge) has
    explicitly saved preferences; the frontend uses this to suppress the
    "Save as my defaults" affordance until the user has opted in.
    """

    share_attendance_default: bool
    preferred_area: Optional[PreferredAreaResponse] = None
    preferred_tag_ids: list[int] = []
    set_at: Optional[datetime] = None


class AnonPreferencesPayload(BaseModel):
    """Optional payload included in ``POST /api/auth/google`` so anonymous
    preferences from ``localStorage`` can be merged into a fresh user row.

    Applied only when ``User.preferences_set_at IS NULL`` — never overwrites
    existing server-side prefs (a user signing in on a second device keeps
    the prefs they set on the first one).
    """

    preferred_area: Optional[PreferredAreaPayload] = None
    preferred_tag_ids: list[int] = []


class UpdateProfileRequest(BaseModel):
    """Editable identity fields surfaced on the Account page.

    ``handle`` is validated against ``HANDLE_PATTERN`` server-side; clients
    should pre-validate but the server is the source of truth.
    """

    display_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    handle: Optional[str] = Field(default=None, min_length=3, max_length=24)


class HandleAvailabilityResponse(BaseModel):
    handle: str
    available: bool
    reason: Optional[str] = None


class EventLinkClickRequest(BaseModel):
    event_id: str
    url: str = Field(..., min_length=1, max_length=2048)
    device_id: Optional[str] = Field(default=None, max_length=64)


class EventExportRequest(BaseModel):
    format: str = Field(..., pattern="^(ics|xlsx)$")
    event_count: int = Field(..., ge=0, le=10000)
    device_id: Optional[str] = Field(default=None, max_length=64)


class ShareEventRequest(BaseModel):
    """Payload for ``POST /api/track/share``.

    ``action`` distinguishes the three funnel stages so a single endpoint
    can serve all of them. ``share_code`` is required for click and
    conversion (it identifies the originating sharer); for ``share`` the
    code comes from the authenticated user's record so the field is
    ignored.
    """

    event_id: str = Field(..., min_length=1, max_length=128)
    action: str = Field(..., pattern="^(share|click|conversion)$")
    share_code: Optional[str] = Field(default=None, min_length=4, max_length=12)
    device_id: Optional[str] = Field(default=None, max_length=64)


class EventBatchRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=100)


class ExportRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=100)


class HealthResponse(BaseModel):
    status: str


# --- Promo codes ---


class PromoCodeSubmitter(BaseModel):
    user_id: UUID
    handle: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class PromoCodeOut(BaseModel):
    id: UUID
    event_id: str
    code: str
    description: Optional[str] = None
    source_url: Optional[str] = None
    expires_at: Optional[datetime] = None
    status: str
    submitter: PromoCodeSubmitter
    created_at: datetime
    updated_at: datetime


class PromoCodeAdminOut(PromoCodeOut):
    admin_notes: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    reviewed_by: Optional[str] = None
    event_title: Optional[str] = None


def _validate_source_url(value: Optional[str]) -> Optional[str]:
    if value is None:
        return value
    v = value.strip()
    if not v:
        return None
    low = v.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        raise ValueError("source_url must start with http:// or https://")
    return v


class PromoCodeCreate(BaseModel):
    code: str = Field(..., min_length=1, max_length=64)
    description: Optional[str] = Field(default=None, max_length=200)
    source_url: Optional[str] = Field(default=None, max_length=500)
    expires_at: Optional[datetime] = None

    def model_post_init(self, __context) -> None:
        _validate_source_url(self.source_url)


class PromoCodeUpdate(BaseModel):
    code: Optional[str] = Field(default=None, min_length=1, max_length=64)
    description: Optional[str] = Field(default=None, max_length=200)
    source_url: Optional[str] = Field(default=None, max_length=500)
    expires_at: Optional[datetime] = None

    def model_post_init(self, __context) -> None:
        _validate_source_url(self.source_url)


class PromoCodeReject(BaseModel):
    admin_notes: Optional[str] = Field(default=None, max_length=500)


# --- Organizer claims ---


class OrganizerClaimEventOut(BaseModel):
    event_id: str
    event_title: Optional[str] = None
    event_start: Optional[datetime] = None
    decision: str


class OrganizerClaimOut(BaseModel):
    id: UUID
    user_id: UUID
    # ``badge`` (account-level verified-organizer request) or ``events``
    # (per-event organizer attribution). See ``OrganizerClaim`` model.
    kind: str
    status: str
    admin_notes: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    reviewed_by: Optional[str] = None
    created_at: datetime
    events: list[OrganizerClaimEventOut] = []


class OrganizerClaimAdminOut(OrganizerClaimOut):
    user_handle: Optional[str] = None
    user_display_name: Optional[str] = None
    user_email: Optional[str] = None
    user_avatar_url: Optional[str] = None
    user_bio: Optional[str] = None
    user_instagram_url: Optional[str] = None
    user_facebook_url: Optional[str] = None


class OrganizerClaimCreate(BaseModel):
    # ``badge``: request the account-level verified-organizer badge.
    # Must not include ``event_ids``. Allowed only when the user is
    # not already verified and has no pending badge claim.
    #
    # ``events``: claim organizership of specific events. Requires
    # 1..20 ``event_ids``. Allowed only for already-verified users.
    kind: str = Field(default="badge", max_length=16)
    event_ids: list[str] = Field(default_factory=list, max_length=20)


class OrganizerClaimDecideRequest(BaseModel):
    grant_badge: bool = True
    approved_event_ids: list[str] = Field(default_factory=list)
    rejected_event_ids: list[str] = Field(default_factory=list)
    admin_notes: Optional[str] = Field(default=None, max_length=500)
    overwrite: bool = False


class CreateShareTokenRequest(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=64)


class ShareTokenResponse(BaseModel):
    token: str


class SharedCalendarResponse(BaseModel):
    events: list[EventResponse]
    # First name (or email-local-part fallback) of the share-token owner when
    # the token is user-scoped. None for anonymous (device-only) tokens. Used
    # by the public /shared/:token page to render "{name}'s calendar".
    owner_display_name: Optional[str] = None


class MostViewedEvent(BaseModel):
    event_id: str
    title: str
    view_count: int
    unique_viewers: int


class SourceBreakdown(BaseModel):
    source: str
    view_count: int


class CountryBreakdown(BaseModel):
    country: str
    view_count: int


class TopLink(BaseModel):
    event_id: str
    event_title: str
    url: str
    click_count: int


class ExportStat(BaseModel):
    format: str
    export_count: int
    total_events_exported: int


class SiteSettingsResponse(BaseModel):
    since_date: str
    sync_since_date: str
    sync_interval_minutes: int
    auto_sync_enabled: bool = False
    auto_sync_mode: str = "incremental"  # "incremental" | "reseed"
    show_prices: bool = False
    show_popularity: bool = False
    show_ratings: bool = False
    popularity_threshold: int = 10
    # --- Adoption-boost feature toggles (each track has its own flag so
    # rollouts can be staged independently per scenario). ---
    # Track 1: avatar badge on cards/pins for events your followed users
    # are going to or have saved.
    following_badge_enabled: bool = False
    # Track 2: per-user "seen" tracking with unseen-only filter chip.
    unseen_state_enabled: bool = False
    # Track 3: switches the popularity badge & sort from the legacy
    # view-count signal to a commitment-weighted, time-decayed score
    # (going + saved + tiny view term, decayed by event age).
    trending_enabled: bool = False
    # Trending-only knobs. ``trending_window_days`` is how far back the
    # going/saved/view counts are aggregated. ``trending_floor_going``
    # is the absolute floor of going RSVPs an event must clear to even
    # qualify for any tier (prevents view-bait from being crowned hot).
    trending_window_days: int = 30
    trending_floor_going: int = 3
    # Effective trending cap for the visible list/map:
    #   cap = min(trending_top_n, ceil(visible_count * trending_top_percent / 100))
    # ``trending_top_n`` is an absolute upper bound ("never decorate
    # more than N events as Trending"). ``trending_top_percent`` is a
    # relative ceiling so small lists don't get a Trending chip on every
    # other card (e.g. 5 visible events @ 20% → effective cap of 1).
    trending_top_n: int = 3
    trending_top_percent: int = 100
    event_color_bar_color: str = "#64748b"
    tag_sort_mode: str = "group"  # "group" | "event_count"
    # User-submitted promo codes per event (admin-moderated). When False,
    # public + user-facing promo endpoints return 404 and the event
    # section / card badge are hidden.
    promo_codes_enabled: bool = False
    # User-initiated organizer claims (badge + per-event ownership;
    # admin-moderated). When False, the Account application section
    # and event "Organized by" pill are hidden.
    organizer_claims_enabled: bool = False


class SiteSettingsUpdateRequest(BaseModel):
    since_date: Optional[str] = None
    sync_since_date: Optional[str] = None
    sync_interval_minutes: Optional[int] = Field(default=None, ge=1, le=1440)
    auto_sync_enabled: Optional[bool] = None
    auto_sync_mode: Optional[str] = Field(
        default=None, pattern="^(incremental|reseed)$"
    )
    show_prices: Optional[bool] = None
    show_popularity: Optional[bool] = None
    show_ratings: Optional[bool] = None
    popularity_threshold: Optional[int] = Field(default=None, ge=1, le=10000)
    following_badge_enabled: Optional[bool] = None
    unseen_state_enabled: Optional[bool] = None
    trending_enabled: Optional[bool] = None
    trending_window_days: Optional[int] = Field(default=None, ge=1, le=365)
    trending_floor_going: Optional[int] = Field(default=None, ge=0, le=1000)
    trending_top_n: Optional[int] = Field(default=None, ge=1, le=50)
    trending_top_percent: Optional[int] = Field(default=None, ge=1, le=100)
    event_color_bar_color: Optional[str] = Field(
        default=None, pattern="^#[0-9a-fA-F]{6}$"
    )
    tag_sort_mode: Optional[str] = Field(default=None, pattern="^(group|event_count)$")
    promo_codes_enabled: Optional[bool] = None
    organizer_claims_enabled: Optional[bool] = None


class EventUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    all_day: Optional[bool] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    price_currency: Optional[str] = None
    price_is_free: Optional[bool] = None
    links: Optional[list[LinkItem]] = None
    tag_ids: Optional[list[int]] = None
    calendar_id: Optional[str] = None
    review_status: Optional[str] = Field(default=None, pattern="^(pending|reviewed)$")
    is_hidden: Optional[bool] = None


class GeocodeSuggestion(BaseModel):
    display_name: str
    latitude: float
    longitude: float


class AppInfoResponse(BaseModel):
    environment: str
    backend_version: str
    frontend_version: Optional[str] = None
    db_schema_version: Optional[str] = None
    qa_scenarios: list[str] = []
    analytics_enabled: bool = True


# --- Event Suggestions ---


class NewTagSuggestionItem(BaseModel):
    free_text: str = Field(..., min_length=1, max_length=100)
    group_slug: Optional[str] = Field(default=None, max_length=100)


class EventSuggestionCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    location: Optional[str] = None
    links: list[LinkItem] = Field(default_factory=list, max_length=3)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    start: datetime
    end: datetime
    all_day: bool = False
    submitter_name: Optional[str] = Field(default=None, max_length=100)
    submitter_email: Optional[str] = Field(default=None, max_length=200)
    website: str = ""  # honeypot
    screen_size: Optional[str] = None
    timezone: Optional[str] = None
    suggested_tag_ids: list[int] = Field(default_factory=list)
    suggested_new_tags: list[NewTagSuggestionItem] = Field(default_factory=list)
    price_min: Optional[float] = Field(default=None, ge=0)
    price_max: Optional[float] = Field(default=None, ge=0)
    price_currency: Optional[str] = Field(default=None, max_length=8)
    price_is_free: bool = False
    # When True (default), an approved suggestion is auto-saved to the
    # authenticated submitter's Calendar tab via UserSavedEvent. Has no
    # effect for anonymous submissions.
    auto_save: bool = True


class EventSuggestionResponse(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    location: Optional[str] = None
    links: Optional[list[LinkItem]] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    start: datetime
    end: datetime
    all_day: bool = False
    submitter_name: Optional[str] = None
    submitter_email: Optional[str] = None
    submitter_ip: Optional[str] = None
    submitter_user_agent: Optional[str] = None
    submitter_language: Optional[str] = None
    submitter_referrer: Optional[str] = None
    submitter_screen_size: Optional[str] = None
    submitter_timezone: Optional[str] = None
    submitter_city: Optional[str] = None
    submitter_country: Optional[str] = None
    submitter_lat: Optional[float] = None
    submitter_lng: Optional[float] = None
    status: str = "pending"
    admin_notes: Optional[str] = None
    assigned_calendar_id: Optional[str] = None
    created_event_id: Optional[str] = None
    synced_to_google: bool = False
    google_event_id: Optional[str] = None
    suggested_tag_ids: Optional[list[int]] = None
    suggested_new_tags: Optional[list[NewTagSuggestionItem]] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    price_currency: Optional[str] = None
    price_is_free: bool = False
    created_at: datetime
    reviewed_at: Optional[datetime] = None
    reviewed_by: Optional[str] = None


class EventSuggestionPublicResponse(BaseModel):
    id: UUID
    message: str


class SuggestionApproveRequest(BaseModel):
    calendar_id: str


class SuggestionRejectRequest(BaseModel):
    admin_notes: Optional[str] = None


class SuggestionUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    links: Optional[list[LinkItem]] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    all_day: Optional[bool] = None
    admin_notes: Optional[str] = None


# --- Tags / Categorization ---


class TagGroupResponse(BaseModel):
    id: int
    slug: str
    label: str
    color: Optional[str] = None
    ordinal: int = 0
    allow_multiple: bool = True
    enabled: bool = True
    onboarding_eligible: bool = False
    scope: str = "event"
    tags: list[TagResponse] = []


class TagGroupCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=100)
    slug: Optional[str] = Field(default=None, max_length=100)
    color: Optional[str] = None
    onboarding_eligible: bool = False
    scope: Optional[str] = Field(
        default="event",
        pattern="^(event|review)$",
        description="'event' for taxonomy/filter tags, 'review' for review-only aspect tags",
    )


class TagGroupUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=100)
    ordinal: Optional[int] = None
    allow_multiple: Optional[bool] = None
    color: Optional[str] = None
    enabled: Optional[bool] = None
    onboarding_eligible: Optional[bool] = None
    scope: Optional[str] = Field(default=None, pattern="^(event|review)$")


class TagCreate(BaseModel):
    group_id: int
    label: str = Field(..., min_length=1, max_length=100)
    slug: Optional[str] = Field(default=None, max_length=100)
    color: Optional[str] = None


class TagUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=100)
    color: Optional[str] = None
    ordinal: Optional[int] = None
    enabled: Optional[bool] = None
    is_hero_filter: Optional[bool] = None
    hero_ordinal: Optional[int] = None
    group_id: Optional[int] = None


class EventTagAssignment(BaseModel):
    tag_ids: list[int]


class TagSuggestionCreate(BaseModel):
    event_id: str
    tag_id: Optional[int] = None
    free_text: Optional[str] = Field(default=None, max_length=100)
    group_slug: Optional[str] = Field(default=None, max_length=64)
    device_id: Optional[str] = Field(default=None, max_length=64)
    website: str = ""  # honeypot


class TagSuggestionResponse(BaseModel):
    id: int
    event_id: str
    event_title: Optional[str] = None
    event_description: Optional[str] = None
    event_start: Optional[datetime] = None
    event_location: Optional[str] = None
    tag: Optional[TagResponse] = None
    free_text: Optional[str] = None
    group_slug: Optional[str] = None
    status: str = "pending"
    submitter_device_id: Optional[str] = None
    admin_notes: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: datetime
    # auto-generated suggestion metadata (NULL/'user' for legacy user submissions).
    source: str = "user"
    confidence: Optional[float] = None
    matched_terms: Optional[list[str]] = None


class TagSuggestionCountResponse(BaseModel):
    count: int


class TagSuggestionApproveRequest(BaseModel):
    tag_id: Optional[int] = (
        None  # required if free_text suggestion — admin picks/creates a tag
    )


class TagSuggestionRejectRequest(BaseModel):
    admin_notes: Optional[str] = None


class BulkTagSuggestionReviewRequest(BaseModel):
    ids: list[int]
    action: str  # 'approve' | 'reject'


class BulkTagSuggestionReviewResponse(BaseModel):
    ok: int
    skipped: int  # already-reviewed or free-text approve without tag_id


class TagSynonymResponse(BaseModel):
    id: int
    tag_id: int
    term: str
    created_at: datetime


class TagSynonymCreateRequest(BaseModel):
    term: str


class TagSuggestionRunRequest(BaseModel):
    """Body for POST /api/admin/events/{id}/suggest-tags."""

    # When True, existing pending auto suggestions for the event are deleted
    # before generating fresh ones (e.g. for the "Re-run" button).
    replace_existing_pending: bool = False


class BulkTagSuggestionRunRequest(BaseModel):
    event_ids: list[str]
    replace_existing_pending: bool = False


class TagSuggestionRunResponse(BaseModel):
    generated: int
    skipped: int
    replaced: int
    suggestions: list[TagSuggestionResponse] = []


class BulkTagSuggestionRunResponse(BaseModel):
    generated: int
    skipped: int
    replaced: int
    events_processed: int


# --- Admin Events: Paginated List & Filter Options ---


class PaginatedEventsResponse(BaseModel):
    items: list[EventResponse]
    total: int


class FilterOption(BaseModel):
    value: str
    label: str
    count: int = 0


class EventFilterOptionsResponse(BaseModel):
    calendars: list[FilterOption] = []
    review_statuses: list[FilterOption] = []
    geo_statuses: list[FilterOption] = []
    tags: list[FilterOption] = []
    total_count: int = 0


class BulkEventIdsRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=200)


class BulkTagAssignRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=200)
    tag_ids: list[int] = Field(..., min_length=1, max_length=50)


class CalendarDefaultTagsResponse(BaseModel):
    calendar_id: str
    tag_ids: list[int]


class CalendarDefaultTagsUpdate(BaseModel):
    tag_ids: list[int] = Field(..., max_length=50)


class EventIdsResponse(BaseModel):
    ids: list[str]


class SyncJobStartRequest(BaseModel):
    mode: str = Field(default="incremental", pattern="^(incremental|reseed)$")
    since_date: Optional[str] = None
    calendar_ids: list[str] = Field(default_factory=list, max_length=200)


class SyncJobListResponse(BaseModel):
    items: list[dict]
    total: int


class SyncLogResponse(BaseModel):
    id: int
    started_at: datetime
    finished_at: Optional[datetime] = None
    status: str
    trigger: str
    calendars_synced: int
    events_upserted: int
    events_deleted: int
    error_message: Optional[str] = None
    enrichment_status: str
    enrichment_progress: Optional[dict] = None
    dedup_log: Optional[list] = None

    class Config:
        from_attributes = True


# --- Ratings / Feedback ---


class TagSuggestionInline(BaseModel):
    """A tag suggestion submitted as part of a feedback envelope."""

    tag_id: Optional[int] = None
    free_text: Optional[str] = Field(default=None, max_length=100)
    group_slug: Optional[str] = Field(default=None, max_length=64)


class FeedbackSubmissionCreate(BaseModel):
    """Unified envelope: rating + optional related tag suggestions."""

    stars: int = Field(..., ge=1, le=5)
    comment: Optional[str] = Field(default=None, max_length=2000)
    review_tag_ids: list[int] = Field(default_factory=list, max_length=10)
    is_anonymous: bool = False
    tag_suggestions: list[TagSuggestionInline] = Field(
        default_factory=list, max_length=10
    )
    website: str = ""  # honeypot


class EventRatingResponse(BaseModel):
    id: UUID
    event_id: str
    stars: int
    comment: Optional[str] = None
    review_tag_ids: list[int] = []
    is_anonymous: bool = False
    status: str
    created_at: datetime
    updated_at: datetime


class FeedbackSubmissionResponse(BaseModel):
    feedback_submission_id: UUID
    rating: EventRatingResponse
    tag_suggestion_ids: list[int] = []
    message: str = "Thanks for your feedback! Your review is being checked by our team."


class EventRatingAggregate(BaseModel):
    event_id: str
    average: float = 0.0
    count: int = 0
    distribution: dict[int, int] = Field(default_factory=dict)


class EventReviewPublic(BaseModel):
    """Approved review shown publicly on the event detail page."""

    id: UUID
    stars: int
    comment: Optional[str] = None
    review_tags: list[TagResponse] = []
    reviewer_label: str  # display name, "Anonymous", or initials
    created_at: datetime


class EventReviewsListResponse(BaseModel):
    items: list[EventReviewPublic]
    total: int


class BatchAggregateRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=200)


class AdminRatingResponse(BaseModel):
    id: UUID
    event_id: str
    event_title: Optional[str] = None
    user_email: Optional[str] = None
    user_display_name: Optional[str] = None
    is_anonymous: bool = False
    stars: int
    comment: Optional[str] = None
    review_tags: list[TagResponse] = []
    feedback_submission_id: Optional[UUID] = None
    linked_tag_suggestion_ids: list[int] = []
    status: str
    admin_notes: Optional[str] = None
    submitter_ip: Optional[str] = None
    submitter_user_agent: Optional[str] = None
    submitter_country: Optional[str] = None
    auto_flagged: bool = False
    reviewed_at: Optional[datetime] = None
    reviewed_by: Optional[str] = None
    created_at: datetime


class AdminRatingListResponse(BaseModel):
    items: list[AdminRatingResponse]
    total: int
    page: int
    page_size: int


class RatingApproveRequest(BaseModel):
    admin_notes: Optional[str] = Field(default=None, max_length=500)


class RatingRejectRequest(BaseModel):
    admin_notes: Optional[str] = Field(default=None, max_length=500)


class MyRatingResponse(BaseModel):
    id: UUID
    event_id: str
    event_title: Optional[str] = None
    event_start: Optional[datetime] = None
    stars: int
    comment: Optional[str] = None
    review_tag_ids: list[int] = []
    is_anonymous: bool = False
    status: str
    created_at: datetime
    updated_at: datetime


# --- Social / friends graph (Phase A) ----------------------------------------


class MutualSubscriberPreview(BaseModel):
    """Lightweight user card embedded in PublicProfileResponse.mutual_subscribers."""

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class PublicProfileResponse(BaseModel):
    """Public-facing profile shown at /u/{handle}.

    Sensitive fields (email, share_code, provider_*) are intentionally
    omitted. ``is_following`` / ``is_friend`` / ``follows_you`` are evaluated
    relative to the requester (all False for anonymous viewers). Visibility
    flags are echoed so the client can show "private" labels for tabs the
    viewer cannot see, without leaking counts.
    """

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    # True when this profile is an admin-curated puppet account
    # (Phase: admin-managed lists). Renders a transparency badge so
    # viewers know its Saved/Going entries are editorially curated
    # rather than personal engagement.
    is_admin_managed: bool = False
    instagram_url: Optional[str] = None
    facebook_url: Optional[str] = None
    # Phase D: free-form short bio (max 280 chars). Always public when set;
    # an empty/missing value is rendered as "No bio yet" on the About tab.
    bio: Optional[str] = None
    member_since: datetime
    followers_count: int = 0
    following_count: int = 0
    # Phase B: number of users subscribed to this owner's shared calendar.
    # Public on /u/{handle} for organizer trust signals (parity with
    # YouTube/Substack subscriber counts).
    subscribers_count: int = 0
    # Phase D: count of upcoming-or-recent shared Going attendances over the
    # last 30 days. Surfaces on the profile stat row. Zero when the viewer
    # is not allowed to read attendance (no leak: same value as for a user
    # with no recent activity).
    going_count_30d: int = 0
    is_self: bool = False
    is_following: bool = False
    follows_you: bool = False
    is_friend: bool = False
    # Phase E (E8): "approved" when ``is_following`` is True; "pending"
    # when the viewer has an outstanding follow-request awaiting
    # approval (target is friends-visibility). Defaults to "approved"
    # so legacy clients don't have to handle a third state.
    follow_status: str = "approved"
    # Single account-level visibility gate ("public" | "friends"). Echoed
    # so the client can render "Friends-only" hint banners.
    account_visibility: str = "public"
    # Friend / mutual-friend counts. ``friend_count`` is the total mutual
    # follows of the owner. ``mutual_friend_count`` is the count of mutual
    # follows the *viewer* shares with the profile owner (always 0 for
    # anonymous viewers and self-views).
    friend_count: int = 0
    mutual_friend_count: int = 0
    # User's default audience for new RSVPs (mirror of
    # ``User.share_attendance_default_audience``). Only meaningful for
    # ``is_self``; for other viewers the field is included but ignored.
    share_attendance_default_audience: str = "private"
    # Phase B: surfaces the Subscribe-to-Calendar CTA state on /u/{handle}.
    # ``can_view_calendar`` short-circuits the button when the viewer would
    # be denied at write time; ``is_subscribed`` lets the UI show "Subscribed".
    can_view_calendar: bool = False
    is_subscribed: bool = False
    # When ``is_subscribed`` is True, mirrors the per-row
    # ``CalendarSubscription.notify_new_events`` flag so the profile UI can
    # render the toggle in its current state without a second round-trip.
    notify_new_events: bool = True
    # Phase D: up to 3 preview cards of users the viewer follows/subscribes
    # to who *also* subscribe to this profile owner. Empty for anonymous
    # viewers and for ``is_self``. ``mutual_subscribers_count`` is the
    # untruncated total so the UI can render "@a, @b and N others".
    mutual_subscribers: list["MutualSubscriberPreview"] = []
    mutual_subscribers_count: int = 0
    # Phase E (E10): for verified-organizer profiles only. Count of the
    # viewer's mutual friends who follow this organizer. 0 for non-organizers,
    # for anonymous viewers, and for self-views. Lets the client render a
    # "Followed by @alice +N of your friends" trust pill.
    mutual_friends_who_follow: int = 0


class FollowUserResponse(BaseModel):
    """Lightweight user row used by followers/following/friends list endpoints."""

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    is_friend: bool = False


class FollowListResponse(BaseModel):
    items: list[FollowUserResponse]
    total: int


# Phase E (E9): friends leaderboard ranked by Going count over a window.
class FriendsLeaderboardEntry(BaseModel):
    """Single row in the friends leaderboard.

    ``going_count`` is restricted to attendances visible to the viewer
    (in practice: ``share_audience`` admits the viewer — the viewer is
    a friend by definition for this endpoint, so all ``friends`` and
    ``public`` rows count; ``private`` rows do not).
    """

    rank: int
    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    going_count: int


class FriendsLeaderboardResponse(BaseModel):
    period: str  # "7d" | "30d" | "90d"
    items: list[FriendsLeaderboardEntry]


class FollowActionResponse(BaseModel):
    handle: str
    is_following: bool
    is_friend: bool
    followers_count: int
    # Follow now implies subscribe-to-calendar (Phase B): these fields
    # mirror the subscription state created/destroyed alongside the
    # UserFollow row. ``is_subscribed`` follows ``is_following`` (true on
    # follow, false on unfollow). ``notify_new_events`` defaults to True
    # at follow time and is independently toggleable via the notify PATCH.
    is_subscribed: bool = False
    notify_new_events: bool = False
    # Phase E (E8): "approved" for an active follow; "pending" when the
    # target has friends-visibility and the request awaits their
    # approval. UI uses this to show "Requested" instead of "Following".
    follow_status: str = "approved"


class FollowRequestItem(BaseModel):
    """Phase E (E8): a pending inbound follow-request row."""

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    requested_at: datetime


class FollowRequestListResponse(BaseModel):
    items: list[FollowRequestItem]


class FollowNotifyRequest(BaseModel):
    """PATCH body for /users/{handle}/follow/notify — toggles the
    notification bell on the implied calendar subscription without
    affecting the follow edge."""

    notify_new_events: bool


class UpdateVisibilityRequest(BaseModel):
    """Account-level visibility update from the Account page.

    ``account_visibility`` is the single gate (Instagram-style):
    ``public`` (anyone can view) or ``friends`` (only mutual followers).
    The default-audience picker is patched here as well so the Privacy
    section can update both fields in one round-trip.
    """

    account_visibility: Optional[str] = Field(
        default=None, pattern="^(public|friends)$"
    )
    share_attendance_default_audience: Optional[str] = Field(
        default=None, pattern="^(public|friends|private)$"
    )


class UpdateSocialLinksRequest(BaseModel):
    """Optional, unverified IG/FB profile links shown on /u/{handle}.

    Empty strings clear the value. URLs are constrained to the host of the
    respective platform so we don't accidentally surface arbitrary outbound
    links from a user's profile (low-grade phishing mitigation).
    """

    instagram_url: Optional[str] = Field(default=None, max_length=255)
    facebook_url: Optional[str] = Field(default=None, max_length=255)


class CalendarSubscriptionRequest(BaseModel):
    """Body for POST/PATCH ``/api/social/users/{handle}/subscribe``."""

    notify_new_events: bool = True


class SubscribedUser(BaseModel):
    """A user appearing in the viewer's subscriptions list."""

    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    notify_new_events: bool = True
    can_view_calendar: bool = True
    subscribed_at: datetime


class SubscriptionListResponse(BaseModel):
    items: list[SubscribedUser]
    total: int


class SubscriberUser(BaseModel):
    """A user that has subscribed to the current viewer's calendar.

    Returned only by ``GET /api/social/me/subscribers`` (owner-only). The
    minimal shape excludes ``notify_new_events`` / ``can_view_calendar``
    because those are subscriber-side concerns; from the owner's
    perspective the only useful facts are who they are and when they
    subscribed.
    """

    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    subscribed_at: datetime


class SubscriberListResponse(BaseModel):
    items: list[SubscriberUser]
    total: int


class SubscriptionActionResponse(BaseModel):
    """Echo of the resulting subscription state after a write."""

    handle: str
    is_subscribed: bool
    notify_new_events: bool


# --- Phase C: in-app notifications -----------------------------------------


class NotificationActor(BaseModel):
    """Lightweight actor (subscribed-to user) embedded in a notification."""

    handle: str
    display_name: str
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    # Phase E (E1): True iff the recipient already follows this actor.
    # Lets the notifications panel render a "Follow back" button on
    # ``new_follower`` rows without a second round-trip per row.
    is_following: bool = False


class NotificationItem(BaseModel):
    """A single in-app notification row.

    ``kind`` is one of:
      - ``subscription_going``: ``actor`` marked Going to ``event_id``.
      - ``subscription_suggested``: ``actor``'s suggested event was approved.
    """

    id: int
    kind: str
    event_id: Optional[str] = None
    event_title: Optional[str] = None
    event_start: Optional[datetime] = None
    actor: NotificationActor
    created_at: datetime
    read_at: Optional[datetime] = None


class NotificationListResponse(BaseModel):
    items: list[NotificationItem]
    total: int
    unread_count: int
    limit: int
    offset: int


class UnreadCountResponse(BaseModel):
    count: int


class SubscribedEventVia(BaseModel):
    """Attribution for a single (actor, kind) reason this event surfaced."""

    actor: NotificationActor
    kind: str  # subscription_going | subscription_saved | subscription_suggested


class SubscribedEventItem(BaseModel):
    """An event surfaced via one or more of the viewer's subscriptions.

    ``via`` lists every (subscribed_user, reason) pair that surfaces this
    event. The frontend uses this for "@alice is going" / "suggested by
    @bob" attribution and for the per-subscription chip filter.
    """

    event_id: str
    calendar_id: str
    title: str
    description: Optional[str] = None
    location: Optional[str] = None
    start: datetime
    end: datetime
    all_day: bool = False
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    color: Optional[str] = None
    via: list[SubscribedEventVia]


class SubscribedEventListResponse(BaseModel):
    items: list[SubscribedEventItem]
    total: int
    limit: int
    offset: int


# --- Admin: users management ------------------------------------------------


class AdminUser(BaseModel):
    """Single row in the admin users table.

    Email is included here (unlike the public profile shapes) because this
    endpoint is gated by ``require_admin``. ``followers_count`` /
    ``following_count`` are denormalized at read time so the admin can spot
    accounts with unusual social activity at a glance.
    """

    user_id: str
    email: str
    handle: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_admin: bool = False
    is_verified_organizer: bool = False
    # Phase: admin-managed accounts. Flag + optional internal label
    # the admin uses to identify the curator persona
    # (e.g. "Salsa Nights Paris").
    is_admin_managed: bool = False
    managed_label: Optional[str] = None
    deleted_at: Optional[datetime] = None
    created_at: datetime
    followers_count: int = 0
    following_count: int = 0
    active_block_id: Optional[int] = None
    blocked_at: Optional[datetime] = None


class AdminUserListResponse(BaseModel):
    items: list[AdminUser]
    total: int


class AdminBlockUserRequest(BaseModel):
    reason: Optional[str] = None


class AdminBlockedUser(BaseModel):
    id: int
    provider: str
    provider_subject: str
    email: Optional[str] = None
    reason: Optional[str] = None
    created_at: datetime
    created_by_admin_user_id: Optional[str] = None
    revoked_at: Optional[datetime] = None
    revoked_by_admin_user_id: Optional[str] = None


class AdminBlockedUserListResponse(BaseModel):
    items: list[AdminBlockedUser]
    total: int


# --- Admin: bulk engagement curation ----------------------------------------


class AdminBulkEngagementRequest(BaseModel):
    """Body for ``POST /api/admin/engagement/bulk``.

    The admin selects one or more admin-managed target users (by handle)
    and one or more events, and applies ``(kind, action)`` to the
    cross-product. Audience defaults to each target's profile default
    when omitted. ``fan_out`` is opt-in and defaults to False so curated
    Going entries don't notify the target's followers by default.
    """

    handles: list[str]
    event_ids: list[str]
    kind: Literal["save", "going"]
    action: Literal["add", "remove"]
    audience: Optional[Literal["public", "friends", "private"]] = None
    fan_out: bool = False


class AdminBulkEngagementItem(BaseModel):
    handle: str
    event_id: str
    status: Literal[
        "changed",
        "noop",
        "skipped_not_managed",
        "skipped_no_user",
        "skipped_no_event",
    ]
    detail: Optional[str] = None


class AdminBulkEngagementResponse(BaseModel):
    items: list[AdminBulkEngagementItem]
    changed_count: int
    skipped_count: int


# --- Phase 3: per-calendar curation rules ----------------------------------


class CalendarCurationRuleResponse(BaseModel):
    """A single per-calendar curation rule.

    ``audience`` is ``None`` when the rule defers to the target user's
    profile default at engagement time (mirrors the bulk route).
    """

    id: int
    calendar_id: str
    target_user_id: str
    target_handle: Optional[str] = None
    kind: Literal["save", "going"]
    audience: Optional[Literal["public", "friends", "private"]] = None
    enabled: bool


class CalendarCurationRuleCreateRequest(BaseModel):
    """Body for ``POST /api/admin/calendars/{calendar_id}/curation-rules``.

    Target is specified by handle (admin UI's canonical identifier);
    server resolves to ``users.id`` and validates ``is_admin_managed``.
    """

    target_handle: str
    kind: Literal["save", "going"]
    audience: Optional[Literal["public", "friends", "private"]] = None
    enabled: bool = True


class CalendarCurationRuleUpdateRequest(BaseModel):
    audience: Optional[Literal["public", "friends", "private"]] = None
    enabled: Optional[bool] = None


# --- Phase D: profile content & user discovery ------------------------------


class UpdateBioRequest(BaseModel):
    """Body for ``PATCH /api/social/me/bio``.

    Empty string (or whitespace-only) clears the bio. Server strips control
    chars and trims whitespace before persisting.
    """

    bio: Optional[str] = Field(default=None, max_length=280)


class ProfileEventListResponse(BaseModel):
    """Paginated event list for the Going / Saved / Suggested profile tabs.

    Reuses ``EventResponse`` so the frontend can drop the items straight
    into the same card components used on /.

    ``curated_event_ids`` is the subset of ``items`` whose engagement
    row was created by the admin curator (Phase 2 bulk or Phase 3
    pipeline rule). The client uses it to render a "Curated" pill for
    transparency. Always present (possibly empty) — never null — so
    clients don't need to coalesce.
    """

    items: list[EventResponse]
    total: int
    limit: int
    offset: int
    curated_event_ids: list[str] = []


class ProfileCalendarItem(BaseModel):
    """Single row in the unified Calendar tab on /u/{handle}.

    Wraps the regular ``EventResponse`` with an ``intent`` discriminator
    so the client can render filter chips (All / Going / Saved) without
    a second round-trip. ``both`` is set when the owner has both saved
    and RSVP'd-going to the same event.

    ``curated`` is True iff any of the contributing engagement rows
    (saved and/or going) was created by the admin curator.
    """

    event: EventResponse
    intent: str = Field(pattern="^(going|saved|both)$")
    curated: bool = False


class ProfileCalendarResponse(BaseModel):
    items: list[ProfileCalendarItem]
    total: int
    limit: int
    offset: int


class UserSearchResult(BaseModel):
    """Lightweight user card for search and discover surfaces."""

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    is_admin_managed: bool = False
    subscribers_count: int = 0
    # Whether the *viewer* is subscribed to this user's calendar. Always
    # False for anonymous viewers and for self.
    is_subscribed: bool = False
    is_followed_by_viewer: bool = False
    is_friend: bool = False
    source: Optional[str] = None


class UserSearchResponse(BaseModel):
    items: list[UserSearchResult]


class SuggestedUsersResponse(BaseModel):
    """Friends-of-friends discovery payload (D.2.b).

    Empty for anonymous viewers and for users with no social graph yet —
    that's an acceptable cold-start; the UI falls back to the search box.
    """

    items: list[UserSearchResult]


# ---------------------------------------------------------------------------
# Phase E (E3) — onboarding suggestions
# ---------------------------------------------------------------------------


class OnboardingSuggestionsResponse(BaseModel):
    """Initial follow candidates surfaced on the ``/onboarding/follow`` page.

    Ranking is computed server-side (verified organizers first, then
    most-followed accounts in the new user's preferred area, then a
    global fallback). Frontend should render the items in the order
    returned and not re-sort.
    """

    items: list[UserSearchResult]


class CompleteOnboardingRequest(BaseModel):
    """Body for ``POST /api/social/onboarding/complete``.

    Empty ``handles`` is valid and means the user pressed Skip — we
    still stamp ``users.onboarded_at`` so they aren't redirected again.
    Duplicates and unknown handles are silently dropped; the follows
    are idempotent (POST /follow no-ops on the second call).
    """

    handles: list[str] = []


class CompleteOnboardingResponse(BaseModel):
    """Result of the onboarding batch follow.

    ``followed`` lists the handles that resulted in a NEW follow edge
    (excludes already-followed and unknown handles) so the UI can show
    an accurate "Followed N people" toast.
    """

    onboarded_at: str
    followed: list[str]


# ---------------------------------------------------------------------------
# Phase E (E4) — friend-of-friend suggestions
# ---------------------------------------------------------------------------


class FoFSuggestionItem(BaseModel):
    """One row in the "People you may know" panel.

    ``mutual_friend_count`` is the count of viewer-friends who follow
    this candidate. ``mutual_friends_preview`` is up to 3 handles from
    that set, used to render "Followed by @alice, @bob and N others".
    """

    handle: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_verified_organizer: bool = False
    is_admin_managed: bool = False
    mutual_friend_count: int = 0
    mutual_friends_preview: list[str] = []


class FoFSuggestionsResponse(BaseModel):
    items: list[FoFSuggestionItem]
    total: int


# ---------------------------------------------------------------------------
# Phase E (E7) — referrals
# ---------------------------------------------------------------------------


class ReferralResponse(BaseModel):
    """Idempotent payload for ``GET/POST /api/social/me/referral``.

    The same ``code`` and ``url`` are returned across calls for a given
    user (a UNIQUE constraint on ``user_referrals.inviter_user_id``
    enforces this). ``used_count`` lets the frontend surface viral
    stats (e.g. "3 friends joined via your link").
    """

    code: str
    url: str
    used_count: int


class RedeemReferralRequest(BaseModel):
    """Body for ``POST /api/auth/redeem-referral``.

    ``consent`` MUST be ``true`` — surfaced as an explicit checkbox on
    the signup page (GDPR Art. 7 — informed, specific, unambiguous).
    Without consent the endpoint returns 400 and no follow is created.
    The redemption attempt itself is silent and reveals nothing about
    the inviter to a logged-out actor.
    """

    code: str
    consent: bool = False


class RedeemReferralResponse(BaseModel):
    """Result of a successful redemption.

    ``inviter_handle`` is included so the post-signup toast can render
    "@alice is now your friend" without an extra round trip.
    """

    inviter_handle: Optional[str] = None
    mutual_follow_created: bool = False


# ---------------------------------------------------------------------------
# Phase E (D2) — share-link doubles as referral
# ---------------------------------------------------------------------------


class ShareSourceResponse(BaseModel):
    """Public lookup for ``GET /api/social/share-source/{share_code}``.

    Used by the share-referral banner to render "You arrived via
    @alpha — follow them?" before the viewer consents. Public on
    purpose (the share_code is already in the URL the visitor
    arrived on) but kept minimal — no email, no friend count.
    Returns 404 when the code does not resolve to an active user.
    """

    handle: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class RedeemShareFollowRequest(BaseModel):
    """Body for ``POST /api/auth/redeem-share-follow``.

    Phase 3 share-link-as-referral surface. Distinct from
    ``RedeemReferralRequest`` because share-link conversions do NOT
    count toward the E7 invite leaderboard (see D2 decision matrix
    in PHASE_E_FRIENDSHIP_ADOPTION.md).

    ``consent`` MUST be ``true`` — the share-referral banner exposes
    an opt-out checkbox (defaults checked); unchecking it skips the
    network call entirely, so the endpoint should never see
    ``consent=false`` from the normal flow. Mirrors the E7 contract
    so callers can't be tricked into silent follows.
    """

    share_code: str
    consent: bool = False


class RedeemShareFollowResponse(BaseModel):
    """Result of a successful share-follow redemption.

    ``sharer_handle`` lets the post-redemption toast render the followed
    user without an extra round trip.
    """

    sharer_handle: Optional[str] = None
    follow_created: bool = False
