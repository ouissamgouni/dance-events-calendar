from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class LinkItem(BaseModel):
    url: str
    label: Optional[str] = None


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


class EventSaveRequest(BaseModel):
    event_id: str
    device_id: str = Field(..., min_length=1, max_length=64)
    action: str = Field(..., pattern="^(save|unsave)$")


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
