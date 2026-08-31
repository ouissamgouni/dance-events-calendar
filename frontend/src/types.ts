/** Overall experience sentiment (5-point scale). No overall star is shown. */
export type ReviewSentiment = 'amazing' | 'great' | 'okay' | 'disappointing' | 'bad';

/** Tag-group scope: taxonomy/filter tags vs review vocabularies. */
export type TagScope = 'event' | 'aspect' | 'audience' | 'review';

export interface Tag {
    id: number;
    slug: string;
    label: string;
    color: string | null;
    ordinal: number;
    group_slug: string;
    group_label: string;
    group_color: string | null;
    group_scope?: TagScope;
    /** For aspect-scoped tags: whether the tag reads as positive, negative, or factual. */
    polarity?: 'positive' | 'negative' | 'neutral' | null;
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
    scope?: TagScope;
    /** For aspect groups: only offered when the event carries one of these tags. */
    condition_tag_slugs?: string[] | null;
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
    image_url?: string | null;
    location: string | null;
    city?: string | null;
    country?: string | null;
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
    friends_going_count?: number;
    friends_going_preview?: FriendMini[];
    price_min: number | null;
    price_max: number | null;
    price_currency: string | null;
    price_is_free: boolean | null;
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

// --- Event series grouping ---------------------------------------------------

export interface SeriesEventSummary {
    event_id: string;
    title: string;
    start: string;
    end: string;
    calendar_id: string;
    location: string | null;
}

export interface SeriesGroup {
    id: number;
    status: 'pending' | 'resolved' | 'dismissed';
    source: 'auto' | 'manual';
    canonical_title: string;
    created_at: string;
    resolved_at: string | null;
    events: SeriesEventSummary[];
}

export interface SeriesGroupListResponse {
    items: SeriesGroup[];
    total: number;
}

export interface SeriesSplitResponse {
    dissolved: boolean;
    series: SeriesGroup | null;
}

export interface SeriesScanLogEntry {
    id: number;
    scan_type: 'incremental' | 'full' | 'manual';
    triggered_by_event_id: string | null;
    started_at: string;
    finished_at: string | null;
    candidates_found: number;
    groups_created: number;
    status: string;
}

export interface SeriesScanLogListResponse {
    items: SeriesScanLogEntry[];
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
    /** Event "People" tab: attendee is a mutual friend of the viewer. */
    is_friend?: boolean;
    /** Event "People" tab: count of the viewer's friends who follow this attendee. */
    mutual_friend_count?: number;
    /** "going" (RSVP'd) or "interested" (saved). Defaults to "going". */
    attendance_status?: 'going' | 'interested';
}

export interface FriendMini {
    user_id: string;
    handle?: string | null;
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
    price_is_free?: boolean | null;
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
    overall_sentiment: ReviewSentiment;
    /** aspect_slug -> 1-5 score. Only aspects the reviewer chose to rate. */
    aspect_scores: Record<string, number>;
    /** Aspect-scoped review tag ids (from scope='aspect' groups). */
    aspect_tag_ids: number[];
    /** Recommendation-audience tag ids (from the scope='audience' group). */
    audience_tag_ids: number[];
    comment?: string;
    is_anonymous: boolean;
    tag_suggestions: RatingTagSuggestionInline[];
    website?: string; // honeypot
}

export interface EventRating {
    id: string;
    event_id: string;
    overall_sentiment: ReviewSentiment | null;
    aspect_scores: Record<string, number>;
    aspect_tag_ids: number[];
    audience_tag_ids: number[];
    comment: string | null;
    /** Moderation state of the free-text comment only. */
    comment_status: 'none' | 'pending' | 'approved' | 'rejected';
    is_anonymous: boolean;
    status: 'approved' | 'rejected';
    created_at: string;
    updated_at: string;
}

export interface FeedbackSubmissionResponse {
    feedback_submission_id: string;
    rating: EventRating;
    tag_suggestion_ids: number[];
    message: string;
}

export interface TopReviewTag {
    tag_id: number;
    slug: string;
    label: string;
    count: number;
    aspect_slug?: string | null;
}

export interface AspectAggregate {
    aspect_slug: string;
    average: number;
    count: number;
}

export interface EventRatingAggregate {
    event_id: string;
    count: number;
    /** Populated only by the single-event endpoint; empty on the batch endpoint. */
    sentiment_distribution: Partial<Record<ReviewSentiment, number>>;
    aspects: AspectAggregate[];
    top_positive_tags: TopReviewTag[];
    top_neutral_tags: TopReviewTag[];
    top_negative_tags: TopReviewTag[];
    top_audience_tags: TopReviewTag[];
    /** Overall-mood figures. Percentages are unrounded 0-100 (round for display). */
    average_mood: number;
    positive_percentage: number;
    neutral_percentage: number;
    negative_percentage: number;
    /** Public headline label — null until the review count clears the admin threshold. */
    mood_label: string | null;
    /** 'none' (no reviews) | 'early' (below threshold) | 'full' (label shown). */
    display_state: 'none' | 'early' | 'full';
}

export interface SeriesEditionSummary {
    event_id: string;
    title: string;
    start: string;
    end: string | null;
    review_count: number;
    average_mood: number;
    positive_percentage: number;
    mood_label: string | null;
    display_state: 'none' | 'early' | 'full';
}

export interface SeriesRatingRollup {
    series_id: number;
    canonical_title: string;
    edition_count: number;
    reviewed_edition_count: number;
    total_review_count: number;
    average_mood: number;
    positive_percentage: number;
    mood_label: string | null;
    display_state: 'none' | 'early' | 'full';
    sentiment_distribution: Partial<Record<ReviewSentiment, number>>;
    aspects: AspectAggregate[];
    top_positive_tags: TopReviewTag[];
    top_neutral_tags: TopReviewTag[];
    top_negative_tags: TopReviewTag[];
    top_audience_tags: TopReviewTag[];
    editions: SeriesEditionSummary[];
}

export interface EventReviewPublic {
    id: string;
    event_id: string;
    event_title: string;
    event_start: string;
    overall_sentiment: ReviewSentiment | null;
    comment: string | null;
    aspect_tags: Tag[];
    audience_tags: Tag[];
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
    overall_sentiment: ReviewSentiment | null;
    aspect_scores: Record<string, number>;
    aspect_tags: Tag[];
    audience_tags: Tag[];
    comment: string | null;
    comment_status: 'none' | 'pending' | 'approved' | 'rejected';
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
    overall_sentiment: ReviewSentiment | null;
    aspect_scores: Record<string, number>;
    aspect_tag_ids: number[];
    audience_tag_ids: number[];
    comment: string | null;
    comment_status: 'none' | 'pending' | 'approved' | 'rejected';
    is_anonymous: boolean;
    status: 'approved' | 'rejected';
    created_at: string;
    updated_at: string;
}

export interface PendingReview {
    event_id: string;
    event_title: string | null;
    event_start: string | null;
    event_end: string | null;
    /** Social proof line ("Laura", "Laura and Marc", "Laura, Marc +3 others")
     * for followed users who already reviewed; null when no nameable proof. */
    friend_proof: string | null;
}

export interface PassportStats {
    total_events_attended: number;
    cities_visited: number;
    countries_visited: number;
    reviews_written: number;
    styles_danced: number;
    top_style: string | null;
    active_months_last_12: number;
    active_months_this_year: number;
    events_last_30_days: number;
    avg_gap_days: number | null;
    first_event_date: string | null;
    member_since: string;
    dancing_since: string | null;
}

export interface PassportCityCollection {
    city: string;
    country: string | null;
    count: number;
    latitude: number | null;
    longitude: number | null;
}

export interface PassportCountryCollection {
    country: string;
    count: number;
}

export interface PassportCollections {
    cities: PassportCityCollection[];
    countries: PassportCountryCollection[];
}

export interface PassportMapEvent extends CalendarEvent {
    city: string | null;
    country: string | null;
}

export interface PassportMilestone {
    key: string;
    name: string;
    description: string;
    achieved_description: string;
    icon: string;
    category: string;
    threshold: number;
    unit: string;
    /** Cross-category rarity/impressiveness rank (higher = more distinctive). */
    prestige: number;
    progress: number;
    unlocked: boolean;
    is_new: boolean;
    unlocked_at: string | null;
}

/** One calendar month with the count of attended events ("YYYY-MM"). */
export interface MonthlyActivity {
    month: string;
    count: number;
}

export interface PassportResponse {
    stats: PassportStats;
    collections: PassportCollections;
    milestones: PassportMilestone[];
    consistency: PassportConsistency | null;
    monthly_activity: MonthlyActivity[];
}

/** A permanent earned consistency card: one upward reach of a level within a
 * period. Repeats are never merged — each reach is its own card. The displayed
 * range runs `period_start` → `reached` and may cross calendar years. */
export interface ConsistencyEarnedCard {
    key: string;
    level_key: string;
    name: string;
    icon: string;
    threshold: number;
    period_start: string;
    reached: string;
    is_current: boolean;
}

/** A not-yet-reached level for the current open period (or every level when no
 * period is open). `active_months` is the current rolling progress numerator. */
export interface ConsistencyLockedCard {
    key: string;
    name: string;
    icon: string;
    threshold: number;
    active_months: number;
}

/** The strongest consistency level ever reached (all-time highlight). */
export interface ConsistencyTop {
    key: string;
    name: string;
    icon: string;
    threshold: number;
    times: number;
}

/** A calendar year's independent consistency classification (Jan–Dec). */
export interface ConsistencyYearLevel {
    year: number;
    active_months: number;
    key: string | null;
    name: string | null;
    icon: string | null;
    threshold: number | null;
}

export interface ConsistencyNewReach {
    key: string;
    name: string;
    icon: string;
    period_start: string;
}

/** Recurring consistency achievements derived from attended events. */
export interface PassportConsistency {
    active: boolean;
    active_months: number;
    window: number;
    earned: ConsistencyEarnedCard[];
    locked: ConsistencyLockedCard[];
    top: ConsistencyTop | null;
    by_year: ConsistencyYearLevel[];
    new: ConsistencyNewReach[];
}

export type PassportSection = 'milestones' | 'timeline' | 'cities' | 'countries';

export interface SharedPassportResponse {
    display_name: string | null;
    avatar_url: string | null;
    stats: PassportStats;
    collections: PassportCollections;
    milestones: PassportMilestone[];
    // Populated only when 'milestones' is in `sections`.
    consistency: PassportConsistency | null;
    events: PassportMapEvent[];
    // Sections the owner opted to share; pass straight to PassportView.
    sections: PassportSection[];
    // Populated only when 'timeline' is in `sections`.
    timeline_items: PassportTimelineItem[];
    timeline_markers: PassportTimelineMarker[];
    // Populated only when 'timeline' is in `sections` (privacy gate).
    monthly_activity: MonthlyActivity[];
    // Follow CTA context: owner handle + viewer relationship.
    handle: string | null;
    is_self: boolean;
    is_following: boolean;
}

export interface PassportTimelineItem {
    event_id: string;
    title: string;
    start: string;
    location: string | null;
    city: string | null;
    country: string | null;
    tags: string[];
    latitude: number | null;
    longitude: number | null;
}

export interface PassportTimelineMarker {
    key: string;
    name: string;
    icon: string;
    description?: string | null;
    date: string;
    event_id?: string | null;
    /** Optional secondary line (recurring consistency reaches use it). */
    label?: string | null;
    /** Displayed period range ("YYYY-MM") for consistency reaches; null for
     * event milestones. The client formats the human range (e.g. "Jan–Nov 2026"). */
    period_start?: string | null;
    period_end?: string | null;
}

export interface PassportTimelineResponse {
    items: PassportTimelineItem[];
    markers: PassportTimelineMarker[];
    total: number;
}
