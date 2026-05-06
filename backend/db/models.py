from datetime import datetime
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, JSON, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


class User(SQLModel, table=True):
    """End-user account (distinct from the admin role gated by ADMIN_EMAIL)."""

    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(unique=True, index=True, max_length=255)
    display_name: Optional[str] = Field(default=None, max_length=120)
    avatar_url: Optional[str] = Field(default=None, max_length=512)
    provider: str = Field(default="google", max_length=32)
    provider_subject: Optional[str] = Field(
        default=None, unique=True, index=True, max_length=255
    )
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_login_at: Optional[datetime] = Field(default=None)
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    # Pre-fills the "Share my name" toggle in the GoingButton confirmation
    # popover. Defaults to True so attendee lists are populated by default;
    # users can opt out via account settings or per-event in the popover.
    # ``share_attendance_default_set_by_user`` is flipped to True the first
    # time the user explicitly PATCHes the preference, so future bulk
    # backfills can avoid overriding deliberate choices.
    share_attendance_default: bool = Field(default=True, nullable=False)
    share_attendance_default_set_by_user: bool = Field(default=False, nullable=False)


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
    geocode_query: Optional[str] = Field(default=None)
    geocode_provider: Optional[str] = Field(default=None)
    price_min: Optional[float] = Field(default=None)
    price_max: Optional[float] = Field(default=None)
    price_currency: Optional[str] = Field(default=None)
    price_is_free: bool = Field(default=False)
    review_status: str = Field(default="pending")
    links: Optional[list] = Field(default=None, sa_column=Column(JSON))
    content_hash: Optional[str] = Field(default=None, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class EventCalendarSource(SQLModel, table=True):
    """Tracks every source calendar that contributed to a canonical CachedEvent."""

    __tablename__ = "event_calendar_sources"
    __table_args__ = (
        UniqueConstraint("event_id", "calendar_id", name="uq_event_calendar_source"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(foreign_key="cached_events.event_id", index=True)
    calendar_id: str = Field(foreign_key="calendar_settings.calendar_id", index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EventView(SQLModel, table=True):
    __tablename__ = "event_views"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: Optional[str] = Field(default=None, index=True)
    source: Optional[str] = Field(default=None)  # calendar | list | map | direct
    country: Optional[str] = Field(default=None)
    city: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EventSave(SQLModel, table=True):
    __tablename__ = "event_saves"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: str = Field(index=True)
    action: str = Field(default="save")  # save | unsave
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserSavedEvent(SQLModel, table=True):
    __tablename__ = "user_saved_events"
    __table_args__ = (UniqueConstraint("device_id", "event_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: str = Field(index=True, max_length=64)
    event_id: str = Field(index=True)
    user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)
    saved_at: datetime = Field(default_factory=datetime.utcnow)


class ShareToken(SQLModel, table=True):
    __tablename__ = "share_tokens"

    id: Optional[int] = Field(default=None, primary_key=True)
    token: str = Field(unique=True, index=True)
    device_id: str = Field(unique=True, index=True, max_length=64)
    user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", unique=True, index=True
    )
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
    dedup_log: Optional[list] = Field(default=None, sa_column=Column(JSON))


class SyncJobRun(SQLModel, table=True):
    """Persisted snapshot of a SyncJobService job run.

    The in-memory SyncJobService is the source of truth while a job is
    running; rows here are written periodically (throttled) and on
    finalization so Sync History survives backend restarts.
    """

    __tablename__ = "sync_job_runs"

    job_id: str = Field(primary_key=True)
    status: str = Field(index=True)
    mode: Optional[str] = Field(default=None)
    since_date: Optional[str] = Field(default=None)
    started_at: datetime = Field(index=True)
    finished_at: Optional[datetime] = Field(default=None)
    heartbeat_at: Optional[datetime] = Field(default=None)
    abort_requested: bool = Field(default=False)
    warning_message: Optional[str] = Field(default=None, sa_column=Column(Text))
    error_message: Optional[str] = Field(default=None, sa_column=Column(Text))
    totals_json: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    stage_totals_json: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    calendar_statuses_json: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    metadata_json: Optional[dict] = Field(
        default=None, sa_column=Column("metadata_json", JSON)
    )


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
    country: Optional[str] = Field(default=None)
    city: Optional[str] = Field(default=None)
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
    # Scope separates first-class event taxonomy from review-only aspect tags.
    # 'event' = appears in explorer filter, event tag pills, suggestion form.
    # 'review' = appears in rate-event modal and review-list filter chips only.
    # Mirrors the two-namespace pattern used by Google/Yelp/Airbnb (place
    # attributes vs review aspects). Enforced in routes + suggestion validation.
    scope: str = Field(default="event", index=True)
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
    is_hero_filter: bool = Field(default=False)
    hero_ordinal: Optional[int] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    group: Optional[TagGroup] = Relationship(back_populates="tags")


class TagSynonym(SQLModel, table=True):
    """Admin-configurable synonym terms used by the heuristic tag suggester.

    Each row maps a free-text term (e.g. "live band") to a tag. The suggester
    matches lowercased event text against these terms (plus the tag label and
    slug) when scoring tag suggestions.
    """

    __tablename__ = "tag_synonyms"
    __table_args__ = (
        UniqueConstraint("tag_id", "term", name="uq_tag_synonym_tag_term"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    tag_id: int = Field(foreign_key="tags.id", index=True)
    term: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


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
    # Links a TagSuggestion to the parent feedback envelope (rating + tag suggestions
    # submitted together). NULL for legacy/standalone suggestions.
    feedback_submission_id: Optional[UUID] = Field(default=None, index=True)
    # Origin of the suggestion. 'user' = end-user submitted (legacy default).
    # 'heuristic' = generated by the TagSuggestionStage in the enrichment
    # pipeline using keyword/synonym matching against the tag taxonomy.
    source: str = Field(default="user", index=True)
    # Confidence score 0.0-1.0 for auto-generated rows; NULL for user submissions.
    confidence: Optional[float] = Field(default=None)
    # List of matched terms that triggered an auto suggestion (admin transparency).
    matched_terms: Optional[list] = Field(default=None, sa_column=Column(JSON))


class EventRating(SQLModel, table=True):
    """User rating + review for an event. Pre-moderated by admin."""

    __tablename__ = "event_ratings"
    __table_args__ = (
        # Partial unique constraint (one rating per user per event) is created
        # in the Alembic migration as ``CREATE UNIQUE INDEX ... WHERE user_id IS NOT NULL``
        # because SQLAlchemy/SQLModel cannot express partial uniques portably.
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    event_id: str = Field(foreign_key="cached_events.event_id", index=True)
    # Nullable so account deletion can soft-anonymise (ON DELETE SET NULL on FK).
    user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)

    stars: int = Field(ge=1, le=5)
    comment: Optional[str] = Field(default=None, sa_column=Column(Text))
    review_tag_ids: Optional[list] = Field(default=None, sa_column=Column(JSON))
    is_anonymous: bool = Field(default=False)

    # Groups together the rating and any tag-suggestions submitted in the same
    # feedback envelope so the admin UI can show them together while still
    # moderating each independently.
    feedback_submission_id: Optional[UUID] = Field(default=None, index=True)

    # Workflow
    status: str = Field(default="pending", index=True)  # pending | approved | rejected
    admin_notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    reviewed_at: Optional[datetime] = Field(default=None)
    reviewed_by: Optional[str] = Field(default=None)

    # Audit
    submitter_ip: Optional[str] = Field(default=None)
    submitter_user_agent: Optional[str] = Field(default=None)
    submitter_country: Optional[str] = Field(default=None)

    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class EventAttendance(SQLModel, table=True):
    """Append-only audit log of going/not_going actions (mirrors EventSave)."""

    __tablename__ = "event_attendances"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    device_id: str = Field(index=True)
    action: str = Field(default="going")  # going | not_going
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserEventAttendance(SQLModel, table=True):
    """Materialized current attendance state — one row means the device is currently going."""

    __tablename__ = "user_event_attendances"
    __table_args__ = (UniqueConstraint("device_id", "event_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: str = Field(index=True, max_length=64)
    event_id: str = Field(index=True)
    user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)
    attending_since: datetime = Field(default_factory=datetime.utcnow)
    # When True AND user_id IS NOT NULL the row is eligible to appear in the
    # public attendee list for the event. When False, the attendance is
    # counted but the user is not named ("private going"). Anonymous device
    # rows (user_id IS NULL) are always private regardless of this flag.
    share_publicly: bool = Field(default=False, nullable=False)


class CalendarDefaultTag(SQLModel, table=True):
    """Tags automatically applied to new events synced from a calendar."""

    __tablename__ = "calendar_default_tags"
    __table_args__ = (
        UniqueConstraint("calendar_id", "tag_id", name="uq_calendar_default_tag"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    calendar_id: str = Field(foreign_key="calendar_settings.calendar_id", index=True)
    tag_id: int = Field(foreign_key="tags.id", index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
