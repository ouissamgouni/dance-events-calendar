from datetime import datetime
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, Index, JSON, Text, UniqueConstraint, text
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
    show_in_suggestions: bool = Field(default=True, nullable=False)
    # Admin-granted credibility badge surfaced on the public profile.
    is_verified_organizer: bool = Field(default=False, nullable=False)
    # Phase: admin-curated lists. When True the account is operated by
    # site admins ("dedicated curator profile") and is a valid target
    # for the bulk-curation routes. Default False — civilian accounts
    # are never written to by admin tooling.
    is_admin_managed: bool = Field(default=False, nullable=False, index=True)
    # Optional admin-only label shown in the Admin Users tab
    # (e.g. "Salsa Nights Paris curator"). Not exposed publicly.
    managed_label: Optional[str] = Field(default=None, max_length=120)
    # Phase: admin-curated lists. When True the account is operated by
    # site admins ("dedicated curator profile") and is a valid target
    # for the bulk-curation routes. Default False — civilian accounts
    # are never written to by admin tooling.
    is_admin_managed: bool = Field(default=False, nullable=False, index=True)
    # Optional admin-only label shown in the Admin Users tab
    # (e.g. "Salsa Nights Paris curator"). Not exposed publicly.
    managed_label: Optional[str] = Field(default=None, max_length=120)
    # Optional, unverified social profile links shown on the public profile
    # for self-published credibility. Display-only; never used for auth.
    instagram_url: Optional[str] = Field(default=None, max_length=255)
    facebook_url: Optional[str] = Field(default=None, max_length=255)
    # --- Phase D: profile content ---
    # Free-form short bio rendered on /u/{handle} About tab. Plain text
    # only (no markdown), trimmed and stripped of control chars at write
    # time. Capped at 280 chars to keep profile cards skimmable.
    bio: Optional[str] = Field(default=None, max_length=280)
    # --- Phase E2: onboarding ---
    # Stamped the first time the user either completes the
    # ``/onboarding/follow`` flow (E3) or explicitly skips it. NULL means
    # the user has never seen the onboarding screen, so frontend route
    # guards should redirect them there on their next signed-in
    # navigation. Existing pre-E3 accounts also start as NULL and pass
    # through the redirect once on their next sign-in.
    onboarded_at: Optional[datetime] = Field(default=None)
    # Version of the onboarding wizard the user last completed. When the
    # server-side ``CURRENT_ONBOARDING_VERSION`` constant is bumped
    # (e.g. a new required step is introduced) the gate re-routes users
    # whose stored version is lower back through the flow.
    onboarding_version: int = Field(default=0, nullable=False)
    # Timestamp of the last activity-digest email successfully sent to
    # this user. Used by the digest scheduler to avoid re-sending within
    # a single scheduled window (see ``activity_email.run_once``).
    last_digest_sent_at: Optional[datetime] = Field(default=None)
    # --- Re-engagement / notification preferences ---
    # IANA timezone (e.g. "Europe/Paris") captured client-side and used to
    # format reminder/digest email times. Defaults to UTC for legacy
    # accounts; the frontend PATCHes it on first signed-in load.
    timezone: str = Field(default="UTC", max_length=64, nullable=False)
    # Per-feature × per-channel delivery gates. Rows always land in-app;
    # these six flags control email and push delivery only. See
    # docs/PHASE_G_NOTIFICATION_GATING.md.
    email_event_reminders_enabled: bool = Field(default=True, nullable=False)
    email_social_activity_enabled: bool = Field(default=True, nullable=False)
    email_interest_matches_enabled: bool = Field(default=True, nullable=False)
    push_event_reminders_enabled: bool = Field(default=True, nullable=False)
    push_social_activity_enabled: bool = Field(default=True, nullable=False)
    push_interest_matches_enabled: bool = Field(default=True, nullable=False)
    # --- Interest Profiles & Interest-Event Notifications ---
    # Optional "home" location, used as the default center for radius-based
    # interest profiles. Nullable until the user sets it via preferences.
    home_lat: Optional[float] = Field(default=None)
    home_lng: Optional[float] = Field(default=None)
    home_label: Optional[str] = Field(default=None, max_length=120)


class BlockedUserIdentity(SQLModel, table=True):
    """Admin-created signup block keyed to the auth provider identity."""

    __tablename__ = "blocked_user_identities"
    __table_args__ = (
        Index(
            "ux_blocked_user_identities_active_subject",
            "provider",
            "provider_subject",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
            sqlite_where=text("revoked_at IS NULL"),
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    provider: str = Field(default="google", max_length=32, index=True)
    provider_subject: str = Field(max_length=255, index=True)
    email: Optional[str] = Field(default=None, max_length=255, index=True)
    reason: Optional[str] = Field(default=None, sa_column=Column(Text))
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )
    revoked_at: Optional[datetime] = Field(default=None, index=True)
    revoked_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )


class UserAccountMerge(SQLModel, table=True):
    """Admin audit trail for one managed account merged into another."""

    __tablename__ = "user_account_merges"

    id: Optional[int] = Field(default=None, primary_key=True)
    source_user_id: UUID = Field(foreign_key="users.id", index=True)
    destination_user_id: UUID = Field(foreign_key="users.id", index=True)
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )
    reason: Optional[str] = Field(default=None, sa_column=Column(Text))
    summary: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class CalendarSetting(SQLModel, table=True):
    __tablename__ = "calendar_settings"

    calendar_id: str = Field(primary_key=True)
    name: str = Field(index=True)
    enabled: bool = Field(default=False)
    color: Optional[str] = Field(default=None)
    sync_token: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class CalendarCurationRule(SQLModel, table=True):
    """Per-calendar rule that auto-curates synced events onto an
    admin-managed target's Saved/Going list.

    The post-sync hook
    (``SyncService.run_enrichment`` → ``apply_curation_rules``) reads
    all ``enabled`` rules for the touched calendars and calls
    ``set_event_engagement(add)`` per (event, rule) pair. The primitive
    is idempotent so re-running a sync is a safe no-op.

    The ``(calendar_id, target_user_id, kind)`` unique constraint means
    there is at most one rule per pair per kind — toggling
    ``audience`` later mutates the existing row rather than spawning
    duplicates.
    """

    __tablename__ = "calendar_curation_rules"
    __table_args__ = (
        UniqueConstraint(
            "calendar_id",
            "target_user_id",
            "kind",
            name="uq_curation_rule_cal_target_kind",
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    calendar_id: str = Field(
        foreign_key="calendar_settings.calendar_id", index=True, nullable=False
    )
    target_user_id: UUID = Field(foreign_key="users.id", index=True, nullable=False)
    # ``save`` | ``going``.
    kind: str = Field(max_length=16, nullable=False)
    # Per-row audience override. None = use the target user's profile
    # default at engagement time (mirrors the bulk route default).
    audience: Optional[str] = Field(default=None, max_length=16)
    enabled: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CachedEvent(SQLModel, table=True):
    __tablename__ = "cached_events"
    __table_args__ = (
        Index(
            "ix_cached_events_explorer_window",
            "calendar_id",
            "deleted_at",
            "is_hidden",
            "end",
            "start",
        ),
    )

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
    # Per-event organizer attribution. Set when an admin approves an
    # ``OrganizerClaimEvent`` row tying a user to this event. Independent
    # from ``User.is_verified_organizer`` (the account-level badge).
    organizer_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )


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
    __table_args__ = (
        Index("ix_event_views_event_created_at", "event_id", "created_at"),
    )

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
    __table_args__ = (
        UniqueConstraint("device_id", "event_id"),
        Index("ix_user_saved_events_event_saved_at", "event_id", "saved_at"),
        Index(
            "ix_user_saved_events_user_audience_event",
            "user_id",
            "audience",
            "event_id",
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: str = Field(index=True, max_length=64)
    event_id: str = Field(index=True)
    # Non-NULL when the row was written by the site admin acting on
    # behalf of the target user (admin-curated lists feature). Used by
    # the public read paths to surface a "Curated" pill on the row.
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )
    user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)
    saved_at: datetime = Field(default_factory=datetime.utcnow)
    # Per-saved-event audience (public / friends / private). Treated as
    # the equivalent of "interested" tier on Facebook events. Defaults
    # to ``friends`` (privacy-by-default per GDPR Art. 25) — the
    # frontend may pre-fill with the user's last-used choice from
    # localStorage or with ``share_attendance_default_audience``.
    audience: str = Field(default="friends", max_length=16, nullable=False)
    # Non-NULL when the row was written by the site admin acting on
    # behalf of the target user (admin-curated lists feature). Used by
    # the public read paths to surface a "Curated" pill on the row.
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )


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


class EventPromoCode(SQLModel, table=True):
    """User-submitted promo code attached to an event.

    Sign-in required (``submitter_user_id`` is NOT NULL). Admin-moderated:
    ``status`` flows ``pending`` → ``approved`` | ``rejected``. Author
    edits to a previously approved row revert ``status`` to ``pending``
    so the change is re-reviewed.

    Uniqueness on ``(event_id, lower(code))`` is enforced via a partial
    unique index (``WHERE status != 'rejected'``) in the migration —
    SQLModel cannot express the partiality declaratively.
    """

    __tablename__ = "event_promo_codes"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    event_id: str = Field(foreign_key="cached_events.event_id", index=True)
    code: str = Field(max_length=64)
    description: Optional[str] = Field(default=None, max_length=200)
    source_url: Optional[str] = Field(default=None, max_length=500)
    expires_at: Optional[datetime] = Field(default=None)
    submitter_user_id: UUID = Field(foreign_key="users.id", index=True)
    status: str = Field(default="pending", max_length=16)
    admin_notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    reviewed_at: Optional[datetime] = Field(default=None)
    reviewed_by: Optional[str] = Field(default=None, max_length=255)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class OrganizerClaim(SQLModel, table=True):
    """User-submitted request related to organizer attribution.

    Two kinds, decided independently:

    - ``kind="badge"``: account-level verified-organizer badge request.
      Approving flips ``users.is_verified_organizer``. Allowed only
      while the user is NOT already verified and has no pending badge
      claim. Carries no event line items.
    - ``kind="events"``: per-event organizer attribution. Allowed only
      for already-verified users. Carries 1..20 event line items
      (rows in ``organizer_claim_events``). Approving an event sets
      ``cached_events.organizer_user_id`` AND inserts a public
      ``UserEventAttendance`` row (organizer auto-going).

    Admin-moderated: status flows ``pending`` → ``approved`` |
    ``rejected``.
    """

    __tablename__ = "organizer_claims"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    # ``badge`` | ``events`` — see class docstring. Legacy rows
    # (created before the split) default to ``badge``.
    kind: str = Field(default="badge", max_length=16, index=True)
    # Legacy column kept for historical rows; new code ignores it and
    # routes badge-vs-events behaviour off ``kind``. Always True for
    # backfilled rows.
    grant_badge: bool = Field(default=True, nullable=False)
    status: str = Field(default="pending", max_length=16, index=True)
    admin_notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    reviewed_at: Optional[datetime] = Field(default=None)
    reviewed_by: Optional[str] = Field(default=None, max_length=255)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class OrganizerClaimEvent(SQLModel, table=True):
    """Per-event line item attached to an :class:`OrganizerClaim`.

    Admins decide each event independently: ``decision`` is
    ``pending`` | ``approved`` | ``rejected``. On approval, the
    corresponding ``cached_events.organizer_user_id`` is set to the
    claim's submitter.
    """

    __tablename__ = "organizer_claim_events"
    __table_args__ = (
        UniqueConstraint("claim_id", "event_id", name="uq_organizer_claim_event"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    claim_id: UUID = Field(foreign_key="organizer_claims.id", index=True)
    event_id: str = Field(foreign_key="cached_events.event_id", index=True)
    decision: str = Field(default="pending", max_length=16)
    created_at: datetime = Field(default_factory=datetime.utcnow)


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
    onboarding_eligible: bool = Field(default=False)
    # Scope separates first-class event taxonomy from review-only aspect tags.
    # 'event' = appears in explorer filter, event tag pills, suggestion form.
    # 'review' = appears in rate-event modal and review-list filter chips only.
    # Mirrors the two-namespace pattern used by Google/Yelp/Airbnb (place
    # attributes vs review aspects). Enforced in routes + suggestion validation.
    scope: str = Field(default="event", index=True)
    # Guards system-relied-upon groups (e.g. "reach", used by
    # interest_notification_service) from admin delete/slug-change.
    protected: bool = Field(default=False)
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
    __table_args__ = (
        UniqueConstraint("event_id", "tag_id", name="uq_event_tag"),
        Index("ix_event_tags_tag_event", "tag_id", "event_id"),
    )

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


class UserInterestProfile(SQLModel, table=True):
    """One opt-in "interest alert" definition: geography + tags.

    Users may define multiple profiles (e.g. "home city" + "upcoming trip").
    A newly-ingested event that matches an enabled profile's tags and
    geography triggers an ``interest_event`` notification (see
    backend/services/interest_notification_service.py). Geography is a
    bounding box (``min_lat``/``min_lng``/``max_lat``/``max_lng``).
    """

    __tablename__ = "user_interest_profiles"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    label: str = Field(max_length=120)
    min_lat: float = Field(...)
    min_lng: float = Field(...)
    max_lat: float = Field(...)
    max_lng: float = Field(...)
    matches_enabled: bool = Field(default=True, nullable=False)
    # Explorer/For-You default filters follow the single active profile per
    # user. Enforced by application code, not a DB constraint (SQLite-friendly).
    is_active: bool = Field(default=False, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class UserInterestProfileTag(SQLModel, table=True):
    """Dance-style and reach tags attached to a ``UserInterestProfile``.

    Mirrors ``UserPreferredTag``/``EventTag``: composite primary key, no
    relationship navigation. Holds both dance-style and reach tag ids; the
    tag's group (via ``Tag.group_id``) determines which PRD matching rule
    applies (OR-within-group). ``ON DELETE CASCADE`` is enforced via the
    migration so deleting a profile or a tag tidies up the join rows.
    """

    __tablename__ = "user_interest_profile_tags"

    profile_id: int = Field(foreign_key="user_interest_profiles.id", primary_key=True)
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
    __table_args__ = (
        UniqueConstraint("device_id", "event_id"),
        Index(
            "ix_user_event_attendances_event_attending_since",
            "event_id",
            "attending_since",
        ),
        Index(
            "ux_user_event_attendances_user_event_authed",
            "user_id",
            "event_id",
            unique=True,
            postgresql_where=text("user_id IS NOT NULL"),
            sqlite_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "ix_user_event_attendances_user_audience_event",
            "user_id",
            "share_audience",
            "event_id",
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    device_id: str = Field(index=True, max_length=64)
    event_id: str = Field(index=True)
    # See ``UserSavedEvent.created_by_admin_user_id``.
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )
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
    # See ``UserSavedEvent.created_by_admin_user_id``.
    created_by_admin_user_id: Optional[UUID] = Field(
        default=None, foreign_key="users.id", index=True
    )


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
    # Phase E (E8). For ``friends``-visibility targets the follow is
    # created with ``status='pending'`` and grants NO visibility until
    # the target approves; for ``public`` targets it is created with
    # ``status='approved'`` (the historical behaviour). Read paths
    # (``is_following``, follower lists, ``can_view``, mutual-follow
    # gates) MUST filter on ``status='approved'``. Pending rows live
    # in the table only to drive the approve/decline inbox surface.
    status: str = Field(default="approved", max_length=16, nullable=False)


class UserReferral(SQLModel, table=True):
    """Invite code an existing user shares with friends (Phase E7).

    One row per inviter (the ``inviter_user_id`` column is uniquely
    constrained), so calls to ``GET /api/social/me/referral`` are
    idempotent — the same code is returned each time. Redeeming a code
    at signup auto-creates a mutual ``UserFollow`` pair between
    inviter and new user (gated on explicit consent surfaced at the
    signup screen per GDPR Art. 7) and increments ``used_count``.
    """

    __tablename__ = "user_referrals"
    __table_args__ = (
        UniqueConstraint("code", name="uq_user_referrals_code"),
        UniqueConstraint("inviter_user_id", name="uq_user_referrals_inviter"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    inviter_user_id: UUID = Field(foreign_key="users.id", index=True)
    # Short opaque case-insensitive identifier (base32, no padding).
    # Surfaced in URLs like ``https://app.example.com/r/{code}``.
    code: str = Field(max_length=24)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    used_count: int = Field(default=0, nullable=False)


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
    )  # subscription_going | subscription_suggested | new_follower | new_friend | follow_request
    event_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    read_at: Optional[datetime] = Field(default=None, index=True)
    # Set once this notification has been included in a batched activity
    # digest email (see ``services/activity_email.py``). NULL means it is
    # still eligible to be emailed; the digest worker stamps this to keep
    # delivery idempotent across loop ticks. ``event_reminder`` rows are
    # emailed inline by the reminder service and are never picked up here.
    emailed_at: Optional[datetime] = Field(default=None, index=True)
    # Set once this notification has been considered for push delivery
    # (see ``services/activity_email.py``). Decoupled from ``emailed_at``
    # because push fires on every dispatch tick (no weekly schedule gate),
    # while email stays batched on the activity-digest schedule — a row can
    # be pushed immediately but wait days to be folded into an email, or
    # vice versa when push is disabled for a recipient.
    pushed_at: Optional[datetime] = Field(default=None, index=True)
    # Free-text context for kinds that need extra message copy beyond
    # actor/event, e.g. ``interest_event`` stores the matched profile
    # label(s) (comma-joined) so the digest/in-app renderers can say
    # "matched your <label> alert" without a second lookup.
    context: Optional[str] = Field(default=None, max_length=200)


class NotificationDelivery(SQLModel, table=True):
    """Audit-log row for one actual distribution event of a Notification.

    Unlike ``Notification.emailed_at``/``pushed_at`` (internal bookkeeping
    stamps that mark a row as "processed this dispatch tick" regardless of
    whether the recipient's channel toggle allowed an actual send), a row
    here is only inserted when the channel genuinely delivered:
      - ``"app"``: inserted immediately when the Notification is created
        (in-app has no opt-out today).
      - ``"email"`` / ``"push"``: inserted only when the corresponding send
        call actually succeeded for a recipient with that feature/channel
        enabled.

    Powers the admin Notifications log (``GET /api/admin/notifications/log``)
    with one row per real delivery event instead of deriving delivery status
    from the mutable bookkeeping timestamps above.
    """

    __tablename__ = "notification_deliveries"

    id: Optional[int] = Field(default=None, primary_key=True)
    notification_id: int = Field(foreign_key="notifications.id", index=True)
    channel: str = Field(index=True)  # "app" | "email" | "push"
    delivered_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class PushSubscription(SQLModel, table=True):
    """A browser Web Push endpoint registered by a visitor.

    One row per browser — the ``endpoint`` URL issued by the push service is
    globally unique, so re-subscribing the same browser upserts on that key
    rather than creating duplicates. Web Push is a device/browser capability,
    not an account feature, so ``user_id`` is nullable: anonymous visitors can
    subscribe, and when they later sign in the same browser re-subscribes and
    binds the endpoint to their account. ``p256dh`` + ``auth`` are the client
    public key + auth secret returned by ``PushManager.subscribe`` and are
    required to encrypt payloads. Stale endpoints (HTTP 404/410 from the push
    service) are deleted by ``services/push_service.py``.
    """

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint", name="uq_push_subscription_endpoint"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)
    endpoint: str = Field(sa_column=Column(Text, nullable=False))
    p256dh: str = Field(max_length=255)
    auth: str = Field(max_length=255)
    user_agent: Optional[str] = Field(default=None, max_length=400)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
