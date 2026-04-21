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
    source: Optional[str] = Field(default=None, pattern="^(calendar|list|map|direct)$")


class EventSaveRequest(BaseModel):
    event_id: str
    device_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., pattern="^(save|unsave)$")


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
    env: str


class SiteSettingsResponse(BaseModel):
    since_date: str
    sync_interval_minutes: int
    show_prices: bool = False
    show_popularity: bool = False


class SiteSettingsUpdateRequest(BaseModel):
    since_date: Optional[str] = None
    sync_interval_minutes: Optional[int] = Field(default=None, ge=1, le=1440)
    show_prices: Optional[bool] = None
    show_popularity: Optional[bool] = None


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
    enrichment_status: str = "pending"
    enrichment_progress: Optional[dict] = None


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
    tags: list[TagResponse] = []


class TagGroupCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=100)
    slug: Optional[str] = Field(default=None, max_length=100)
    color: Optional[str] = None


class TagGroupUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=100)
    ordinal: Optional[int] = None
    allow_multiple: Optional[bool] = None
    color: Optional[str] = None
    enabled: Optional[bool] = None


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
