import type { CalendarEvent, CalendarSetting, AppInfo, TestPlan, EventSuggestionCreate, EventSuggestion, Tag, TagGroup, TagSuggestionCreate, TagSuggestionResponse, TagSuggestionRunResponse, BulkTagSuggestionRunResponse, FeedbackSubmissionCreate, FeedbackSubmissionResponse, EventRating, EventRatingAggregate, EventReviewsList, MyRating, AdminRating, AdminRatingList, Attendee, AttendanceSummary, AttendingEventEntry, SavedEventEntry, PromoCode, PromoCodeAdmin, PromoCodeCreate, PromoCodeUpdate, OrganizerClaim, OrganizerClaimAdmin, OrganizerClaimCreate, OrganizerClaimDecide } from './types';
import type { DateRangePresetKey } from './utils/dateRangePresets';

declare const __VITE_API_URL__: string;

const resolveApiBase = (): string => {
    // In Vite dev server, keep relative /api so proxy rules apply.
    if (import.meta.env.DEV) return '/api';

    const rawApiUrl = (__VITE_API_URL__ || import.meta.env.VITE_API_URL || '').trim();
    if (!rawApiUrl) {
        // Fallback for Pages deployments if build env injection is missing.
        // Custom-domain hosts use same-site API subdomains so the session
        // cookie is treated as first-party (avoids third-party cookie blocking
        // by Chrome/Safari ITP). Pages preview hostnames fall back to the
        // direct Fly host (cross-site, but not used in normal user flow).
        if (typeof window !== 'undefined') {
            const host = window.location.hostname;
            if (host === 'joinmovida.com') return 'https://api.joinmovida.com/api';
            if (host === 'develop.joinmovida.com') return 'https://api-develop.joinmovida.com/api';
            if (host === 'movida.pages.dev') return 'https://movida.fly.dev/api';
            if (host.endsWith('.movida.pages.dev')) return 'https://movida-staging.fly.dev/api';
        }
        return '/api';
    }
    const normalized = rawApiUrl.replace(/\/+$/, '');
    return normalized.endsWith('/api') ? normalized : `${normalized}/api`;
};

const BASE = resolveApiBase();

const parseJsonResponse = async <T>(res: Response, fallbackMessage: string): Promise<T> => {
    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    if (!res.ok) {
        let detail: string | null = null;
        if (contentType.includes('application/json') && bodyText) {
            try {
                const errorBody = JSON.parse(bodyText) as { detail?: unknown; message?: unknown };
                // FastAPI wraps validation errors as ``detail: [{loc, msg, ...}]``;
                // surface the first ``msg`` so the toast is human-readable
                // instead of "[object Object]".
                if (Array.isArray(errorBody.detail) && errorBody.detail.length > 0) {
                    const first = errorBody.detail[0] as { msg?: unknown };
                    if (typeof first?.msg === 'string') detail = first.msg;
                } else if (typeof errorBody.detail === 'string') {
                    detail = errorBody.detail;
                } else if (typeof errorBody.message === 'string') {
                    detail = errorBody.message;
                }
            } catch {
                // body wasn't valid JSON despite the header — fall through.
            }
        }
        // Throw OUTSIDE the parse try/catch so the detail isn't swallowed by
        // the fallback. Previous shape buried the real message because the
        // ``throw new Error(detail)`` lived inside the same try block.
        throw new Error(detail ? detail : `${fallbackMessage} (HTTP ${res.status})`);
    }

    if (!bodyText) return {} as T;

    if (!contentType.includes('application/json')) {
        const htmlReply = /^\s*</.test(bodyText);
        const hint = htmlReply
            ? 'Received HTML instead of JSON. Check VITE_API_URL and API routing.'
            : 'Response was not JSON.';
        throw new Error(`${fallbackMessage}: ${hint}`);
    }

    try {
        return JSON.parse(bodyText) as T;
    } catch {
        throw new Error(`${fallbackMessage}: Invalid JSON response`);
    }
};

export async function fetchEvents(
    params?: {
        startDate?: string;
        endDate?: string;
        tagIds?: number[];
        area?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
        friendsGoing?: boolean;
        friendsSaved?: boolean;
        friendHandle?: string;
        interestSource?: 'follows' | 'friends';
        interestKind?: 'any' | 'going' | 'saved';
        interestUserHandle?: string;
    },
    opts?: { fresh?: boolean },
): Promise<CalendarEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set('start_date', params.startDate);
    if (params?.endDate) searchParams.set('end_date', params.endDate);
    if (params?.tagIds?.length) searchParams.set('tag_ids', params.tagIds.join(','));
    if (params?.area) {
        searchParams.set('min_lat', String(params.area.min_lat));
        searchParams.set('min_lng', String(params.area.min_lng));
        searchParams.set('max_lat', String(params.area.max_lat));
        searchParams.set('max_lng', String(params.area.max_lng));
    }
    if (params?.friendsGoing) searchParams.set('friends_going', 'true');
    if (params?.friendsSaved) searchParams.set('friends_saved', 'true');
    if (params?.friendHandle) searchParams.set('friend_handle', params.friendHandle);
    if (params?.interestSource) searchParams.set('interest_source', params.interestSource);
    if (params?.interestKind) searchParams.set('interest_kind', params.interestKind);
    if (params?.interestUserHandle) searchParams.set('interest_user_handle', params.interestUserHandle);
    const qs = searchParams.toString();
    // Friend-filter params require the session cookie to identify the viewer
    // and apply mutual-follower checks; sending credentials is harmless for
    // anonymous reads (the backend treats them as no viewer).
    const init: RequestInit = {
        credentials: 'include',
    };
    if (opts?.fresh) init.cache = 'no-store';
    const res = await fetch(`${BASE}/events${qs ? `?${qs}` : ''}`, init);
    return parseJsonResponse<CalendarEvent[]>(res, 'Failed to fetch events');
}

export interface EventsPage {
    events: CalendarEvent[];
    hasMore: boolean;
}

/**
 * Paginated variant of {@link fetchEvents}, used by "+more" affordances
 * (e.g. the ForYouRail lenses) that page through the server rather than
 * revealing a locally-buffered slice. ``hasMore`` reflects the
 * ``X-Has-More`` response header set by the backend when ``limit`` is
 * supplied.
 */
export async function fetchEventsPage(
    params: {
        startDate?: string;
        endDate?: string;
        tagIds?: number[];
        area?: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null;
        friendsGoing?: boolean;
        friendsSaved?: boolean;
        friendHandle?: string;
        interestSource?: 'follows' | 'friends';
        interestKind?: 'any' | 'going' | 'saved';
        interestUserHandle?: string;
        profiles?: 'me';
        limit: number;
        offset?: number;
    },
    opts?: { fresh?: boolean },
): Promise<EventsPage> {
    const searchParams = new URLSearchParams();
    if (params.startDate) searchParams.set('start_date', params.startDate);
    if (params.endDate) searchParams.set('end_date', params.endDate);
    if (params.tagIds?.length) searchParams.set('tag_ids', params.tagIds.join(','));
    if (params.area) {
        searchParams.set('min_lat', String(params.area.min_lat));
        searchParams.set('min_lng', String(params.area.min_lng));
        searchParams.set('max_lat', String(params.area.max_lat));
        searchParams.set('max_lng', String(params.area.max_lng));
    }
    if (params.friendsGoing) searchParams.set('friends_going', 'true');
    if (params.friendsSaved) searchParams.set('friends_saved', 'true');
    if (params.friendHandle) searchParams.set('friend_handle', params.friendHandle);
    if (params.interestSource) searchParams.set('interest_source', params.interestSource);
    if (params.interestKind) searchParams.set('interest_kind', params.interestKind);
    if (params.interestUserHandle) searchParams.set('interest_user_handle', params.interestUserHandle);
    if (params.profiles) searchParams.set('profiles', params.profiles);
    searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    const init: RequestInit = {
        credentials: 'include',
    };
    if (opts?.fresh) init.cache = 'no-store';
    const res = await fetch(`${BASE}/events?${qs}`, init);
    const events = await parseJsonResponse<CalendarEvent[]>(res, 'Failed to fetch events');
    return { events, hasMore: res.headers.get('X-Has-More') === 'true' };
}

export async function fetchEvent(eventId: string, opts?: { fresh?: boolean }): Promise<CalendarEvent> {
    // `fresh: true` bypasses the browser HTTP cache. The public endpoint sets
    // `Cache-Control: public, max-age=60`; admin flows that re-fetch after a
    // mutation (approve a tag suggestion, edit a field, retry geocoding…) need
    // the fresh server state immediately.
    const init: RequestInit = opts?.fresh ? { cache: 'no-store' } : {};
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}`, init);
    if (!res.ok) throw new Error('Failed to fetch event');
    return res.json();
}

export interface SiteSettings {
    since_date: string;
    sync_since_date: string;
    sync_interval_minutes: number;
    auto_sync_enabled: boolean;
    auto_sync_mode: 'incremental' | 'reseed';
    show_prices: boolean;
    show_popularity: boolean;
    show_ratings: boolean;
    popularity_threshold: number;
    // Adoption-boost feature toggles. Optional so older API responses
    // (e.g. cached or pre-deploy) still parse — defaults are applied in
    // FeatureFlagsContext.
    following_badge_enabled?: boolean;
    unseen_state_enabled?: boolean;
    trending_enabled?: boolean;
    trending_banner_enabled?: boolean;
    trending_window_days?: number;
    trending_floor_going?: number;
    trending_top_n?: number;
    trending_top_percent?: number;
    event_color_bar_color: string;
    tag_sort_mode: 'group' | 'event_count';
    default_explorer_period?: DateRangePresetKey;
    promo_codes_enabled?: boolean;
    organizer_claims_enabled?: boolean;
    for_you_rail_enabled?: boolean;
    your_next_events_rail_enabled?: boolean;
    tag_as_badge_enabled?: boolean;
    /** When true (and tag_as_badge_enabled is on), tag badges use their
     * defined group color; when false, tags render on a neutral light-grey
     * background. Client default: false. */
    tag_badge_colored?: boolean;
    /** When true, the Trending trail's compact cards additionally show
     * tags and the AttendeeAvatarStack. Client default: false. */
    trending_trail_rich_enabled?: boolean;
    /** Maximum number of tags rendered inline on an event card. Client
     * default: 3. */
    tags_per_card?: number;
    /** Global notification / re-engagement gates (admin-configurable).
     * Each flag mirrors an env-var in ``backend/config/loader.py``; when
     * set here it overrides that default without requiring a redeploy. */
    event_reminders_enabled?: boolean;
    activity_digest_email_enabled?: boolean;
    interest_match_notifications_enabled?: boolean;
    web_push_enabled?: boolean;
    /** Hours before an event's start when the reminder is fired. 1-720. */
    reminder_lead_hours?: number;
    /** Cadence for the activity-digest email in the format
     * ``<mon|tue|...>[,<day>...] @ HH:MM`` interpreted in each recipient's
     * ``User.timezone``. Default = twice a week (``tue,fri @ 09:00``). */
    activity_digest_schedule?: string;
    /** Max matched events shown inline in an interest-match digest email
     * before the rest collapse behind a "Discover more" link to "For
     * you". 1-50, client default 10. */
    interest_match_max_events_per_email?: number;
}

export async function fetchSettings(): Promise<SiteSettings> {
    const res = await fetch(`${BASE}/settings`);
    return parseJsonResponse<SiteSettings>(res, 'Failed to fetch settings');
}

export async function updateSettings(settings: Partial<SiteSettings>): Promise<SiteSettings> {
    const res = await fetch(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update settings');
    return res.json();
}

// --- Admin: notification debugging / manual overrides ---

export interface EffectiveConfigEntry {
    effective: unknown;
    source: 'site_setting' | 'env_or_default' | 'env_only';
    env_or_default_value?: unknown;
}

export type NotificationsEffectiveConfig = Record<string, EffectiveConfigEntry>;

export async function fetchNotificationsEffectiveConfig(): Promise<NotificationsEffectiveConfig> {
    const res = await fetch(`${BASE}/admin/notifications/effective-config`, { credentials: 'include' });
    return parseJsonResponse<NotificationsEffectiveConfig>(res, 'Failed to fetch effective notification config');
}

export interface WebPushSubscriberCount {
    subscriber_count: number;
}

export async function fetchWebPushSubscriberCount(): Promise<WebPushSubscriberCount> {
    const res = await fetch(`${BASE}/admin/notifications/webpush/subscriber-count`, { credentials: 'include' });
    return parseJsonResponse<WebPushSubscriberCount>(res, 'Failed to fetch web push subscriber count');
}

export interface ForceSendUserResult {
    user_id: string;
    email: string;
    status: 'sent' | 'no_pending_notifications' | 'skipped_disabled' | 'skipped_not_found';
}

export interface ForceInterestMatchSendResponse {
    candidates_scanned: number;
    notifications_created: number;
    digests_sent: number;
    pushes_sent: number;
    results: ForceSendUserResult[];
}

export async function forceSendInterestMatches(
    userIds: string[],
    lookbackHours: number,
): Promise<ForceInterestMatchSendResponse> {
    const res = await fetch(`${BASE}/admin/notifications/interest-match/force-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ user_ids: userIds, lookback_hours: lookbackHours }),
    });
    return parseJsonResponse<ForceInterestMatchSendResponse>(res, 'Failed to force-send interest matches');
}

export interface ForceInterestMatchPreviewUser {
    user_id: string;
    email: string;
    matched_events: number;
    new_events: number;
}

export interface ForceInterestMatchPreviewResponse {
    candidates_scanned: number;
    results: ForceInterestMatchPreviewUser[];
}

export async function previewInterestMatches(
    userIds: string[],
    lookbackHours: number,
): Promise<ForceInterestMatchPreviewResponse> {
    const res = await fetch(`${BASE}/admin/notifications/interest-match/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ user_ids: userIds, lookback_hours: lookbackHours }),
    });
    return parseJsonResponse<ForceInterestMatchPreviewResponse>(res, 'Failed to preview interest matches');
}

export interface DigestSendNowResponse {
    digests_sent: number;
    pushes_sent: number;
    stamped: number;
    results: ForceSendUserResult[];
}

export async function sendDigestNow(
    userIds: string[],
    maxNotificationsPerUser?: number,
    resend?: boolean,
): Promise<DigestSendNowResponse> {
    const body: Record<string, unknown> = { user_ids: userIds };
    if (maxNotificationsPerUser != null) body.max_notifications_per_user = maxNotificationsPerUser;
    if (resend) body.resend = true;
    const res = await fetch(`${BASE}/admin/notifications/digest/send-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<DigestSendNowResponse>(res, 'Failed to send digest now');
}

export interface NotificationToggleCountEntry {
    email: number;
    push: number;
}

export interface NotificationToggleCounts {
    total_users: number;
    interest_match: NotificationToggleCountEntry;
    event_reminders: NotificationToggleCountEntry;
    activity_digest: NotificationToggleCountEntry;
}

export async function fetchNotificationToggleCounts(): Promise<NotificationToggleCounts> {
    const res = await fetch(`${BASE}/admin/notifications/toggle-counts`, { credentials: 'include' });
    return parseJsonResponse<NotificationToggleCounts>(res, 'Failed to fetch notification toggle counts');
}

export type NotificationLogType = 'interest_match' | 'activity_digest' | 'event_reminder';
export type NotificationLogChannel = 'app' | 'email' | 'push';

export interface NotificationLogEntry {
    id: number;
    notification_id: number;
    delivered_at: string;
    kind: string;
    type: NotificationLogType | string;
    channel: NotificationLogChannel | string;
    recipient_user_id: string;
    recipient_email: string;
    recipient_handle: string | null;
    recipient_display_name: string | null;
    summary: string;
    actor_display_name: string | null;
    actor_handle: string | null;
    event_id: string | null;
    event_title: string | null;
    context: string | null;
}

export interface NotificationLogList {
    items: NotificationLogEntry[];
    total: number;
}

export async function fetchAdminNotificationsLog(
    opts?: { type?: NotificationLogType; channel?: NotificationLogChannel; q?: string; limit?: number; offset?: number },
): Promise<NotificationLogList> {
    const sp = new URLSearchParams();
    if (opts?.type) sp.set('type', opts.type);
    if (opts?.channel) sp.set('channel', opts.channel);
    if (opts?.q) sp.set('q', opts.q);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/admin/notifications/log${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<NotificationLogList>(res, 'Failed to fetch notifications log');
}

export async function trackEventView(eventId: string, deviceId?: string, source?: string): Promise<void> {
    const body: Record<string, string> = { event_id: eventId };
    if (deviceId) body.device_id = deviceId;
    if (source) body.source = source;
    await fetch(`${BASE}/track/event-view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

export async function fetchAdminCalendars(): Promise<CalendarSetting[]> {
    const res = await fetch(`${BASE}/admin/calendars`);
    if (!res.ok) throw new Error('Failed to fetch calendars');
    return res.json();
}

export async function fetchCalendars(): Promise<CalendarSetting[]> {
    const res = await fetch(`${BASE}/events/calendars`);
    if (!res.ok) throw new Error('Failed to fetch calendars');
    return res.json();
}

export async function updateCalendar(
    calendarId: string,
    update: { enabled?: boolean; show_events?: boolean; color?: string; name?: string },
): Promise<CalendarSetting> {
    const res = await fetch(`${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update calendar');
    return res.json();
}

export async function discoverCalendars(): Promise<{ discovered: number; total: number }> {
    const res = await fetch(`${BASE}/admin/discover`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to discover calendars');
    return res.json();
}

export async function addCalendar(calendarId: string): Promise<CalendarSetting> {
    const res = await fetch(`${BASE}/admin/calendars`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_id: calendarId }),
        credentials: 'include',
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to add calendar');
    }
    return res.json();
}

export interface SyncStats {
    calendars_synced: number;
    events_upserted: number;
    events_deleted: number;
    enrichment_queued: number;
}

// --- Auth ---

export interface AuthMode {
    dev_auth: boolean;
    google_client_id: string;
}

export async function fetchAuthMode(): Promise<AuthMode> {
    const res = await fetch(`${BASE}/auth/mode`);
    if (!res.ok) return { dev_auth: false, google_client_id: '' };
    return res.json();
}

export interface PreferredAreaPayload {
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
    label: string;
}

export interface HomeLocationPayload {
    lat: number;
    lng: number;
    label: string;
}

export type HomeLocationResponse = HomeLocationPayload;

export interface UserPreferences {
    share_attendance_default: boolean;
    preferred_area: PreferredAreaPayload | null;
    preferred_tag_ids: number[];
    /** Home pin used as the default center for radius-mode interest
     * profiles. Null until the user sets one (onboarding or Settings). */
    home_location: HomeLocationResponse | null;
    /** ISO timestamp; null until the user (or anon→authed merge) has
     * explicitly saved preferences. */
    set_at: string | null;
}

export interface AuthUser {
    user_id?: string;
    email: string;
    name: string;
    handle?: string | null;
    /** Opaque attribution token appended to shared URLs as `?ref=share&src=`.
     *  Present once the user record is post-`h2b3c4d5e6f8` (auto-backfilled
     *  on the first /me call). Null only in transient pre-backfill states. */
    share_code?: string | null;
    avatar_url?: string | null;
    is_admin?: boolean;
    share_attendance_default?: boolean;
    /** New 3-tier replacement for ``share_attendance_default``. May be
     * absent on older payloads — fall back to the boolean. */
    share_attendance_default_audience?: 'public' | 'friends' | 'private';
    /** Full preferences blob. Always present on /auth/me and /auth/google
     * after the preferences feature shipped. */
    preferences?: UserPreferences;
    /** Only present on the /auth/google response — lets the client emit
     * `signup_completed` vs `login_completed`. Absent on /auth/me. */
    is_new_user?: boolean;
    /** Phase E (E2): viewer's own friend count (mutual follows). Used by
     *  AudiencePicker to surface a "no friends yet" hint when the user
     *  picks the ``friends`` audience. Null/undefined for anon. */
    friend_count?: number;
    /** Phase E (E3): ISO-8601 timestamp of onboarding completion (or
     *  skip). When ``null`` the frontend route guard redirects to
     *  ``/onboarding/follow`` after first-load. Absent for anon. */
    onboarded_at?: string | null;
    /** True when the user has never onboarded OR when the server-side
     *  ``CURRENT_ONBOARDING_VERSION`` was bumped since they last
     *  completed the wizard (forced re-onboarding). The gate prefers
     *  this over ``onboarded_at`` when present. */
    needs_onboarding?: boolean;
    /** IANA timezone used to render reminder/event times. Defaults to
     *  ``"UTC"``; captured from the browser on first signed-in load. */
    timezone?: string;
    /** Phase G — per-feature × per-channel gates. Rows always land in-app;
     *  these six flags control email and push delivery only. */
    email_event_reminders_enabled?: boolean;
    email_social_activity_enabled?: boolean;
    email_interest_matches_enabled?: boolean;
    push_event_reminders_enabled?: boolean;
    push_social_activity_enabled?: boolean;
    push_interest_matches_enabled?: boolean;
    /** Legacy four-flag aliases returned for one release so older
     *  clients keep working. Derived from the six new flags on the
     *  server (see PHASE_G_NOTIFICATION_GATING.md §G.9). */
    reminder_email_enabled?: boolean;
    activity_email_enabled?: boolean;
    push_enabled?: boolean;
    interest_notifications_enabled?: boolean;
    /** Admin override: when true, InstallPrompt bypasses its 14-day dismiss
     *  snooze for this user. Set via Admin → Users. */
    force_install_prompt?: boolean;
    /** ISO-8601 timestamp of the first time this account was observed
     *  running as an installed PWA, or null if never installed. Set via
     *  POST /auth/me/installed. */
    installed_at?: string | null;
    /** Admin override: when true, the post-install "enable notifications"
     *  banner bypasses its 24h dismiss snooze for this user. Set via
     *  Admin → Users. */
    force_enable_push_prompt?: boolean;
}

export async function loginWithGoogle(
    credential: string,
    deviceId?: string,
    mockEmail?: string,
    mockName?: string,
    anonPreferences?: { preferred_area: PreferredAreaPayload | null; preferred_tag_ids: number[]; home_location?: HomeLocationPayload | null } | null,
): Promise<AuthUser> {
    const body: Record<string, unknown> = { credential, device_id: deviceId };
    if (mockEmail) body.mock_email = mockEmail;
    if (mockName) body.mock_name = mockName;
    if (anonPreferences) body.anon_preferences = anonPreferences;
    const res = await fetch(`${BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Login failed');
    return res.json();
}

export interface DevUser {
    email: string;
    name: string;
}

export async function fetchDevUsers(): Promise<DevUser[]> {
    const res = await fetch(`${BASE}/auth/dev-users`);
    if (!res.ok) return [];
    const data = await res.json() as { users?: DevUser[] };
    return data.users ?? [];
}

export async function fetchMe(): Promise<AuthUser> {
    const res = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
}

export async function logout(): Promise<void> {
    await fetch(`${BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
    });
}

export async function deleteMyAccount(): Promise<void> {
    const res = await fetch(`${BASE}/auth/me`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Account deletion failed');
}

export async function fetchMySavedEventIds(): Promise<string[]> {
    const res = await fetch(`${BASE}/auth/saved-events`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json() as { event_ids: string[] };
    return data.event_ids ?? [];
}

export async function fetchMySavedEvents(): Promise<SavedEventEntry[]> {
    const res = await fetch(`${BASE}/auth/saved-events`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json() as { events?: SavedEventEntry[] };
    return data.events ?? [];
}

export async function fetchMyAttendingEventIds(): Promise<string[]> {
    const res = await fetch(`${BASE}/auth/attending-events`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json() as { event_ids: string[] };
    return data.event_ids ?? [];
}

export async function fetchMyAttendingEvents(): Promise<AttendingEventEntry[]> {
    const res = await fetch(`${BASE}/auth/attending-events`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json() as { events?: AttendingEventEntry[] };
    return data.events ?? [];
}

export interface UpdatePreferencesPayload {
    share_attendance_default?: boolean;
    /** Omit to leave area untouched; pass `null` to clear. */
    preferred_area?: PreferredAreaPayload | null;
    /** Omit to leave tags untouched; pass `[]` to clear. */
    preferred_tag_ids?: number[];
    /** Omit to leave home pin untouched; pass `null` to clear. */
    home_location?: HomeLocationPayload | null;
}

export async function updateUserPreferences(
    prefs: UpdatePreferencesPayload,
): Promise<UserPreferences> {
    const res = await fetch(`${BASE}/auth/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(prefs),
    });
    if (!res.ok) throw new Error('Failed to update preferences');
    return res.json();
}

export interface NotificationPreferences {
    timezone: string;
    /** Phase G — six per-feature × per-channel gates. */
    email_event_reminders_enabled: boolean;
    email_social_activity_enabled: boolean;
    email_interest_matches_enabled: boolean;
    push_event_reminders_enabled: boolean;
    push_social_activity_enabled: boolean;
    push_interest_matches_enabled: boolean;
    /** Legacy mirror kept for one release. */
    reminder_email_enabled: boolean;
    activity_email_enabled: boolean;
    push_enabled: boolean;
    interest_notifications_enabled: boolean;
}

export interface UpdateNotificationPreferencesPayload {
    timezone?: string;
    /** Phase G — six per-feature × per-channel gates. */
    email_event_reminders_enabled?: boolean;
    email_social_activity_enabled?: boolean;
    email_interest_matches_enabled?: boolean;
    push_event_reminders_enabled?: boolean;
    push_social_activity_enabled?: boolean;
    push_interest_matches_enabled?: boolean;
    /** Legacy aliases accepted for one release — server writes through
     *  to the corresponding new flags. */
    reminder_email_enabled?: boolean;
    activity_email_enabled?: boolean;
    push_enabled?: boolean;
    interest_notifications_enabled?: boolean;
}

export async function updateNotificationPreferences(
    prefs: UpdateNotificationPreferencesPayload,
): Promise<NotificationPreferences> {
    const res = await fetch(`${BASE}/auth/notification-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(prefs),
    });
    if (!res.ok) throw new Error('Failed to update notification preferences');
    return res.json();
}

/** Best-effort IP -> city geo prefill for the home-pin picker in
 * onboarding Step 2. Returns null when the backend returned 204
 * (private IP / geolocation failed) so the caller can fall back to
 * browser geolocation or manual city typeahead. */
export async function geolocateFromIP(): Promise<HomeLocationPayload | null> {
    const res = await fetch(`${BASE}/auth/geolocate-ip`, { credentials: 'include' });
    if (res.status === 204 || !res.ok) return null;
    try {
        return (await res.json()) as HomeLocationPayload;
    } catch {
        return null;
    }
}

export interface InterestProfile {
    id: number;
    label: string;
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
    dance_tag_ids: number[];
    reach_tag_ids: number[];
    matches_enabled: boolean;
    /** Legacy alias mirror, removed in cleanup PR. Always equal to
     *  `matches_enabled`. */
    notify_enabled: boolean;
    is_active: boolean;
    created_at: string;
}

export interface InterestProfilePayload {
    label: string;
    min_lat: number;
    min_lng: number;
    max_lat: number;
    max_lng: number;
    dance_tag_ids?: number[];
    reach_tag_ids?: number[];
    matches_enabled?: boolean;
    /** Legacy alias — accepted for one release. */
    notify_enabled?: boolean;
    is_active?: boolean;
}

export interface InterestProfileUpdatePayload {
    label?: string;
    min_lat?: number;
    min_lng?: number;
    max_lat?: number;
    max_lng?: number;
    dance_tag_ids?: number[];
    reach_tag_ids?: number[];
    matches_enabled?: boolean;
    /** Legacy alias — accepted for one release. */
    notify_enabled?: boolean;
    is_active?: boolean;
}

export async function fetchInterestProfiles(): Promise<InterestProfile[]> {
    const res = await fetch(`${BASE}/interest-profiles`, { credentials: 'include' });
    return parseJsonResponse<InterestProfile[]>(res, 'Failed to fetch interest profiles');
}

export async function createInterestProfile(
    payload: InterestProfilePayload,
): Promise<InterestProfile> {
    const res = await fetch(`${BASE}/interest-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
    });
    return parseJsonResponse<InterestProfile>(res, 'Failed to create interest profile');
}

export async function updateInterestProfile(
    id: number,
    payload: InterestProfileUpdatePayload,
): Promise<InterestProfile> {
    const res = await fetch(`${BASE}/interest-profiles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
    });
    return parseJsonResponse<InterestProfile>(res, 'Failed to update interest profile');
}

export async function deleteInterestProfile(id: number): Promise<void> {
    const res = await fetch(`${BASE}/interest-profiles/${id}`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to delete interest profile');
}

/** Fetch the app's VAPID public key, or null when web-push is disabled. */
export async function fetchVapidPublicKey(): Promise<string | null> {
    const res = await fetch(`${BASE}/push/vapid-public-key`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { public_key?: string };
    return data.public_key ?? null;
}

export interface PushSubscriptionPayload {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    user_agent?: string;
}

export async function subscribePush(payload: PushSubscriptionPayload): Promise<void> {
    const res = await fetch(`${BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to subscribe to push');
}

export async function unsubscribePush(endpoint: string): Promise<void> {
    await fetch(`${BASE}/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint }),
    });
}

export async function updateUserProfile(
    profile: { display_name?: string; handle?: string },
): Promise<{ display_name: string | null; handle: string | null }> {
    const res = await fetch(`${BASE}/auth/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profile),
    });
    if (!res.ok) {
        let detail = 'Failed to update profile';
        try {
            const data = await res.json();
            if (typeof data?.detail === 'string') detail = data.detail;
        } catch { /* ignore */ }
        throw new Error(detail);
    }
    return res.json();
}

export interface HandleAvailability {
    handle: string;
    available: boolean;
    reason?: string | null;
}

export async function checkHandleAvailable(handle: string): Promise<HandleAvailability> {
    const res = await fetch(
        `${BASE}/auth/handle-available?handle=${encodeURIComponent(handle)}`,
        { credentials: 'include' },
    );
    if (!res.ok) throw new Error('Handle check failed');
    return res.json();
}

// --- Social / friends graph (Phase A) ---
//
// Asymmetric follow model: a "friend" is a mutual follow, derived server-side.
// All read endpoints honour the per-scope visibility chokepoint (`can_view`)
// and respond 404 for denied access (never 403) to avoid leaking existence.

export type Visibility = 'public' | 'friends' | 'private';
export type ShareAudience = Visibility;
/** Single account-level visibility gate (Instagram-style). Only two
 * values now: ``public`` (anyone) or ``friends`` (mutual followers).
 * The legacy three-scope (visibility_attendance / visibility_saved /
 * visibility_calendar) model has been collapsed; per-event audience
 * (``share_audience`` / ``audience``) remains independent. */
export type AccountVisibility = 'public' | 'friends';

export interface ProfileCalendarItem {
    event: CalendarEvent;
    intent: 'going' | 'saved' | 'both';
    curated?: boolean;
}

export interface ProfileCalendarList {
    items: ProfileCalendarItem[];
    total: number;
    limit: number;
    offset: number;
}

export interface MutualSubscriberPreview {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
}

export interface PublicProfile {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    member_since: string;
    is_verified_organizer: boolean;
    // True when this profile is an admin-curated puppet account
    // (admin-managed lists feature). Drives transparency badge.
    is_admin_managed?: boolean;
    instagram_url: string | null;
    facebook_url: string | null;
    followers_count: number;
    following_count: number;
    subscribers_count: number;
    going_count_30d: number;
    is_self: boolean;
    is_following: boolean;
    follows_you: boolean;
    is_friend: boolean;
    // Phase E (E8): "approved" once active; "pending" when an
    // outstanding follow-request awaits the target's approval.
    follow_status?: 'approved' | 'pending';
    account_visibility: AccountVisibility;
    show_in_suggestions: boolean;
    friend_count: number;
    mutual_friend_count: number;
    // Default audience pre-selected in the GoingButton audience picker
    // for new RSVPs (replacement for the legacy boolean
    // ``share_attendance_default``).
    share_attendance_default_audience: ShareAudience;
    can_view_calendar: boolean;
    is_subscribed: boolean;
    notify_new_events: boolean;
    mutual_subscribers: MutualSubscriberPreview[];
    mutual_subscribers_count: number;
    // Phase E (E10): viewer's friends who follow this verified organizer.
    // 0 for non-organizers, anonymous viewers, and self-views.
    mutual_friends_who_follow?: number;
}

export interface FollowUser {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    is_friend: boolean;
}

export interface FollowList {
    items: FollowUser[];
    total: number;
}

export interface FollowAction {
    handle: string;
    is_following: boolean;
    is_friend: boolean;
    followers_count: number;
    // Phase B: follow now implies subscribe-to-calendar.
    is_subscribed: boolean;
    notify_new_events: boolean;
    // Phase E (E8): "approved" once active, "pending" when the target
    // has friends-visibility and the request awaits their approval.
    follow_status?: 'approved' | 'pending';
}

// Phase E (E8): inbound follow-request inbox item.
export interface FollowRequestItem {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    requested_at: string;
}

export interface FollowRequestList {
    items: FollowRequestItem[];
}

export async function fetchPublicProfile(handle: string): Promise<PublicProfile> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}`,
        { credentials: 'include' },
    );
    if (res.status === 404) throw new Error('User not found');
    return parseJsonResponse<PublicProfile>(res, 'Failed to fetch profile');
}

export async function followUser(handle: string): Promise<FollowAction> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/follow`,
        { method: 'POST', credentials: 'include' },
    );
    return parseJsonResponse<FollowAction>(res, 'Failed to follow user');
}

export async function unfollowUser(handle: string): Promise<FollowAction> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/follow`,
        { method: 'DELETE', credentials: 'include' },
    );
    return parseJsonResponse<FollowAction>(res, 'Failed to unfollow user');
}

// Phase E (E8): friend-request inbox.
export async function fetchFollowRequests(): Promise<FollowRequestList> {
    const res = await fetch(`${BASE}/social/me/follow-requests`, {
        credentials: 'include',
    });
    if (res.status === 401) return { items: [] };
    return parseJsonResponse<FollowRequestList>(
        res,
        'Failed to fetch follow requests',
    );
}

export async function approveFollowRequest(
    handle: string,
): Promise<FollowAction> {
    const res = await fetch(
        `${BASE}/social/me/follow-requests/${encodeURIComponent(handle)}/approve`,
        { method: 'POST', credentials: 'include' },
    );
    return parseJsonResponse<FollowAction>(res, 'Failed to approve request');
}

export async function declineFollowRequest(handle: string): Promise<void> {
    const res = await fetch(
        `${BASE}/social/me/follow-requests/${encodeURIComponent(handle)}/decline`,
        { method: 'POST', credentials: 'include' },
    );
    if (!res.ok && res.status !== 204) {
        throw new Error('Failed to decline request');
    }
}

export async function fetchFollowers(
    handle: string,
    opts?: { limit?: number; offset?: number },
): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/followers${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch followers');
}

export async function fetchFollowing(
    handle: string,
    opts?: { limit?: number; offset?: number },
): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/following${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch following');
}

export async function fetchMyFriends(opts?: { q?: string; limit?: number }): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.q) sp.set('q', opts.q);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/friends${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch friends');
}

// Phase E (E9): friends leaderboard.
export type LeaderboardPeriod = '7d' | '30d' | '90d';

export interface FriendsLeaderboardEntry {
    rank: number;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    going_count: number;
}

export interface FriendsLeaderboardResponse {
    period: LeaderboardPeriod;
    items: FriendsLeaderboardEntry[];
}

export async function fetchFriendsLeaderboard(
    opts?: { period?: LeaderboardPeriod; limit?: number },
): Promise<FriendsLeaderboardResponse> {
    const sp = new URLSearchParams();
    if (opts?.period) sp.set('period', opts.period);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/friends/leaderboard${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FriendsLeaderboardResponse>(
        res, 'Failed to fetch leaderboard',
    );
}

// --- Phase E (E3) — onboarding -----------------------------------------

export interface OnboardingSuggestionsResponse {
    items: UserSearchResult[];
}

export async function fetchOnboardingSuggestions(
    limit = 10,
): Promise<OnboardingSuggestionsResponse> {
    const res = await fetch(
        `${BASE}/social/onboarding/suggestions?limit=${limit}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<OnboardingSuggestionsResponse>(
        res, 'Failed to load onboarding suggestions',
    );
}

export interface CompleteOnboardingResponse {
    onboarded_at: string;
    followed: string[];
}

export async function completeOnboarding(
    handles: string[],
): Promise<CompleteOnboardingResponse> {
    const res = await fetch(`${BASE}/social/onboarding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles }),
        credentials: 'include',
    });
    return parseJsonResponse<CompleteOnboardingResponse>(
        res, 'Failed to complete onboarding',
    );
}

// --- Phase E (E4) — friend-of-friend suggestions -----------------------

export interface FoFSuggestionItem {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    is_admin_managed?: boolean;
    mutual_friend_count: number;
    mutual_friends_preview: string[];
}

export interface FoFSuggestionsResponse {
    items: FoFSuggestionItem[];
    total: number;
}

export async function fetchMySuggestions(
    opts?: { limit?: number; offset?: number },
): Promise<FoFSuggestionsResponse> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/suggestions${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FoFSuggestionsResponse>(
        res, 'Failed to load suggestions',
    );
}

// --- Phase E (E7) — referrals ------------------------------------------

export interface ReferralResponse {
    code: string;
    url: string;
    used_count: number;
}

export async function fetchMyReferral(): Promise<ReferralResponse> {
    const res = await fetch(`${BASE}/social/me/referral`, {
        credentials: 'include',
    });
    return parseJsonResponse<ReferralResponse>(
        res, 'Failed to load referral link',
    );
}

export interface RedeemReferralResponse {
    inviter_handle: string | null;
    mutual_follow_created: boolean;
}

export async function redeemReferral(
    code: string,
    consent: boolean,
): Promise<RedeemReferralResponse> {
    const res = await fetch(`${BASE}/auth/redeem-referral`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, consent }),
        credentials: 'include',
    });
    return parseJsonResponse<RedeemReferralResponse>(
        res, 'Failed to redeem referral',
    );
}

// --- Phase 3 (D2) — share-link doubles as referral --------------------------

export interface ShareSourceResponse {
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
}

/** Resolve a `?ref=share&src=` token to the sharer preview shown by the
 *  share-referral banner. Returns null on 404 (unknown / deleted code).
 *  Anonymous-safe — the share_code is already in the visitor's URL. */
export async function fetchShareSource(
    shareCode: string,
): Promise<ShareSourceResponse | null> {
    const res = await fetch(
        `${BASE}/social/share-source/${encodeURIComponent(shareCode)}`,
        { credentials: 'include' },
    );
    if (res.status === 404) return null;
    return parseJsonResponse<ShareSourceResponse>(
        res, 'Failed to load share source',
    );
}

export interface RedeemShareFollowResponse {
    sharer_handle: string | null;
    follow_created: boolean;
}

/** Trigger the one-way follow on a share-link redemption. Mirrors
 *  `redeemReferral` but on its own backend bucket; does NOT count
 *  toward the E7 invite leaderboard. */
export async function redeemShareFollow(
    shareCode: string,
    consent: boolean,
): Promise<RedeemShareFollowResponse> {
    const res = await fetch(`${BASE}/auth/redeem-share-follow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_code: shareCode, consent }),
        credentials: 'include',
    });
    return parseJsonResponse<RedeemShareFollowResponse>(
        res, 'Failed to redeem share follow',
    );
}

// ---------------------------------------------------------------------------
// Phase E (E5) — friends / FoF "going" wedge for the event modal.
// ---------------------------------------------------------------------------

export interface WedgeAttendee {
    user_id: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    viewer_follow_status?: 'pending' | 'approved';
}

export interface FofGoingAttendee extends WedgeAttendee {
    via_friend_handle: string | null;
    via_friend_display_name: string | null;
}

export interface GoingWedgeResponse {
    event_id: string;
    friends_going: WedgeAttendee[];
    fof_going: FofGoingAttendee[];
    public_going_count: number;
}

/** Fetch the per-event social-proof wedge (friends/FoF/public count).
 *  Anonymous callers get 401 — caller should hide the wedge in that
 *  case and rely on the existing public ``going_count`` instead. */
export async function fetchGoingWedge(
    eventId: string,
): Promise<GoingWedgeResponse | null> {
    const res = await fetch(`${BASE}/events/${eventId}/going-wedge`, {
        credentials: 'include',
    });
    if (res.status === 401) return null;
    return parseJsonResponse<GoingWedgeResponse>(res, 'Failed to load wedge');
}

export async function fetchMyFollowers(
    opts?: { limit?: number; offset?: number },
): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/followers${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch my followers');
}

export async function fetchMyFollowing(
    opts?: { limit?: number; offset?: number },
): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/following${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch my following');
}

export async function fetchMutualFriends(
    handle: string,
    opts?: { limit?: number; offset?: number },
): Promise<FollowList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/mutual-friends${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<FollowList>(res, 'Failed to fetch mutual friends');
}

export async function removeMyFollower(handle: string): Promise<void> {
    const res = await fetch(
        `${BASE}/social/me/followers/${encodeURIComponent(handle)}`,
        { method: 'DELETE', credentials: 'include' },
    );
    if (!res.ok && res.status !== 204) {
        throw new Error('Failed to remove follower');
    }
}

// --- Calendar subscriptions (Phase B) ---

export interface SubscribedUser {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    notify_new_events: boolean;
    can_view_calendar: boolean;
    subscribed_at: string;
}

export interface SubscriptionList {
    items: SubscribedUser[];
    total: number;
}

export interface SubscriptionAction {
    handle: string;
    is_subscribed: boolean;
    notify_new_events: boolean;
}

export async function subscribeToCalendar(
    handle: string,
    notify_new_events = true,
): Promise<SubscriptionAction> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/subscribe`,
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notify_new_events }),
        },
    );
    if (res.status === 404) throw new Error("This calendar isn't available");
    return parseJsonResponse<SubscriptionAction>(res, 'Failed to subscribe');
}

export async function unsubscribeFromCalendar(handle: string): Promise<SubscriptionAction> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/subscribe`,
        { method: 'DELETE', credentials: 'include' },
    );
    return parseJsonResponse<SubscriptionAction>(res, 'Failed to unsubscribe');
}

export async function fetchMySubscriptions(
    opts?: { limit?: number; offset?: number },
): Promise<SubscriptionList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/subscriptions${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<SubscriptionList>(res, 'Failed to fetch subscriptions');
}

export interface SubscriberUser {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    subscribed_at: string;
}

export interface SubscriberList {
    items: SubscriberUser[];
    total: number;
}

export async function fetchMySubscribers(
    opts?: { limit?: number; offset?: number },
): Promise<SubscriberList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/subscribers${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<SubscriberList>(res, 'Failed to fetch subscribers');
}

export async function removeMySubscriber(handle: string): Promise<void> {
    const res = await fetch(
        `${BASE}/social/me/subscribers/${encodeURIComponent(handle)}`,
        { method: 'DELETE', credentials: 'include' },
    );
    if (!res.ok && res.status !== 204) {
        throw new Error('Failed to remove subscriber');
    }
}

// --- Phase C: in-app notifications ---

export type NotificationKind =
    | 'subscription_going'
    | 'subscription_suggested'
    | 'new_follower'
    | 'new_friend'
    | 'follow_request'
    | 'follow_request_approved'
    | 'promo_code_approved'
    | 'promo_code_rejected'
    | 'organizer_claim_decided'
    | 'event_reminder'
    | 'interest_event';

export interface NotificationActor {
    handle: string;
    display_name: string;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    // Phase E (E1): True iff the current viewer already follows this actor.
    // Used to decide whether to show a "Follow back" CTA on new_follower rows.
    is_following?: boolean;
}

export interface NotificationItem {
    id: number;
    kind: NotificationKind;
    event_id: string | null;
    event_title: string | null;
    event_start: string | null;
    actor: NotificationActor;
    /** Extra rendering context, e.g. the matched interest profile label(s)
     *  for `interest_event` rows (comma-joined when multiple profiles
     *  matched). Null for kinds that don't use it. */
    context: string | null;
    created_at: string;
    read_at: string | null;
}

export interface NotificationListResponse {
    items: NotificationItem[];
    total: number;
    unread_count: number;
    limit: number;
    offset: number;
}

const ISO_TIMESTAMP_WITHOUT_TZ_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function normalizeNotificationTimestamp(value: string | null): string | null {
    if (!value) return value;
    return ISO_TIMESTAMP_WITHOUT_TZ_RE.test(value) ? `${value}Z` : value;
}

function normalizeNotificationItem(item: NotificationItem): NotificationItem {
    return {
        ...item,
        created_at: normalizeNotificationTimestamp(item.created_at) ?? item.created_at,
        read_at: normalizeNotificationTimestamp(item.read_at),
        event_start: normalizeNotificationTimestamp(item.event_start),
    };
}

export async function fetchNotifications(
    opts?: { kind?: NotificationKind; unreadOnly?: boolean; limit?: number; offset?: number },
): Promise<NotificationListResponse> {
    const sp = new URLSearchParams();
    if (opts?.kind) sp.set('kind', opts.kind);
    if (opts?.unreadOnly) sp.set('unread_only', 'true');
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/notifications${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    const data = await parseJsonResponse<NotificationListResponse>(res, 'Failed to fetch notifications');
    return {
        ...data,
        items: data.items.map(normalizeNotificationItem),
    };
}

export async function fetchNotificationsUnreadCount(): Promise<{ count: number }> {
    const res = await fetch(`${BASE}/notifications/unread-count`, {
        credentials: 'include',
    });
    return parseJsonResponse<{ count: number }>(res, 'Failed to fetch unread count');
}

export async function markNotificationRead(id: number): Promise<NotificationItem> {
    const res = await fetch(`${BASE}/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'include',
    });
    const data = await parseJsonResponse<NotificationItem>(res, 'Failed to mark notification read');
    return normalizeNotificationItem(data);
}

export async function markAllNotificationsRead(): Promise<{ count: number }> {
    const res = await fetch(`${BASE}/notifications/read-all`, {
        method: 'POST',
        credentials: 'include',
    });
    return parseJsonResponse<{ count: number }>(res, 'Failed to mark all read');
}

export interface SubscribedEventVia {
    actor: NotificationActor;
    kind: NotificationKind;
}

export interface SubscribedEventItem extends CalendarEvent {
    via: SubscribedEventVia[];
}

export interface SubscribedEventListResponse {
    items: SubscribedEventItem[];
    total: number;
    limit: number;
    offset: number;
}

export async function fetchSubscribedEvents(
    opts?: { fromHandle?: string; fromHandles?: string[]; kind?: 'all' | 'going' | 'saved'; limit?: number; offset?: number },
): Promise<SubscribedEventListResponse> {
    const sp = new URLSearchParams();
    if (opts?.fromHandle) sp.set('from_handle', opts.fromHandle);
    if (opts?.fromHandles?.length) sp.set('from_handles', opts.fromHandles.join(','));
    if (opts?.kind && opts.kind !== 'all') sp.set('kind', opts.kind);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/me/subscribed-events${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<SubscribedEventListResponse>(res, 'Failed to fetch subscribed events');
}

// --- Admin: users management ---

export interface AdminUserRow {
    user_id: string;
    email: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    is_admin: boolean;
    is_verified_organizer: boolean;
    is_admin_managed: boolean;
    managed_label: string | null;
    force_install_prompt: boolean;
    installed_at: string | null;
    force_enable_push_prompt: boolean;
    deleted_at: string | null;
    created_at: string;
    // Most recent visit timestamp + the raw ``User-Agent`` header captured
    // at that visit (bumped on login and on any subsequent session-cookie
    // request). Null until the user's next visit on a build that captures
    // it. Powers the "Last visit" column in AdminUsersTab.
    last_visit_at: string | null;
    last_visit_user_agent: string | null;
    followers_count: number;
    following_count: number;
    active_block_id: number | null;
    blocked_at: string | null;
    // Per-feature notification channel status, read directly off the
    // User row. Powers the read-only status columns in the admin Users
    // table and the force-send/send-now target user pickers.
    email_interest_matches_enabled: boolean;
    push_interest_matches_enabled: boolean;
    email_event_reminders_enabled: boolean;
    push_event_reminders_enabled: boolean;
    email_social_activity_enabled: boolean;
    push_social_activity_enabled: boolean;
    has_push_subscription: boolean;
}

export interface AdminUserList {
    items: AdminUserRow[];
    total: number;
}

export interface AdminUserMergeResponse {
    status: string;
    source_user_id: string;
    destination_user_id: string;
    summary: Record<string, number>;
}

export interface AdminBlockedUserRow {
    id: number;
    provider: string;
    provider_subject: string;
    email: string | null;
    reason: string | null;
    created_at: string;
    created_by_admin_user_id: string | null;
    revoked_at: string | null;
    revoked_by_admin_user_id: string | null;
}

export interface AdminBlockedUserList {
    items: AdminBlockedUserRow[];
    total: number;
}

export async function fetchAdminUsers(
    opts?: { q?: string; includeDeleted?: boolean; verifiedOnly?: boolean; managedOnly?: boolean; limit?: number; offset?: number },
): Promise<AdminUserList> {
    const sp = new URLSearchParams();
    if (opts?.q) sp.set('q', opts.q);
    if (opts?.includeDeleted) sp.set('include_deleted', 'true');
    if (opts?.verifiedOnly) sp.set('verified_only', 'true');
    if (opts?.managedOnly) sp.set('managed_only', 'true');
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/admin/users${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<AdminUserList>(res, 'Failed to fetch users');
}

export async function adminDeleteUser(userId: string): Promise<{ status: string; user_id: string }> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}`,
        { method: 'DELETE', credentials: 'include' },
    );
    return parseJsonResponse<{ status: string; user_id: string }>(res, 'Failed to delete user');
}

export async function adminBlockUser(
    userId: string,
    reason?: string | null,
): Promise<AdminBlockedUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}/block`,
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason ?? null }),
        },
    );
    return parseJsonResponse<AdminBlockedUserRow>(res, 'Failed to block user');
}

export async function adminFetchBlockedUsers(
    opts?: { includeRevoked?: boolean; limit?: number; offset?: number },
): Promise<AdminBlockedUserList> {
    const sp = new URLSearchParams();
    if (opts?.includeRevoked) sp.set('include_revoked', 'true');
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/admin/user-blocks${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<AdminBlockedUserList>(res, 'Failed to fetch blocked users');
}

export async function adminRevokeUserBlock(blockId: number): Promise<AdminBlockedUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/user-blocks/${encodeURIComponent(String(blockId))}`,
        { method: 'DELETE', credentials: 'include' },
    );
    return parseJsonResponse<AdminBlockedUserRow>(res, 'Failed to unblock user');
}

export async function adminSetVerifiedOrganizer(
    userId: string,
    isVerified: boolean,
): Promise<AdminUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}/verified`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_verified_organizer: isVerified }),
        },
    );
    return parseJsonResponse<AdminUserRow>(res, 'Failed to update verified flag');
}

export async function adminSetForceInstallPrompt(
    userId: string,
    value: boolean,
): Promise<AdminUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}/force-install-prompt`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force_install_prompt: value }),
        },
    );
    return parseJsonResponse<AdminUserRow>(res, 'Failed to update force-install-prompt flag');
}

export async function reportAppInstalled(): Promise<{ installed_at: string }> {
    const res = await fetch(`${BASE}/auth/me/installed`, {
        method: 'POST',
        credentials: 'include',
    });
    return parseJsonResponse<{ installed_at: string }>(res, 'Failed to record app install');
}

export async function adminSetForceEnablePush(
    userId: string,
    value: boolean,
): Promise<AdminUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}/force-enable-push`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force_enable_push_prompt: value }),
        },
    );
    return parseJsonResponse<AdminUserRow>(res, 'Failed to update force-enable-push flag');
}

export async function adminSetAdminManaged(
    userId: string,
    isAdminManaged: boolean,
    managedLabel?: string | null,
): Promise<AdminUserRow> {
    const res = await fetch(
        `${BASE}/social/admin/users/id/${encodeURIComponent(userId)}/managed`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                is_admin_managed: isAdminManaged,
                managed_label: managedLabel ?? null,
            }),
        },
    );
    return parseJsonResponse<AdminUserRow>(res, 'Failed to update managed flag');
}

export async function adminMergeUsers(
    sourceUserId: string,
    destinationUserId: string,
    reason?: string | null,
): Promise<AdminUserMergeResponse> {
    const res = await fetch(`${BASE}/social/admin/users/merge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            source_user_id: sourceUserId,
            destination_user_id: destinationUserId,
            reason: reason ?? null,
        }),
    });
    return parseJsonResponse<AdminUserMergeResponse>(res, 'Failed to merge users');
}

export async function updateMyVisibility(
    visibility: Partial<{
        account_visibility: AccountVisibility;
        share_attendance_default_audience: ShareAudience;
        show_in_suggestions: boolean;
    }>,
): Promise<PublicProfile> {
    const res = await fetch(`${BASE}/social/me/visibility`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(visibility),
    });
    return parseJsonResponse<PublicProfile>(res, 'Failed to update visibility');
}

export async function updateMySocialLinks(
    links: Partial<{ instagram_url: string; facebook_url: string }>,
): Promise<PublicProfile> {
    const res = await fetch(`${BASE}/social/me/social-links`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(links),
    });
    return parseJsonResponse<PublicProfile>(res, 'Failed to update social links');
}

// --- Phase D: profile bio + content tabs + discovery ---

export async function updateMyBio(bio: string | null): Promise<PublicProfile> {
    const res = await fetch(`${BASE}/social/me/bio`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio }),
    });
    return parseJsonResponse<PublicProfile>(res, 'Failed to update bio');
}

export interface ProfileEventListResponse {
    items: CalendarEvent[];
    total: number;
    limit: number;
    offset: number;
    curated_event_ids?: string[];
}

async function fetchProfileEventList(
    handle: string,
    tab: 'going' | 'saved' | 'suggested',
    opts?: { limit?: number; offset?: number; includePast?: boolean },
): Promise<ProfileEventListResponse> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    if (tab === 'going' && opts?.includePast) sp.set('include_past', '1');
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/${tab}${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    if (res.status === 404) throw new Error('Not found');
    return parseJsonResponse<ProfileEventListResponse>(
        res,
        `Failed to fetch ${tab} list`,
    );
}

export function fetchUserGoing(
    handle: string,
    opts?: { limit?: number; offset?: number; includePast?: boolean },
) {
    return fetchProfileEventList(handle, 'going', opts);
}

export function fetchUserSaved(
    handle: string,
    opts?: { limit?: number; offset?: number },
) {
    return fetchProfileEventList(handle, 'saved', opts);
}

export function fetchUserSuggested(
    handle: string,
    opts?: { limit?: number; offset?: number },
) {
    return fetchProfileEventList(handle, 'suggested', opts);
}

// Phase D: merged Calendar tab — returns the union of going + saved
// (deduplicated, with intent metadata so the UI can render a chip
// such as "Going" or "Saved" or "Going + Saved" per row).
export async function fetchUserCalendar(
    handle: string,
    opts?: { limit?: number; offset?: number; includePast?: boolean },
): Promise<ProfileCalendarList> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.offset) sp.set('offset', String(opts.offset));
    if (opts?.includePast) sp.set('include_past', '1');
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/calendar${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    if (res.status === 404) throw new Error('Calendar not visible');
    return parseJsonResponse<ProfileCalendarList>(res, 'Failed to fetch calendar');
}

// Phase B: toggle the bell on a Following relationship without
// unfollowing the user.
export async function setFollowNotify(
    handle: string,
    notify: boolean,
): Promise<FollowAction> {
    const res = await fetch(
        `${BASE}/social/users/${encodeURIComponent(handle)}/follow/notify`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notify_new_events: notify }),
        },
    );
    return parseJsonResponse<FollowAction>(res, 'Failed to update notifications');
}

export interface UserSearchResult {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    is_verified_organizer: boolean;
    is_admin_managed?: boolean;
    subscribers_count: number;
    is_subscribed: boolean;
    is_friend?: boolean;
    is_followed_by_viewer?: boolean;
    source?: 'network' | 'curator';
}

export interface UserSearchResponse {
    items: UserSearchResult[];
}

export async function searchUsers(
    q: string,
    opts?: { limit?: number },
): Promise<UserSearchResponse> {
    const sp = new URLSearchParams({ q });
    if (opts?.limit) sp.set('limit', String(opts.limit));
    const res = await fetch(`${BASE}/social/search/users?${sp.toString()}`, {
        credentials: 'include',
    });
    return parseJsonResponse<UserSearchResponse>(res, 'Failed to search users');
}

export async function fetchCurators(
    opts?: {
        q?: string;
        limit?: number;
        excludeSubscribed?: boolean;
        excludeFollowed?: boolean;
    },
): Promise<UserSearchResponse> {
    const sp = new URLSearchParams();
    if (opts?.q) sp.set('q', opts.q);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    if (opts?.excludeSubscribed) sp.set('exclude_subscribed', 'true');
    if (opts?.excludeFollowed) sp.set('exclude_followed', 'true');
    const qs = sp.toString();
    const res = await fetch(`${BASE}/social/curators${qs ? `?${qs}` : ''}`, {
        credentials: 'include',
    });
    return parseJsonResponse<UserSearchResponse>(res, 'Failed to fetch curators');
}

export async function fetchSuggestedUsers(
    opts?: { limit?: number },
): Promise<UserSearchResponse> {
    const sp = new URLSearchParams();
    if (opts?.limit) sp.set('limit', String(opts.limit));
    const qs = sp.toString();
    const res = await fetch(
        `${BASE}/social/discover/suggested${qs ? `?${qs}` : ''}`,
        { credentials: 'include' },
    );
    return parseJsonResponse<UserSearchResponse>(
        res,
        'Failed to fetch suggested users',
    );
}

// --- Who's Going (attendee visibility) ---

export async function fetchAttendanceSummary(eventId: string): Promise<AttendanceSummary> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/attendance-summary`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch attendance summary');
    return res.json();
}

export async function fetchAttendanceSummaryBatch(eventIds: string[]): Promise<AttendanceSummary[]> {
    if (eventIds.length === 0) return [];
    const res = await fetch(`${BASE}/events/attendance-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ event_ids: eventIds }),
    });
    if (!res.ok) return [];
    return res.json();
}

// --- Interest filter picker (Phase: interest-filter-following) ---

export interface InterestSummaryItem {
    handle: string;
    upcoming_going_visible: number;
    upcoming_saved_visible: number;
}

/**
 * Batched per-handle upcoming counts used by the explorer's interest
 * picker. Mirrors `GET /api/social/users/interest-summary?handles=…`
 * (the param is repeated per handle). Returns `[]` on non-OK so the
 * picker degrades to row-only rendering.
 */
export async function fetchInterestSummary(handles: string[]): Promise<InterestSummaryItem[]> {
    const clean = handles
        .map((h) => (h || '').trim().replace(/^@/, '').toLowerCase())
        .filter((h) => h.length > 0);
    if (clean.length === 0) return [];
    const sp = new URLSearchParams();
    for (const h of clean) sp.append('handles', h);
    const res = await fetch(`${BASE}/social/users/interest-summary?${sp.toString()}`, {
        credentials: 'include',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
}

export async function fetchEventAttendees(eventId: string): Promise<Attendee[] | { unauthorized: true }> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/attendees`, {
        credentials: 'include',
    });
    if (res.status === 401) return { unauthorized: true };
    if (!res.ok) throw new Error('Failed to fetch attendees');
    return res.json();
}

// --- Sync Logs ---

export interface SyncLogEntry {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: string;
    trigger: string;
    calendars_synced: number;
    events_upserted: number;
    events_deleted: number;
    error_message: string | null;
    enrichment_status: string;
    enrichment_progress: Record<string, { processed: number; skipped: number; failed: number }> | null;
    dedup_log: Array<{ title: string; incoming_id: string; canonical_id: string; calendar_id: string }> | null;
}

export async function fetchSyncLogs(limit = 20, offset = 0): Promise<SyncLogEntry[]> {
    const res = await fetch(`${BASE}/admin/sync-logs?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch sync logs');
    return res.json();
}

// --- Sync Jobs ---

export interface SyncJobTotals {
    calendars_synced: number;
    events_fetched: number;
    events_upserted: number;
    events_deduped: number;
    events_deleted: number;
    events_enriched: number;
    events_failed: number;
}

export interface LogEntry {
    timestamp: string;
    level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
    message: string;
}

// Alias used by job-level views; structurally identical to LogEntry today.
export type JobLogEntry = LogEntry;

export type FailureType =
    | 'ungeolocated'
    | 'price_not_found'
    | 'links_not_found'
    | 'enrichment_exception'
    | 'persistence_failed';

export interface FailureEntry {
    timestamp: string;
    event_id: string;
    title: string;
    stage: string;
    type: FailureType;
    message: string;
}

export interface StageStats {
    processed: number;
    skipped: number;
    failed: number;
}

export interface ProcessedEventSummary {
    event_id: string;
    title: string;
    start_dt: string;
    location: string | null;
    action: 'new' | 'updated' | 'unchanged' | 'deduped' | 'failed' | 'processing';
    pipeline_stage: string | null;
    geocode_provider: string | null;
    price: string | null;
    links_count: number | null;
    error: string | null;
}

export interface CalendarStatus {
    calendar_id: string;
    calendar_name: string;
    status: 'queued' | 'running' | 'processing' | 'completed' | 'warning' | 'failed';
    fetched: number;
    upserted: number;
    deduped: number;
    enriched_ok: number;
    enriched_failed: number;
    error_count: number;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    current_operation: string | null;
    pipeline_stage: string | null;
    stage_stats: Record<string, StageStats>;
    logs: LogEntry[];
    processed_events: ProcessedEventSummary[];
    failures: FailureEntry[];
}

export interface SyncJobRecord {
    job_id: string;
    status: 'idle' | 'running' | 'abort_requested' | 'aborted' | 'completed' | 'warning' | 'failed';
    started_at: string;
    finished_at: string | null;
    heartbeat_at: string;
    mode: 'incremental' | 'reseed';
    since_date: string | null;
    abort_requested: boolean;
    warning_message: string | null;
    error_message: string | null;
    totals: SyncJobTotals;
    stage_totals: Record<string, { processed: number; skipped: number; failed: number }>;
    metadata: Record<string, unknown>;
    calendar_statuses: Record<string, CalendarStatus>;
    is_stale?: boolean;
}

export async function startSyncJob(
    mode: 'incremental' | 'reseed',
    since_date?: string | null,
): Promise<SyncJobRecord> {
    const res = await fetch(`${BASE}/admin/sync-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, since_date: since_date ?? null, calendar_ids: [] }),
        credentials: 'include',
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { detail?: string }).detail || 'Failed to start sync job');
    }
    return res.json();
}

export async function getSyncJob(jobId: string): Promise<SyncJobRecord> {
    const res = await fetch(`${BASE}/admin/sync-jobs/${jobId}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to get sync job');
    return res.json();
}

export async function retryCalendarInJob(
    jobId: string,
    calendarId: string,
): Promise<SyncJobRecord> {
    const res = await fetch(
        `${BASE}/admin/sync-jobs/${encodeURIComponent(jobId)}/retry-calendar?calendar_id=${encodeURIComponent(calendarId)}`,
        {
            method: 'POST',
            credentials: 'include',
        },
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { detail?: string }).detail || 'Failed to retry calendar sync');
    }
    return res.json();
}

export async function getCurrentSyncJob(): Promise<SyncJobRecord> {
    const res = await fetch(`${BASE}/admin/sync-jobs/current`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to get current sync job');
    return res.json();
}

export async function abortSyncJob(jobId: string): Promise<SyncJobRecord> {
    const res = await fetch(`${BASE}/admin/sync-jobs/${jobId}/abort`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to abort sync job');
    return res.json();
}

export async function fetchSyncJobs(
    limit = 20,
    offset = 0,
): Promise<{ items: SyncJobRecord[]; total: number }> {
    const res = await fetch(
        `${BASE}/admin/sync-jobs?limit=${limit}&offset=${offset}`,
        { credentials: 'include' },
    );
    if (!res.ok) throw new Error('Failed to fetch sync jobs');
    return res.json();
}

// --- Admin Events ---

export interface PaginatedEventsResponse {
    items: CalendarEvent[];
    total: number;
}

export interface EventFilterParams {
    limit?: number;
    offset?: number;
    search?: string;
    review_status?: string;
    calendar_id?: string;
    tag_ids?: string;
    ungeolocated?: boolean;
    future_only?: boolean;
    /**
     * When true, include events that have already finished. The backend now
     * defaults to upcoming-only (CachedEvent.end > now); set this to true to
     * widen the scope (audits, archives, etc.).
     */
    include_past?: boolean;
    /** Filter by visibility state: 'hidden' (is_hidden and not blocked) or 'blocked'. */
    visibility?: 'hidden' | 'blocked';
}

export interface FilterOption {
    value: string;
    label: string;
    count: number;
}

export interface EventFilterOptionsResponse {
    calendars: FilterOption[];
    review_statuses: FilterOption[];
    geo_statuses: FilterOption[];
    tags: FilterOption[];
    total_count: number;
}

export async function fetchAdminEvents(params: EventFilterParams = {}): Promise<PaginatedEventsResponse> {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    if (params.search) qs.set('search', params.search);
    if (params.review_status) qs.set('review_status', params.review_status);
    if (params.calendar_id) qs.set('calendar_id', params.calendar_id);
    if (params.tag_ids) qs.set('tag_ids', params.tag_ids);
    if (params.ungeolocated) qs.set('ungeolocated', 'true');
    if (params.future_only) qs.set('future_only', 'true');
    if (params.include_past) qs.set('include_past', 'true');
    if (params.visibility) qs.set('visibility', params.visibility);
    const res = await fetch(`${BASE}/admin/events?${qs}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch events');
    return res.json();
}

export async function fetchEventFilterOptions(params: EventFilterParams = {}): Promise<EventFilterOptionsResponse> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.review_status) qs.set('review_status', params.review_status);
    if (params.calendar_id) qs.set('calendar_id', params.calendar_id);
    if (params.tag_ids) qs.set('tag_ids', params.tag_ids);
    if (params.ungeolocated) qs.set('ungeolocated', 'true');
    if (params.future_only) qs.set('future_only', 'true');
    if (params.include_past) qs.set('include_past', 'true');
    if (params.visibility) qs.set('visibility', params.visibility);
    const res = await fetch(`${BASE}/admin/events/filter-options?${qs}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch filter options');
    return res.json();
}

export async function bulkReviewEvents(eventIds: string[]): Promise<{ marked_reviewed: number }> {
    const res = await fetch(`${BASE}/admin/events/bulk-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to bulk review events');
    return res.json();
}

export async function bulkRetryGeocoding(eventIds: string[]): Promise<{ geocoded: number; failed: number; total: number }> {
    const res = await fetch(`${BASE}/admin/events/bulk-retry-geocoding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to bulk retry geocoding');
    return res.json();
}

export async function bulkAssignTags(eventIds: string[], tagIds: number[]): Promise<{ assigned: number }> {
    const res = await fetch(`${BASE}/admin/events/bulk-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds, tag_ids: tagIds }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to bulk assign tags');
    return res.json();
}

// --- Admin bulk engagement curation -----------------------------------------

export type AdminBulkEngagementKind = 'save' | 'going';
export type AdminBulkEngagementAction = 'add' | 'remove';
export type AdminBulkEngagementAudience = 'public' | 'friends' | 'private';

export interface AdminBulkEngagementItem {
    handle: string;
    event_id: string;
    status:
    | 'changed'
    | 'noop'
    | 'skipped_not_managed'
    | 'skipped_no_user'
    | 'skipped_no_event';
    detail: string | null;
}

export interface AdminBulkEngagementResponse {
    items: AdminBulkEngagementItem[];
    changed_count: number;
    skipped_count: number;
}

/**
 * Bulk-curate Saved/Going entries on admin-managed accounts.
 * Backend skips non-managed targets per-row (never errors).
 */
export async function adminBulkEngagement(
    handles: string[],
    eventIds: string[],
    kind: AdminBulkEngagementKind,
    action: AdminBulkEngagementAction,
    opts?: { audience?: AdminBulkEngagementAudience; fanOut?: boolean },
): Promise<AdminBulkEngagementResponse> {
    const res = await fetch(`${BASE}/admin/engagement/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            handles,
            event_ids: eventIds,
            kind,
            action,
            audience: opts?.audience ?? null,
            fan_out: opts?.fanOut ?? false,
        }),
    });
    return parseJsonResponse<AdminBulkEngagementResponse>(res, 'Failed to apply bulk curation');
}


// --- Phase 3: per-calendar curation rules ---

export interface CalendarCurationRule {
    id: number;
    calendar_id: string;
    target_user_id: string;
    target_handle: string | null;
    kind: AdminBulkEngagementKind;
    audience: AdminBulkEngagementAudience | null;
    enabled: boolean;
}

export async function listCalendarCurationRules(calendarId: string): Promise<CalendarCurationRule[]> {
    const res = await fetch(
        `${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/curation-rules`,
        { credentials: 'include' },
    );
    return parseJsonResponse<CalendarCurationRule[]>(res, 'Failed to load curation rules');
}

export async function createCalendarCurationRule(
    calendarId: string,
    body: {
        target_handle: string;
        kind: AdminBulkEngagementKind;
        audience?: AdminBulkEngagementAudience | null;
        enabled?: boolean;
    },
): Promise<CalendarCurationRule> {
    const res = await fetch(
        `${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/curation-rules`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
        },
    );
    return parseJsonResponse<CalendarCurationRule>(res, 'Failed to create curation rule');
}

export async function updateCalendarCurationRule(
    calendarId: string,
    ruleId: number,
    body: { audience?: AdminBulkEngagementAudience | null; enabled?: boolean },
): Promise<CalendarCurationRule> {
    const res = await fetch(
        `${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/curation-rules/${ruleId}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
        },
    );
    return parseJsonResponse<CalendarCurationRule>(res, 'Failed to update curation rule');
}

export async function deleteCalendarCurationRule(calendarId: string, ruleId: number): Promise<void> {
    const res = await fetch(
        `${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/curation-rules/${ruleId}`,
        { method: 'DELETE', credentials: 'include' },
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to delete curation rule');
    }
}


export async function fetchAdminEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${encodeURIComponent(eventId)}`, {
        cache: 'no-store',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch event');
    return res.json();
}

export async function updateEvent(
    eventId: string,
    update: Partial<Omit<CalendarEvent, 'event_id' | 'color'>> & {
        review_status?: string;
        tag_ids?: number[];
    },
): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${eventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update event');
    return res.json();
}

// --- Geocode Search ---

export interface GeocodeSuggestion {
    display_name: string;
    latitude: number;
    longitude: number;
}

export async function searchAddress(query: string): Promise<GeocodeSuggestion[]> {
    const res = await fetch(`${BASE}/admin/geocode?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
    });
    if (!res.ok) return [];
    return res.json();
}

// --- Config / App Info ---

export async function fetchAppInfo(): Promise<AppInfo> {
    const res = await fetch(`${BASE}/config/info`);
    if (!res.ok) throw new Error('Failed to fetch app info');
    return res.json();
}

export async function fetchTestPlan(scenario: string): Promise<TestPlan> {
    const res = await fetch(`${BASE}/config/test-plan?scenario=${encodeURIComponent(scenario)}`);
    if (!res.ok) throw new Error('Failed to fetch test plan');
    return res.json();
}

// --- Review ---

export async function reviewEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${eventId}/review`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to review event');
    return res.json();
}

// --- Suggestions ---

export async function submitSuggestion(data: EventSuggestionCreate): Promise<{ id: string; message: string }> {
    const res = await fetch(`${BASE}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to submit suggestion');
    }
    return res.json();
}

export async function searchSuggestionAddress(query: string): Promise<GeocodeSuggestion[]> {
    const res = await fetch(`${BASE}/suggestions/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return res.json();
}

export async function fetchSuggestions(status?: string): Promise<EventSuggestion[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(`${BASE}/admin/suggestions${qs}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch suggestions');
    return res.json();
}

export async function updateSuggestion(id: string, data: Record<string, unknown>): Promise<EventSuggestion> {
    const res = await fetch(`${BASE}/admin/suggestions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update suggestion');
    return res.json();
}

export async function approveSuggestion(id: string, calendarId: string): Promise<EventSuggestion> {
    const res = await fetch(`${BASE}/admin/suggestions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendar_id: calendarId }),
        credentials: 'include',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to approve suggestion');
    }
    return res.json();
}

export async function rejectSuggestion(id: string, adminNotes?: string): Promise<EventSuggestion> {
    const res = await fetch(`${BASE}/admin/suggestions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: adminNotes }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to reject suggestion');
    return res.json();
}

export async function syncSuggestionToGoogle(id: string): Promise<EventSuggestion> {
    const res = await fetch(`${BASE}/admin/suggestions/${id}/sync-to-google`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to sync to Google');
    }
    return res.json();
}

// --- Event Attendance Tracking ---

export async function trackEventAttendance(
    eventId: string,
    deviceId: string,
    action: 'going' | 'not_going',
    recordAnalytics: boolean = true,
    sharePublicly?: boolean,
    shareAudience?: ShareAudience,
): Promise<void> {
    const body: Record<string, unknown> = {
        event_id: eventId,
        device_id: deviceId,
        action,
        record_analytics: recordAnalytics,
    };
    if (sharePublicly !== undefined) body.share_publicly = sharePublicly;
    if (shareAudience !== undefined) body.share_audience = shareAudience;
    const res = await fetch(`${BASE}/track/event-attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        // Surface failure so the SavedEvents/AttendingEvents contexts can
        // roll back the optimistic UI update instead of silently lying.
        throw new Error(`Attendance write failed (${res.status})`);
    }
}

// --- Event Save Tracking ---

export async function trackEventSave(
    eventId: string,
    deviceId: string,
    action: 'save' | 'unsave',
    recordAnalytics: boolean = true,
    audience?: ShareAudience,
): Promise<void> {
    const body: Record<string, unknown> = {
        event_id: eventId,
        device_id: deviceId,
        action,
        record_analytics: recordAnalytics,
    };
    if (audience !== undefined) body.audience = audience;
    const res = await fetch(`${BASE}/track/event-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        // Surface failure so the SavedEvents context can roll back the
        // optimistic UI update instead of silently lying.
        throw new Error(`Save write failed (${res.status})`);
    }
}

// --- Batch Fetch Events ---

export async function fetchEventsByIds(eventIds: string[]): Promise<CalendarEvent[]> {
    if (eventIds.length === 0) return [];
    const res = await fetch(`${BASE}/events/by-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
    });
    if (!res.ok) throw new Error('Failed to fetch events by IDs');
    return res.json();
}

// --- Export ---

export async function exportIcs(eventIds: string[]): Promise<Blob> {
    const res = await fetch(`${BASE}/events/export/ics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
    });
    if (!res.ok) throw new Error('Failed to export ICS');
    return res.blob();
}

export async function exportXlsx(eventIds: string[]): Promise<Blob> {
    const res = await fetch(`${BASE}/events/export/xlsx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
    });
    if (!res.ok) throw new Error('Failed to export XLSX');
    return res.blob();
}

// --- Sharing ---

export async function createShareToken(deviceId: string): Promise<{ token: string }> {
    const res = await fetch(`${BASE}/share/calendar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
    });
    if (!res.ok) throw new Error('Failed to create share token');
    return res.json();
}

/**
 * Absolute, subscribable iCalendar feed URL for a share token. Calendar
 * clients (Apple/Google) poll this directly, so it must be fully-qualified
 * even when ``BASE`` is the relative ``/api`` used by the Vite dev proxy.
 */
export function getCalendarFeedUrl(
    token: string,
    scope: 'all' | 'saved' | 'going' = 'all',
): string {
    const base = BASE.startsWith('http')
        ? BASE
        : `${window.location.origin}${BASE}`;
    return `${base}/share/calendar/${encodeURIComponent(token)}.ics?scope=${scope}`;
}

export interface SharedCalendarPayload {
    events: CalendarEvent[];
    owner_display_name: string | null;
}

export async function fetchSharedCalendar(token: string): Promise<SharedCalendarPayload> {
    const res = await fetch(`${BASE}/share/calendar/${encodeURIComponent(token)}`);
    if (res.status === 404) throw new Error('not_found');
    if (!res.ok) throw new Error('Failed to fetch shared calendar');
    const data = await res.json();
    return {
        events: data.events ?? [],
        owner_display_name: data.owner_display_name ?? null,
    };
}

// --- Admin: Most Attended ---

export interface MostAttendedEvent {
    event_id: string;
    title: string;
    start: string | null;
    going_count: number;
}

export async function fetchMostAttendedEvents(limit = 20): Promise<MostAttendedEvent[]> {
    const res = await fetch(`${BASE}/admin/most-attended-events?limit=${limit}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch most attended events');
    return res.json();
}

// --- Admin: Most Saved ---

export interface MostSavedEvent {
    event_id: string;
    title: string;
    start: string | null;
    save_count: number;
}

export async function fetchMostSavedEvents(limit = 20): Promise<MostSavedEvent[]> {
    const res = await fetch(`${BASE}/admin/most-saved-events?limit=${limit}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch most saved events');
    return res.json();
}

// --- Admin: Most Viewed ---

export interface MostViewedEvent {
    event_id: string;
    title: string;
    view_count: number;
    unique_viewers: number;
}

export async function fetchMostViewedEvents(limit = 20): Promise<MostViewedEvent[]> {
    const res = await fetch(`${BASE}/admin/most-viewed-events?limit=${limit}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch most viewed events');
    return res.json();
}

// --- Admin: Analytics ---

export interface SourceBreakdown {
    source: string;
    view_count: number;
}

export async function fetchSourceBreakdown(): Promise<SourceBreakdown[]> {
    const res = await fetch(`${BASE}/admin/analytics/source-breakdown`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch source breakdown');
    return res.json();
}

export interface CountryBreakdown {
    country: string;
    view_count: number;
}

export async function fetchTopCountries(limit = 10): Promise<CountryBreakdown[]> {
    const res = await fetch(`${BASE}/admin/analytics/top-countries?limit=${limit}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch top countries');
    return res.json();
}

export interface TopLink {
    event_id: string;
    event_title: string;
    url: string;
    click_count: number;
}

export async function fetchTopLinks(limit = 20): Promise<TopLink[]> {
    const res = await fetch(`${BASE}/admin/analytics/top-links?limit=${limit}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch top links');
    return res.json();
}

export interface ExportStat {
    format: string;
    export_count: number;
    total_events_exported: number;
}

export async function fetchExportStats(): Promise<ExportStat[]> {
    const res = await fetch(`${BASE}/admin/analytics/exports`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch export stats');
    return res.json();
}

// --- Link Click Tracking ---

export async function trackLinkClick(eventId: string, url: string, deviceId?: string): Promise<void> {
    const body: Record<string, string> = { event_id: eventId, url };
    if (deviceId) body.device_id = deviceId;
    await fetch(`${BASE}/track/link-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// --- Export Tracking ---

export async function trackExport(format: string, eventCount: number, deviceId?: string): Promise<void> {
    const body: Record<string, string | number> = { format, event_count: eventCount };
    if (deviceId) body.device_id = deviceId;
    await fetch(`${BASE}/track/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// --- Share Funnel Tracking ---

/** Server-side share funnel ping. ``share_code`` is sent only for click /
 *  conversion (the originator on a `share` is read from the auth session). */
export async function trackShare(args: {
    eventId: string;
    action: 'share' | 'click' | 'conversion';
    shareCode?: string | null;
    deviceId?: string;
}): Promise<void> {
    const body: Record<string, string> = {
        event_id: args.eventId,
        action: args.action,
    };
    if (args.shareCode) body.share_code = args.shareCode;
    if (args.deviceId) body.device_id = args.deviceId;
    await fetch(`${BASE}/track/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
    });
}

// --- GDPR Data Deletion ---

export async function deleteUserData(deviceId: string): Promise<{ deleted: Record<string, number> }> {
    const res = await fetch(`${BASE}/user-data/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete user data');
    return res.json();
}

// --- Tags ---

export async function fetchTagGroups(
    params?: { startDate?: string; endDate?: string; scope?: 'event' | 'review'; onboarding?: boolean },
    opts?: { fresh?: boolean },
): Promise<TagGroup[]> {
    const qs = new URLSearchParams();
    if (params?.startDate) qs.set('start_date', params.startDate);
    if (params?.endDate) qs.set('end_date', params.endDate);
    if (params?.scope) qs.set('scope', params.scope);
    if (params?.onboarding) qs.set('onboarding', 'true');
    const url = qs.toString() ? `${BASE}/tags?${qs}` : `${BASE}/tags`;
    const init: RequestInit = opts?.fresh ? { cache: 'no-store' } : {};
    const res = await fetch(url, init);
    return parseJsonResponse<TagGroup[]>(res, 'Failed to fetch tags');
}

export async function submitTagSuggestion(body: TagSuggestionCreate): Promise<void> {
    const res = await fetch(`${BASE}/tags/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to submit tag suggestion');
}

function buildAdminTagSuggestionParams(
    opts?:
        | { status?: string; source?: 'user' | 'heuristic'; eventId?: string; includePast?: boolean }
        | string,
): URLSearchParams {
    const params = new URLSearchParams();
    if (typeof opts === 'string') {
        if (opts) params.set('status', opts);
        return params;
    }
    if (!opts) return params;
    if (opts.status) params.set('status', opts.status);
    if (opts.source) params.set('source', opts.source);
    if (opts.eventId) params.set('event_id', opts.eventId);
    if (opts.includePast) params.set('include_past', 'true');
    return params;
}

export async function fetchAdminTagSuggestions(
    opts?:
        | { status?: string; source?: 'user' | 'heuristic'; eventId?: string; includePast?: boolean }
        | string,
): Promise<TagSuggestionResponse[]> {
    // Backwards-compat: accept a bare status string from existing callers.
    const params = buildAdminTagSuggestionParams(opts);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${BASE}/admin/tags/suggestions${qs}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch tag suggestions');
    return res.json();
}

export async function fetchAdminTagSuggestionCount(
    opts?: { status?: string; source?: 'user' | 'heuristic'; eventId?: string; includePast?: boolean } | string,
): Promise<number> {
    const params = buildAdminTagSuggestionParams(opts);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${BASE}/admin/tags/suggestions/count${qs}`, {
        credentials: 'include',
    });
    const data = await parseJsonResponse<{ count: number }>(res, 'Failed to fetch tag suggestion count');
    return data.count;
}

export async function approveTagSuggestion(id: number, tagId?: number): Promise<TagSuggestionResponse> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tagId ? { tag_id: tagId } : {}),
        credentials: 'include',
    });
    return parseJsonResponse<TagSuggestionResponse>(res, 'Failed to approve tag suggestion');
}

export async function rejectTagSuggestion(id: number, adminNotes?: string): Promise<TagSuggestionResponse> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminNotes ? { admin_notes: adminNotes } : {}),
        credentials: 'include',
    });
    return parseJsonResponse<TagSuggestionResponse>(res, 'Failed to reject tag suggestion');
}

export async function bulkReviewTagSuggestions(
    ids: number[],
    action: 'approve' | 'reject',
): Promise<{ ok: number; skipped: number }> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/bulk-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to bulk review tag suggestions');
    return res.json();
}

/** Run the heuristic auto tag-suggestion engine for a single event. */
export async function runTagSuggestionsForEvent(
    eventId: string,
    opts: { replaceExistingPending?: boolean } = {},
): Promise<TagSuggestionRunResponse> {
    const res = await fetch(
        `${BASE}/admin/events/${encodeURIComponent(eventId)}/suggest-tags`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replace_existing_pending: !!opts.replaceExistingPending }),
            credentials: 'include',
        },
    );
    if (!res.ok) throw new Error('Failed to generate tag suggestions');
    return res.json();
}

/** Run the heuristic auto tag-suggestion engine for many events at once (max 200). */
export async function runTagSuggestionsBulk(
    eventIds: string[],
    opts: { replaceExistingPending?: boolean } = {},
): Promise<BulkTagSuggestionRunResponse> {
    const res = await fetch(`${BASE}/admin/events/bulk-suggest-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            event_ids: eventIds,
            replace_existing_pending: !!opts.replaceExistingPending,
        }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to bulk-generate tag suggestions');
    return res.json();
}

export async function updateEventTags(eventId: string, tagIds: number[]): Promise<void> {
    const res = await fetch(`${BASE}/admin/events/${encodeURIComponent(eventId)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: tagIds }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update event tags');
}

// --- Admin Tag Group/Tag CRUD ---

export interface AdminTag extends Tag {
    event_count: number;
}

export interface AdminTagGroup extends Omit<TagGroup, 'tags'> {
    tags: AdminTag[];
}

const adminJsonHeaders = { 'Content-Type': 'application/json' };

export async function fetchAdminTagGroups(): Promise<AdminTagGroup[]> {
    const res = await fetch(`${BASE}/admin/tags/groups`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch admin tag groups');
    return res.json();
}

export async function createTagGroup(data: { label: string; color?: string; onboarding_eligible?: boolean }): Promise<TagGroup> {
    const res = await fetch(`${BASE}/admin/tags/groups`, {
        method: 'POST',
        headers: adminJsonHeaders,
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to create tag group');
    return res.json();
}

export async function updateTagGroup(groupId: number, data: { label?: string; color?: string; ordinal?: number; enabled?: boolean; onboarding_eligible?: boolean }): Promise<TagGroup> {
    const res = await fetch(`${BASE}/admin/tags/groups/${groupId}`, {
        method: 'PATCH',
        headers: adminJsonHeaders,
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update tag group');
    return res.json();
}

export async function createTag(data: { group_id: number; label: string; color?: string }): Promise<Tag> {
    const res = await fetch(`${BASE}/admin/tags`, {
        method: 'POST',
        headers: adminJsonHeaders,
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to create tag');
    return res.json();
}

export async function updateTag(tagId: number, data: { label?: string; color?: string; ordinal?: number; enabled?: boolean; is_hero_filter?: boolean; hero_ordinal?: number | null; group_id?: number }): Promise<Tag> {
    const res = await fetch(`${BASE}/admin/tags/${tagId}`, {
        method: 'PATCH',
        headers: adminJsonHeaders,
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) {
        let detail = 'Failed to update tag';
        try {
            const body = await res.json();
            if (body?.detail) detail = body.detail;
        } catch { /* ignore */ }
        throw new Error(detail);
    }
    return res.json();
}

export async function deleteTag(tagId: number): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/${tagId}`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to delete tag');
}

// --- Tag Synonyms (heuristic suggester) ---

export interface TagSynonymResponse {
    id: number;
    tag_id: number;
    term: string;
    created_at: string;
}

export async function fetchTagSynonyms(tagId: number): Promise<TagSynonymResponse[]> {
    const res = await fetch(`${BASE}/admin/tags/${tagId}/synonyms`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch tag synonyms');
    return res.json();
}

export async function createTagSynonym(tagId: number, term: string): Promise<TagSynonymResponse> {
    const res = await fetch(`${BASE}/admin/tags/${tagId}/synonyms`, {
        method: 'POST',
        headers: adminJsonHeaders,
        body: JSON.stringify({ term }),
        credentials: 'include',
    });
    if (!res.ok) {
        if (res.status === 409) throw new Error('Synonym already exists');
        throw new Error('Failed to create synonym');
    }
    return res.json();
}

export async function deleteTagSynonym(synonymId: number): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/synonyms/${synonymId}`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to delete synonym');
}

// --- Single Event Geocoding ---

export async function retryGeocodingSingle(eventId: string): Promise<{ geocoded: number; failed: number }> {
    const res = await fetch(`${BASE}/admin/events/${encodeURIComponent(eventId)}/retry-geocoding`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to retry geocoding');
    return res.json();
}

// --- Admin: Event IDs (for cross-page select-all) ---

export async function fetchAdminEventIds(params: EventFilterParams = {}): Promise<{ ids: string[] }> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.review_status) qs.set('review_status', params.review_status);
    if (params.calendar_id) qs.set('calendar_id', params.calendar_id);
    if (params.tag_ids) qs.set('tag_ids', params.tag_ids);
    if (params.ungeolocated) qs.set('ungeolocated', 'true');
    if (params.future_only) qs.set('future_only', 'true');
    if (params.include_past) qs.set('include_past', 'true');
    if (params.visibility) qs.set('visibility', params.visibility);
    const res = await fetch(`${BASE}/admin/events/ids?${qs}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch event IDs');
    return res.json();
}

// --- Calendar Default Tags ---

export async function fetchCalendarDefaultTags(calendarId: string): Promise<{ calendar_id: string; tag_ids: number[] }> {
    const res = await fetch(`${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/default-tags`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch calendar default tags');
    return res.json();
}

export async function updateCalendarDefaultTags(calendarId: string, tagIds: number[]): Promise<{ calendar_id: string; tag_ids: number[] }> {
    const res = await fetch(`${BASE}/admin/calendars/${encodeURIComponent(calendarId)}/default-tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: tagIds }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to update calendar default tags');
    return res.json();
}

// ── Ratings / Feedback ────────────────────────────────────────────────

export async function submitFeedback(eventId: string, body: FeedbackSubmissionCreate): Promise<FeedbackSubmissionResponse> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
    });
    return parseJsonResponse<FeedbackSubmissionResponse>(res, 'Failed to submit feedback');
}

export async function fetchMyRating(eventId: string): Promise<EventRating | null> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/rating/me`, {
        credentials: 'include',
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('Failed to fetch rating');
    const text = await res.text();
    if (!text || text === 'null') return null;
    return JSON.parse(text) as EventRating;
}

export async function deleteMyRating(eventId: string): Promise<void> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/rating`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete rating');
}

export async function fetchRatingAggregate(eventId: string): Promise<EventRatingAggregate> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/rating`);
    return parseJsonResponse<EventRatingAggregate>(res, 'Failed to fetch rating aggregate');
}

export async function fetchRatingAggregates(eventIds: string[]): Promise<EventRatingAggregate[]> {
    if (!eventIds.length) return [];
    const res = await fetch(`${BASE}/events/ratings/aggregate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_ids: eventIds }),
    });
    return parseJsonResponse<EventRatingAggregate[]>(res, 'Failed to fetch rating aggregates');
}

export async function fetchEventReviews(
    eventId: string,
    opts?: { limit?: number; offset?: number; sort?: 'recent' | 'highest' | 'lowest'; minStars?: number },
): Promise<EventReviewsList> {
    const sp = new URLSearchParams();
    if (opts?.limit != null) sp.set('limit', String(opts.limit));
    if (opts?.offset != null) sp.set('offset', String(opts.offset));
    if (opts?.sort) sp.set('sort', opts.sort);
    if (opts?.minStars != null) sp.set('min_stars', String(opts.minStars));
    const qs = sp.toString();
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}/reviews${qs ? `?${qs}` : ''}`);
    return parseJsonResponse<EventReviewsList>(res, 'Failed to fetch reviews');
}

export async function fetchMyRatings(): Promise<MyRating[]> {
    const res = await fetch(`${BASE}/users/me/ratings`, { credentials: 'include' });
    return parseJsonResponse<MyRating[]>(res, 'Failed to fetch my ratings');
}

export async function fetchReviewTagGroup(): Promise<TagGroup | null> {
    const groups = await fetchTagGroups({ scope: 'review' });
    return groups.find((g) => g.slug === 'review-tags') ?? null;
}

// Admin
export async function fetchAdminRatings(opts?: { status?: 'pending' | 'approved' | 'rejected'; page?: number; pageSize?: number }): Promise<AdminRatingList> {
    const sp = new URLSearchParams();
    if (opts?.status) sp.set('status', opts.status);
    sp.set('page', String(opts?.page ?? 1));
    sp.set('page_size', String(opts?.pageSize ?? 25));
    const res = await fetch(`${BASE}/admin/feedback?${sp.toString()}`, { credentials: 'include' });
    return parseJsonResponse<AdminRatingList>(res, 'Failed to fetch admin ratings');
}

export async function approveRating(ratingId: string, adminNotes?: string): Promise<AdminRating> {
    const res = await fetch(`${BASE}/admin/ratings/${encodeURIComponent(ratingId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: adminNotes ?? null }),
        credentials: 'include',
    });
    return parseJsonResponse<AdminRating>(res, 'Failed to approve rating');
}

export async function rejectRating(ratingId: string, adminNotes?: string): Promise<AdminRating> {
    const res = await fetch(`${BASE}/admin/ratings/${encodeURIComponent(ratingId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: adminNotes ?? null }),
        credentials: 'include',
    });
    return parseJsonResponse<AdminRating>(res, 'Failed to reject rating');
}

export async function blockEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${eventId}/block`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to block event');
    return res.json();
}

export async function unblockEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${eventId}/block`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to unblock event');
    return res.json();
}

// --- Promo codes -----------------------------------------------------------

export async function fetchEventPromoCodes(eventId: string): Promise<PromoCode[]> {
    const res = await fetch(`${BASE}/events/${eventId}/promo-codes`, {
        credentials: 'include',
    });
    if (res.status === 404) return [];
    return parseJsonResponse<PromoCode[]>(res, 'Failed to load promo codes');
}

export async function submitEventPromoCode(
    eventId: string,
    body: PromoCodeCreate,
): Promise<PromoCode> {
    const res = await fetch(`${BASE}/events/${eventId}/promo-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<PromoCode>(res, 'Failed to submit promo code');
}

export async function updateEventPromoCode(
    eventId: string,
    promoId: string,
    body: PromoCodeUpdate,
): Promise<PromoCode> {
    const res = await fetch(`${BASE}/events/${eventId}/promo-codes/${promoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<PromoCode>(res, 'Failed to update promo code');
}

export async function deleteEventPromoCode(
    eventId: string,
    promoId: string,
): Promise<void> {
    const res = await fetch(`${BASE}/events/${eventId}/promo-codes/${promoId}`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to delete promo code');
    }
}

export async function fetchAdminPromoCodes(status?: string): Promise<PromoCodeAdmin[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(`${BASE}/admin/promo-codes${qs}`, {
        credentials: 'include',
    });
    return parseJsonResponse<PromoCodeAdmin[]>(res, 'Failed to fetch promo codes');
}

export async function approveAdminPromoCode(promoId: string): Promise<PromoCodeAdmin> {
    const res = await fetch(`${BASE}/admin/promo-codes/${promoId}/approve`, {
        method: 'POST',
        credentials: 'include',
    });
    return parseJsonResponse<PromoCodeAdmin>(res, 'Failed to approve promo code');
}

export async function rejectAdminPromoCode(
    promoId: string,
    adminNotes?: string,
): Promise<PromoCodeAdmin> {
    const res = await fetch(`${BASE}/admin/promo-codes/${promoId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ admin_notes: adminNotes ?? null }),
    });
    return parseJsonResponse<PromoCodeAdmin>(res, 'Failed to reject promo code');
}

export async function updateAdminPromoCode(
    promoId: string,
    body: PromoCodeUpdate,
): Promise<PromoCodeAdmin> {
    const res = await fetch(`${BASE}/admin/promo-codes/${promoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<PromoCodeAdmin>(res, 'Failed to update promo code');
}

// --- Organizer claims ------------------------------------------------------

export interface EventSearchResult {
    event_id: string;
    title: string;
    start: string | null;
    location: string | null;
}

export async function searchEvents(
    q: string,
    limit = 10,
): Promise<EventSearchResult[]> {
    const qs = `?q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await fetch(`${BASE}/events/search${qs}`, {
        credentials: 'include',
    });
    return parseJsonResponse<EventSearchResult[]>(res, 'Failed to search events');
}

export async function fetchMyOrganizerClaims(
    kind?: 'badge' | 'events',
): Promise<OrganizerClaim[]> {
    const qs = kind ? `?kind=${kind}` : '';
    const res = await fetch(`${BASE}/me/organizer-claims${qs}`, {
        credentials: 'include',
    });
    return parseJsonResponse<OrganizerClaim[]>(res, 'Failed to fetch claims');
}

export async function submitOrganizerClaim(
    body: OrganizerClaimCreate,
): Promise<OrganizerClaim> {
    const res = await fetch(`${BASE}/me/organizer-claims`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<OrganizerClaim>(res, 'Failed to submit claim');
}

export async function cancelOrganizerClaim(claimId: string): Promise<void> {
    const res = await fetch(`${BASE}/me/organizer-claims/${claimId}`, {
        method: 'DELETE',
        credentials: 'include',
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to cancel claim');
    }
}

export async function fetchAdminOrganizerClaims(
    status?: string,
    kind?: 'badge' | 'events',
): Promise<OrganizerClaimAdmin[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (kind) params.set('kind', kind);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${BASE}/admin/organizer-claims${qs}`, {
        credentials: 'include',
    });
    return parseJsonResponse<OrganizerClaimAdmin[]>(res, 'Failed to fetch claims');
}

export async function decideOrganizerClaim(
    claimId: string,
    body: OrganizerClaimDecide,
): Promise<OrganizerClaimAdmin> {
    const res = await fetch(`${BASE}/admin/organizer-claims/${claimId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
    return parseJsonResponse<OrganizerClaimAdmin>(res, 'Failed to decide claim');
}
