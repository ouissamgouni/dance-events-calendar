from datetime import datetime
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, JSON, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


class CalendarSetting(SQLModel, table=True):
    __tablename__ = "calendar_settings"

    calendar_id: str = Field(primary_key=True)
    name: str = Field(index=True)
    enabled: bool = Field(default=False)
    color: Optional[str] = Field(default=None)
    sync_token: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class CachedEvent(SQLModel, table=True):
    __tablename__ = "cached_events"

    event_id: str = Field(primary_key=True)
    calendar_id: str = Field(index=True)
    title: str = Field(default="")
    description: Optional[str] = Field(default=None, sa_column=Column(Text))
    location: Optional[str] = Field(default=None)
    start: datetime
    end: datetime
    all_day: bool = Field(default=False)
    latitude: Optional[float] = Field(default=None)
    longitude: Optional[float] = Field(default=None)
    price_min: Optional[float] = Field(default=None)
    price_max: Optional[float] = Field(default=None)
    price_currency: Optional[str] = Field(default=None)
    price_is_free: bool = Field(default=False)
    review_status: str = Field(default="pending")
    links: Optional[list] = Field(default=None, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class EventView(SQLModel, table=True):
    __tablename__ = "event_views"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: Optional[str] = Field(default=None, index=True)
    source: Optional[str] = Field(default=None)  # calendar | list | map | direct
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EventSave(SQLModel, table=True):
    __tablename__ = "event_saves"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: str = Field(index=True)
    action: str = Field(default="save")  # save | unsave
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SiteSetting(SQLModel, table=True):
    __tablename__ = "site_settings"

    key: str = Field(primary_key=True)
    value: str = Field(default="")


class SyncLog(SQLModel, table=True):
    __tablename__ = "sync_logs"

    id: Optional[int] = Field(default=None, primary_key=True)
    started_at: datetime = Field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = Field(default=None)
    status: str = Field(default="running")  # running | success | error
    trigger: str = Field(default="auto")  # auto | manual
    calendars_synced: int = Field(default=0)
    events_upserted: int = Field(default=0)
    events_deleted: int = Field(default=0)
    error_message: Optional[str] = Field(default=None, sa_column=Column(Text))
    enrichment_status: str = Field(default="pending")  # pending | running | completed
    enrichment_progress: Optional[dict] = Field(default=None, sa_column=Column(JSON))


class EventSuggestion(SQLModel, table=True):
    __tablename__ = "event_suggestions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    title: str
    description: Optional[str] = Field(default=None, sa_column=Column(Text))
    location: Optional[str] = Field(default=None)
    links: Optional[list] = Field(default=None, sa_column=Column(JSON))
    latitude: Optional[float] = Field(default=None)
    longitude: Optional[float] = Field(default=None)
    start: datetime
    end: datetime
    all_day: bool = Field(default=False)

    # Submitter info
    submitter_name: Optional[str] = Field(default=None)
    submitter_email: Optional[str] = Field(default=None)

    # Browser metadata
    submitter_ip: Optional[str] = Field(default=None)
    submitter_user_agent: Optional[str] = Field(default=None)
    submitter_language: Optional[str] = Field(default=None)
    submitter_referrer: Optional[str] = Field(default=None)
    submitter_screen_size: Optional[str] = Field(default=None)
    submitter_timezone: Optional[str] = Field(default=None)

    # IP geolocation
    submitter_city: Optional[str] = Field(default=None)
    submitter_country: Optional[str] = Field(default=None)
    submitter_lat: Optional[float] = Field(default=None)
    submitter_lng: Optional[float] = Field(default=None)

    # Workflow
    status: str = Field(default="pending", index=True)
    admin_notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    assigned_calendar_id: Optional[str] = Field(default=None)
    created_event_id: Optional[str] = Field(default=None)
    synced_to_google: bool = Field(default=False)
    google_event_id: Optional[str] = Field(default=None)
    suggested_tag_ids: Optional[list] = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    reviewed_at: Optional[datetime] = Field(default=None)
    reviewed_by: Optional[str] = Field(default=None)


class EventLinkClick(SQLModel, table=True):
    __tablename__ = "event_link_clicks"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: Optional[str] = Field(default=None, index=True)
    url: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EventExport(SQLModel, table=True):
    __tablename__ = "event_exports"

    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: Optional[str] = Field(default=None, index=True)
    format: str  # ics | xlsx
    event_count: int = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow)


# --- Tags / Categorization ---


class TagGroup(SQLModel, table=True):
    __tablename__ = "tag_groups"

    id: Optional[int] = Field(default=None, primary_key=True)
    slug: str = Field(unique=True, index=True)
    label: str
    color: Optional[str] = Field(default=None)
    ordinal: int = Field(default=0)
    allow_multiple: bool = Field(default=True)
    enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    tags: List["Tag"] = Relationship(back_populates="group")


class Tag(SQLModel, table=True):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("group_id", "slug", name="uq_tag_group_slug"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    group_id: int = Field(foreign_key="tag_groups.id", index=True)
    slug: str
    label: str
    color: Optional[str] = Field(default=None)
    ordinal: int = Field(default=0)
    enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    group: Optional[TagGroup] = Relationship(back_populates="tags")


class EventTag(SQLModel, table=True):
    __tablename__ = "event_tags"
    __table_args__ = (UniqueConstraint("event_id", "tag_id", name="uq_event_tag"),)

    event_id: str = Field(foreign_key="cached_events.event_id", primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class TagSuggestion(SQLModel, table=True):
    __tablename__ = "tag_suggestions"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    tag_id: Optional[int] = Field(default=None, foreign_key="tags.id")
    free_text: Optional[str] = Field(default=None)
    group_slug: Optional[str] = Field(default=None)
    status: str = Field(default="pending", index=True)  # pending | approved | rejected
    submitter_device_id: Optional[str] = Field(default=None)
    submitter_ip: Optional[str] = Field(default=None)
    admin_notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    reviewed_at: Optional[datetime] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
