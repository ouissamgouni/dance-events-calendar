from datetime import datetime
from typing import Optional
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
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    price_currency: Optional[str] = None
    price_is_free: bool = False
    review_status: str = "reviewed"
    links: Optional[list[LinkItem]] = None
    tags: list[TagResponse] = []


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


class EventAttendanceRequest(BaseModel):
    event_id: str
    device_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., pattern="^(going|not_going)$")
    record_analytics: bool = True
    # When None on a "going" action: keep the existing value if the row already
    # exists, otherwise fall back to ``user.share_attendance_default``. Logged-out
    # callers always store user_id=NULL so the field is ignored for them.
    share_publicly: Optional[bool] = None


class AttendeeResponse(BaseModel):
    user_id: UUID
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


class AttendanceSummaryResponse(BaseModel):
    """Counts for one event. The ``public_*`` and ``anonymous_*`` breakdown is
    only populated for authenticated callers — logged-out viewers see only the
    total and a flag telling them to sign in for the rest."""

    event_id: str
    total_going: int = 0
    public_going: int = 0
    anonymous_going: int = 0
    can_view_attendees: bool = False
    viewer_is_sharing: bool = False
    preview_attendees: list[AttendeeResponse] = []


class AttendanceSummaryBatchRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=200)


class UpdatePreferencesRequest(BaseModel):
    share_attendance_default: Optional[bool] = None


class EventLinkClickRequest(BaseModel):
    event_id: str
    url: str = Field(..., min_length=1, max_length=2048)
    device_id: Optional[str] = Field(default=None, max_length=64)


class EventExportRequest(BaseModel):
    format: str = Field(..., pattern="^(ics|xlsx)$")
    event_count: int = Field(..., ge=0, le=10000)
    device_id: Optional[str] = Field(default=None, max_length=64)


class EventBatchRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=100)


class ExportRequest(BaseModel):
    event_ids: list[str] = Field(..., min_length=1, max_length=100)


class HealthResponse(BaseModel):
    status: str


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
    event_color_bar_color: str = "#64748b"


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
    event_color_bar_color: Optional[str] = Field(
        default=None, pattern="^#[0-9a-fA-F]{6}$"
    )


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


# --- Event Suggestions ---


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
    scope: str = "event"
    tags: list[TagResponse] = []


class TagGroupCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=100)
    slug: Optional[str] = Field(default=None, max_length=100)
    color: Optional[str] = None
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
    tag: Optional[TagResponse] = None
    free_text: Optional[str] = None
    group_slug: Optional[str] = None
    status: str = "pending"
    submitter_device_id: Optional[str] = None
    admin_notes: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: datetime


class TagSuggestionApproveRequest(BaseModel):
    tag_id: Optional[int] = (
        None  # required if free_text suggestion — admin picks/creates a tag
    )


class TagSuggestionRejectRequest(BaseModel):
    admin_notes: Optional[str] = None


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
