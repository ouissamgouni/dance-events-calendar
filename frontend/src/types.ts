export interface Tag {
    id: number;
    slug: string;
    label: string;
    color: string | null;
    ordinal: number;
    group_slug: string;
    group_label: string;
    group_color: string | null;
    event_count?: number;
    enabled: boolean;
    is_hero_filter: boolean;
    hero_ordinal: number | null;
}

export interface TagGroup {
    id: number;
    slug: string;
    label: string;
    color: string | null;
    ordinal: number;
    allow_multiple: boolean;
    enabled: boolean;
    onboarding_eligible: boolean;
    scope?: 'event' | 'review';
    tags: Tag[];
}

export interface TagSuggestionCreate {
    event_id: string;
    tag_id?: number;
    free_text?: string;
    group_slug?: string;
    device_id: string;
    website?: string; // honeypot
}

export interface TagSuggestionResponse {
    id: number;
    event_id: string;
    event_title: string | null;
    event_description?: string | null;
    event_start?: string | null;
    event_location?: string | null;
    tag: Tag | null;
    free_text: string | null;
    group_slug: string | null;
    status: string;
    submitter_device_id: string | null;
    admin_notes: string | null;
    reviewed_at: string | null;
    created_at: string;
    /** 'user' for end-user submissions, 'heuristic' for pipeline-generated suggestions. */
    source?: 'user' | 'heuristic' | string;
    /** 0.0-1.0 confidence score, populated for auto-generated rows only. */
    confidence?: number | null;
    /** Lower-cased terms that triggered a heuristic match (admin transparency tooltip). */
    matched_terms?: string[] | null;
}

export interface TagSuggestionRunResponse {
    generated: number;
    skipped: number;
    replaced: number;
    suggestions: TagSuggestionResponse[];
}

export interface BulkTagSuggestionRunResponse {
    generated: number;
    skipped: number;
    replaced: number;
    events_processed: number;
}

export interface LinkItem {
    url: string;
    label: string | null;
}

export interface CalendarEvent {
    event_id: string;
    calendar_id: string;
    title: string;
    description: string | null;
    location: string | null;
    latitude: number | null;
    longitude: number | null;
    start: string;
    end: string;
    all_day: boolean;
    color: string | null;
    view_count: number;
    going_count?: number;
    /** Distinct savers (UserSavedEvent rows). 0 when not surfaced by the endpoint. */
    saved_count?: number;
    /**
     * Commitment-weighted, time-decayed popularity score. Set by the server
     * when ``trending_enabled`` is on; otherwise 0. Use this (not
     * ``view_count``) to drive the "Trending" badge and sort.
     */
    popularity_score?: number;
    /**
     * Count of the viewer's mutual friends with an audience-passing "going"
     * or "saved" row on this event. Populated only when the
     * ``following_badge_enabled`` site setting is on AND the viewer is
     * signed in; otherwise 0.
     */
    following_friend_count?: number;
    /**
     * Up to 5 mutual friends (subset of ``following_friend_count``) used by
     * the card's combined avatar track to render *who* — friends first.
     */
    following_friends_preview?: FriendMini[];
    price_min: number | null;
    price_max: number | null;
    price_currency: string | null;
    price_is_free: boolean;
    review_status?: string;
    is_hidden?: boolean;
    is_blocked?: boolean;
    links: LinkItem[] | null;
    tags: Tag[];
    /** Server-computed: at least one approved, non-expired promo code exists.
     * Drives the badge/count next to the price block. */
    has_active_promo_codes?: boolean;
    /**
     * Per-event overrides for the ``show_prices`` / ``promo_codes_enabled``
     * global feature flags. ``null``/``undefined`` means "inherit the
     * global flag"; ``true``/``false`` force the section on/off for this
     * event only. Set from the admin event detail page.
     */
    show_price_override?: boolean | null;
    show_promo_override?: boolean | null;
    /** Approved organizer claim for this event (or null). */
    organizer?: EventOrganizerMini | null;
}

export interface EventOrganizerMini {
    user_id: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
}

// --- User-submitted promo codes --------------------------------------------

export interface PromoCodeSubmitter {
    user_id: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
}

export interface PromoCode {
    id: string;
    event_id: string;
    code: string;
    description: string | null;
    source_url: string | null;
    expires_at: string | null;
    status: 'pending' | 'approved' | 'rejected';
    submitter: PromoCodeSubmitter;
    created_at: string;
    updated_at: string;
}

export interface PromoCodeAdmin extends PromoCode {
    admin_notes: string | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
    event_title: string | null;
}

export interface PromoCodeCreate {
    code: string;
    description?: string | null;
    source_url?: string | null;
    expires_at?: string | null;
}

export type PromoCodeUpdate = Partial<PromoCodeCreate>;

// --- Organizer claims ------------------------------------------------------

export interface OrganizerClaimEvent {
    event_id: string;
    event_title: string | null;
    event_start: string | null;
    decision: 'pending' | 'approved' | 'rejected';
}

export interface OrganizerClaim {
    id: string;
    user_id: string;
    kind: 'badge' | 'events';
    status: 'pending' | 'approved' | 'rejected';
    admin_notes: string | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
    created_at: string;
    events: OrganizerClaimEvent[];
}

export interface OrganizerClaimAdmin extends OrganizerClaim {
    user_handle: string | null;
    user_display_name: string | null;
    user_email: string | null;
    user_avatar_url: string | null;
    user_bio: string | null;
    user_instagram_url: string | null;
    user_facebook_url: string | null;
}

export interface OrganizerClaimCreate {
    kind: 'badge' | 'events';
    event_ids?: string[];
}

export interface OrganizerClaimDecide {
    grant_badge: boolean;
    approved_event_ids: string[];
    rejected_event_ids: string[];
    admin_notes?: string | null;
    overwrite?: boolean;
}

// --- Duplicate detection ----------------------------------------------------

export interface DuplicateEventSummary {
    event_id: string;
    title: string;
    start: string;
    end: string;
    calendar_id: string;
    is_hidden: boolean;
    is_blocked: boolean;
    rejected_duplicate_reason: string | null;
}

export interface DuplicateGroup {
    id: number;
    status: 'pending' | 'resolved' | 'dismissed';
    source: 'auto' | 'manual';
    kept_event_id: string | null;
    created_at: string;
    resolved_at: string | null;
    events: DuplicateEventSummary[];
}

export interface DuplicateGroupListResponse {
    items: DuplicateGroup[];
    total: number;
}

export interface DuplicateScanLogEntry {
    id: number;
    scan_type: 'incremental' | 'full' | 'manual_pair';
    triggered_by_event_id: string | null;
    started_at: string;
    finished_at: string | null;
    candidates_found: number;
    groups_created: number;
    status: string;
}

export interface DuplicateScanLogListResponse {
    items: DuplicateScanLogEntry[];
    total: number;
}

export interface CalendarSetting {
    calendar_id: string;
    name: string;
    enabled: boolean;
    show_events: boolean;
    color: string | null;
}

export interface Attendee {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
    handle: string | null;
    viewer_follow_status?: 'pending' | 'approved';
}

export interface FriendMini {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
}

export interface AttendanceSummary {
    event_id: string;
    total_going: number;
    total_saved: number;
    public_going: number;
    anonymous_going: number;
    can_view_attendees: boolean;
    viewer_is_sharing: boolean;
    preview_attendees: Attendee[];
}

export interface AttendingEventEntry {
    event_id: string;
    share_publicly: boolean;
    share_audience?: 'public' | 'friends' | 'private';
}

export interface SavedEventEntry {
    event_id: string;
    audience: 'public' | 'friends' | 'private';
}

export interface AppInfo {
    environment: string;
    backend_version: string;
    frontend_version?: string | null;
    db_schema_version?: string | null;
    qa_scenarios?: string[];
    analytics_enabled?: boolean;
}

export interface TestStep {
    id: number;
    title: string;
    description: string;
    /**
     * Either a plain string, or a labeled-variants object used by the
     * map-clustering scenario to contrast current vs. future-work
     * acceptance (keys are free-form, e.g. ``current`` /
     * ``future_clustering``).
     */
    expected: string | Record<string, string>;
    verification: string;
}

export interface TestPlan {
    name: string;
    description: string;
    scenario: string;
    steps: TestStep[];
}

export interface EventSuggestionCreate {
    title: string;
    description?: string;
    location?: string;
    links?: LinkItem[];
    latitude?: number;
    longitude?: number;
    start: string;
    end: string;
    all_day?: boolean;
    submitter_name?: string;
    submitter_email?: string;
    suggested_tag_ids?: number[];
    suggested_new_tags?: { free_text: string; group_slug?: string | null }[];
    going?: boolean;
    going_audience?: 'public' | 'friends' | 'private' | null;
    promo_code?: string | null;
    promo_description?: string | null;
    promo_source_url?: string | null;
    price_min?: number | null;
    price_max?: number | null;
    price_currency?: string | null;
    price_is_free?: boolean;
    /** When True (default), an approved suggestion is auto-saved to the
     * authenticated submitter's Calendar. Has no effect for anonymous
     * submissions. */
    auto_save?: boolean;
    website?: string; // honeypot
    screen_size?: string;
    timezone?: string;
}

export interface EventSuggestion {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    links: LinkItem[] | null;
    latitude: number | null;
    longitude: number | null;
    start: string;
    end: string;
    all_day: boolean;
    submitter_name: string | null;
    submitter_email: string | null;
    submitter_ip: string | null;
    submitter_user_agent: string | null;
    submitter_language: string | null;
    submitter_referrer: string | null;
    submitter_screen_size: string | null;
    submitter_timezone: string | null;
    submitter_city: string | null;
    submitter_country: string | null;
    submitter_lat: number | null;
    submitter_lng: number | null;
    status: string;
    admin_notes: string | null;
    assigned_calendar_id: string | null;
    created_event_id: string | null;
    synced_to_google: boolean;
    google_event_id: string | null;
    suggested_tag_ids?: number[] | null;
    promo_code?: string | null;
    promo_description?: string | null;
    promo_source_url?: string | null;
    price_min?: number | null;
    price_max?: number | null;
    price_currency?: string | null;
    price_is_free?: boolean;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
}

// --- Ratings / Feedback ---

export interface RatingTagSuggestionInline {
    tag_id?: number;
    free_text?: string;
    group_slug?: string;
}

export interface FeedbackSubmissionCreate {
    stars: number;
    comment?: string;
    review_tag_ids: number[];
    is_anonymous: boolean;
    tag_suggestions: RatingTagSuggestionInline[];
    website?: string; // honeypot
}

export interface EventRating {
    id: string;
    event_id: string;
    stars: number;
    comment: string | null;
    review_tag_ids: number[];
    is_anonymous: boolean;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    updated_at: string;
}

export interface FeedbackSubmissionResponse {
    feedback_submission_id: string;
    rating: EventRating;
    tag_suggestion_ids: number[];
    message: string;
}

export interface EventRatingAggregate {
    event_id: string;
    average: number;
    count: number;
    distribution: Record<number, number>;
}

export interface EventReviewPublic {
    id: string;
    stars: number;
    comment: string | null;
    review_tags: Tag[];
    reviewer_label: string;
    created_at: string;
}

export interface EventReviewsList {
    items: EventReviewPublic[];
    total: number;
}

export interface AdminRating {
    id: string;
    event_id: string;
    event_title: string | null;
    user_email: string | null;
    user_display_name: string | null;
    is_anonymous: boolean;
    stars: number;
    comment: string | null;
    review_tags: Tag[];
    feedback_submission_id: string | null;
    linked_tag_suggestion_ids: number[];
    status: 'pending' | 'approved' | 'rejected';
    admin_notes: string | null;
    submitter_ip: string | null;
    submitter_user_agent: string | null;
    submitter_country: string | null;
    auto_flagged: boolean;
    reviewed_at: string | null;
    reviewed_by: string | null;
    created_at: string;
}

export interface AdminRatingList {
    items: AdminRating[];
    total: number;
    page: number;
    page_size: number;
}

export interface MyRating {
    id: string;
    event_id: string;
    event_title: string | null;
    event_start: string | null;
    stars: number;
    comment: string | null;
    review_tag_ids: number[];
    is_anonymous: boolean;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    updated_at: string;
}
