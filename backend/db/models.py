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
    # Public, user-chosen identifier used for /u/{handle} URLs and future
    # social features. Nullable so existing accounts can claim one later.
    # Case-insensitive uniqueness is enforced by a functional unique index
    # on ``lower(handle)`` (see migration g1a2b3c4d5e7).
    handle: Optional[str] = Field(default=None, max_length=24)
    # Short opaque base32 identifier appended to shared URLs as
    # ``?ref=share&src={share_code}``. Distinct from ``handle`` so users
    # can change their handle without breaking attribution on previously
    # shared links. Nullable for legacy rows; populated lazily by the
    # auth layer when the user next signs in.
    share_code: Optional[str] = Field(
        default=None, max_length=12, index=True, unique=True
    )
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
    # 3-tier audience replacement for ``share_attendance_default``. Used as the
    # pre-selected option in the GoingButton audience picker (public / friends
    # / private). Backfilled from ``share_attendance_default`` in migration
    # ``ee50f6a7b8c9``. The boolean field is kept for one release for
    # backwards compatibility; new code should read this field instead.
    # Default is ``friends`` (privacy-by-default per GDPR Art. 25): only
    # mutual followers see RSVPs/saves unless the user opts up to ``public``
    # via the per-event AudiencePicker. New users with no friends yet see
    # the same effective behaviour as ``private``, failing closed.
    share_attendance_default_audience: str = Field(
        default="friends", max_length=16, nullable=False
    )
    # Backed-up default for new RSVP/save audience values is computed
    # client-side from a localStorage "last used" hint; this column is
    # kept for backwards compatibility (read paths still consult it as a
    # fallback) but is no longer surfaced in Settings UI.
    # User preferences (preferred map area + preferred tags) used as default
    # filters in the explorer. Area is stored as a bounding box; tags live in
    # the user_preferred_tag join table. ``preferences_set_at`` is the gate
    # that distinguishes "never set" from "explicitly empty" — also used by
    # the anon→authed merge path to decide whether to apply localStorage prefs.
    preferred_area_min_lat: Optional[float] = Field(default=None)
    preferred_area_min_lng: Optional[float] = Field(default=None)
    preferred_area_max_lat: Optional[float] = Field(default=None)
    preferred_area_max_lng: Optional[float] = Field(default=None)
    preferred_area_label: Optional[str] = Field(default=None, max_length=120)
    preferences_set_at: Optional[datetime] = Field(default=None)
    # --- Social foundation ---
    # Single account-level visibility gate (Instagram-style). Values:
    # ``public`` (anyone can view profile + lists) or ``friends`` (only
    # mutual followers, plus the user themselves). Per-event audience
    # is independent and lives on the per-event rows
    # (``UserEventAttendance.share_audience`` / ``UserSavedEvent.audience``).
    account_visibility: str = Field(default="public", max_length=16, nullable=False)
    # Admin-granted credibility badge surfaced on the public profile.
    is_verified_organizer: bool = Field(default=False, nullable=False)
    # Optional, unverified social profile links shown on the public profile
    # for self-published credibility. Display-only; never used for auth.
    instagram_url: Optional[str] = Field(default=None, max_length=255)
    facebook_url: Optional[str] = Field(default=None, max_length=255)
    # --- Phase D: profile content ---
    # Free-form short bio rendered on /u/{handle} About tab. Plain text
    # only (no markdown), trimmed and stripped of control chars at write
    # time. Capped at 280 chars to keep profile cards skimmable.
    bio: Optional[str] = Field(default=None, max_length=280)


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
    is_hidden: bool = Field(default=False, index=True)


class BlockedEvent(SQLModel, table=True):
    """Records event IDs that have been permanently suppressed by an admin.

    Sync workers skip any incoming event whose event_id exists in this table,
    preventing a re-blocked event from reappearing after a Google Calendar sync.
    """

    __tablename__ = "blocked_events"

    event_id: str = Field(primary_key=True)
    blocked_at: datetime = Field(default_factory=datetime.utcnow)


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
    # Per-saved-event audience (public / friends / private). Treated as
    # the equivalent of "interested" tier on Facebook events. Defaults
    # to ``friends`` (privacy-by-default per GDPR Art. 25) — the
    # frontend may pre-fill with the user's last-used choice from
    # localStorage or with ``share_attendance_default_audience``.
    audience: str = Field(default="friends", max_length=16, nullable=False)


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
    # Authenticated submitter (Phase C: enables fan-out of subscription_suggested
    # notifications to the submitter's subscribers on approval). Null for
    # anonymous submissions.
    submitter_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )

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
    # When True, the approval flow auto-creates a UserSavedEvent for
    # ``submitter_user_id`` so the suggested event lands on the submitter's
    # Calendar tab without a separate save action. Defaults to True;
    # the suggest form exposes an opt-out checkbox.
    auto_save: bool = Field(default=True, nullable=False)
    # User-entered new-tag suggestions submitted with the event. Each item:
    #   {"free_text": str, "group_slug": str | None}
    # On approval these become regular TagSuggestion rows tied to the new event.
    suggested_new_tags: Optional[list] = Field(default=None, sa_column=Column(JSON))

    # Optional pricing hints from the submitter (copied to CachedEvent on approval)
    price_min: Optional[float] = Field(default=None)
    price_max: Optional[float] = Field(default=None)
    price_currency: Optional[str] = Field(default=None)
    price_is_free: bool = Field(default=False)

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


class UserPreferredTag(SQLModel, table=True):
    """User's preferred dance-style tags, applied as default explorer filter.

    Mirrors the ``EventTag`` shape: composite primary key, no relationship
    navigation. ``ON DELETE CASCADE`` is enforced via the migration so removing
    a user or a tag automatically tidies up the join rows.
    """

    __tablename__ = "user_preferred_tags"

    user_id: UUID = Field(foreign_key="users.id", primary_key=True)
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
    # Legacy boolean kept dual-written for one release so older clients
    # continue to work; new code should read ``share_audience``.
    share_publicly: bool = Field(default=False, nullable=False)
    # 3-tier audience: ``public`` | ``friends`` | ``private``. Source of
    # truth for who can see this user in the attendee list. Combined
    # with the viewer's relationship for the ``friends`` tier
    # (mutual-follow gate enforced in the read paths).
    share_audience: str = Field(default="public", max_length=16, nullable=False)


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


class ShareEvent(SQLModel, table=True):
    """Append-only log of share funnel events.

    One row per discrete action: a 'share' when the user activates the
    share button, a 'click' when a referred visitor lands on the event
    page (carries the originating ``share_code`` from the URL), and a
    'conversion' when that referred visitor performs an attributable
    action (currently RSVP "going").
    """

    __tablename__ = "share_events"

    id: Optional[int] = Field(default=None, primary_key=True)
    event_id: str = Field(index=True)
    action: str = Field(max_length=16)  # share | click | conversion
    share_code: Optional[str] = Field(default=None, max_length=12, index=True)
    device_id: Optional[str] = Field(default=None, max_length=64, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserFollow(SQLModel, table=True):
    """Asymmetric follow edge from ``follower_id`` to ``followee_id``.

    A "friend" is a mutual follow (both directions exist). This single edge
    table is the source of truth for the follow graph; mutuality is derived
    by self-joining the table at query time.
    """

    __tablename__ = "user_follows"
    __table_args__ = (
        UniqueConstraint("follower_id", "followee_id", name="uq_user_follow_pair"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    follower_id: UUID = Field(foreign_key="users.id", index=True)
    followee_id: UUID = Field(foreign_key="users.id", index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CalendarSubscription(SQLModel, table=True):
    """A subscriber's interest in another user's shared calendar.

    Distinct from ``UserFollow`` (the follow graph): subscribing means the
    subscriber wants the target's saved/going events surfaced in their own
    "My Calendar" feed and (when ``notify_new_events`` is true) wants a
    notification when the target publishes new activity.

    Subscribing requires that the subscriber currently passes
    ``can_view(viewer, target, 'calendar')``; the row is preserved if
    visibility is later tightened, but the feed/notification producers
    re-check ``can_view`` at read/emit time so a target can effectively
    revoke access without an explicit unsubscribe.
    """

    __tablename__ = "calendar_subscriptions"
    __table_args__ = (
        UniqueConstraint(
            "subscriber_id",
            "target_user_id",
            name="uq_calendar_subscription_pair",
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    subscriber_id: UUID = Field(foreign_key="users.id", index=True)
    target_user_id: UUID = Field(foreign_key="users.id", index=True)
    notify_new_events: bool = Field(default=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Notification(SQLModel, table=True):
    """In-app notification fanned out to a subscriber.

    ``kind`` distinguishes the trigger:
      - ``subscription_going``: ``actor_user_id`` marked themselves Going to
        ``event_id`` with ``share_publicly=true``.
      - ``subscription_suggested``: ``actor_user_id`` submitted an event
        suggestion that was approved (the resulting cached event id is
        recorded in ``event_id``).

    A unique index on (recipient_user_id, kind, actor_user_id, event_id)
    keeps re-triggers (e.g. flipping share_publicly off then on) idempotent.
    """

    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint(
            "recipient_user_id",
            "kind",
            "actor_user_id",
            "event_id",
            name="uq_notification_dedupe",
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    recipient_user_id: UUID = Field(foreign_key="users.id", index=True)
    actor_user_id: UUID = Field(foreign_key="users.id", index=True)
    kind: str = Field(
        index=True
    )  # subscription_going | subscription_suggested | new_follower | new_friend
    event_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    read_at: Optional[datetime] = Field(default=None, index=True)
