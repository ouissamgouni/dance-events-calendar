import type { CalendarEvent, CalendarSetting, AppInfo, TestPlan, EventSuggestionCreate, EventSuggestion, Tag, TagGroup, TagSuggestionCreate, TagSuggestionResponse, TagSuggestionRunResponse, BulkTagSuggestionRunResponse, FeedbackSubmissionCreate, FeedbackSubmissionResponse, EventRating, EventRatingAggregate, EventReviewsList, MyRating, AdminRating, AdminRatingList, Attendee, AttendanceSummary, AttendingEventEntry } from './types';

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
        if (contentType.includes('application/json') && bodyText) {
            try {
                const errorBody = JSON.parse(bodyText) as { detail?: string; message?: string };
                throw new Error(errorBody.detail || errorBody.message || fallbackMessage);
            } catch {
                throw new Error(`${fallbackMessage} (HTTP ${res.status})`);
            }
        }
        throw new Error(`${fallbackMessage} (HTTP ${res.status})`);
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

export async function fetchEvents(params?: { startDate?: string; endDate?: string; tagIds?: number[] }): Promise<CalendarEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set('start_date', params.startDate);
    if (params?.endDate) searchParams.set('end_date', params.endDate);
    if (params?.tagIds?.length) searchParams.set('tag_ids', params.tagIds.join(','));
    const qs = searchParams.toString();
    const res = await fetch(`${BASE}/events${qs ? `?${qs}` : ''}`, { cache: 'no-cache' });
    return parseJsonResponse<CalendarEvent[]>(res, 'Failed to fetch events');
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
    event_color_bar_color: string;
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
    update: { enabled?: boolean; color?: string; name?: string },
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

export interface AuthUser {
    user_id?: string;
    email: string;
    name: string;
    avatar_url?: string | null;
    is_admin?: boolean;
    share_attendance_default?: boolean;
    /** Only present on the /auth/google response — lets the client emit
     * `signup_completed` vs `login_completed`. Absent on /auth/me. */
    is_new_user?: boolean;
}

export async function loginWithGoogle(
    credential: string,
    deviceId?: string,
    mockEmail?: string,
    mockName?: string,
): Promise<AuthUser> {
    const body: Record<string, unknown> = { credential, device_id: deviceId };
    if (mockEmail) body.mock_email = mockEmail;
    if (mockName) body.mock_name = mockName;
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

export async function updateUserPreferences(prefs: { share_attendance_default?: boolean }): Promise<{ share_attendance_default: boolean }> {
    const res = await fetch(`${BASE}/auth/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(prefs),
    });
    if (!res.ok) throw new Error('Failed to update preferences');
    return res.json();
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
    _jobId: string,
    calendarId: string,
): Promise<SyncJobRecord> {
    const res = await fetch(`${BASE}/admin/sync-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'incremental', since_date: null, calendar_ids: [calendarId] }),
        credentials: 'include',
    });
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
): Promise<void> {
    const body: Record<string, unknown> = {
        event_id: eventId,
        device_id: deviceId,
        action,
        record_analytics: recordAnalytics,
    };
    if (sharePublicly !== undefined) body.share_publicly = sharePublicly;
    await fetch(`${BASE}/track/event-attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
    });
}

// --- Event Save Tracking ---

export async function trackEventSave(
    eventId: string,
    deviceId: string,
    action: 'save' | 'unsave',
    recordAnalytics: boolean = true,
): Promise<void> {
    await fetch(`${BASE}/track/event-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ event_id: eventId, device_id: deviceId, action, record_analytics: recordAnalytics }),
    });
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

// --- GDPR Data Deletion ---

export async function deleteUserData(deviceId: string): Promise<{ deleted: Record<string, number> }> {
    const res = await fetch(`${BASE}/user-data/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete user data');
    return res.json();
}

// --- Tags ---

export async function fetchTagGroups(params?: { startDate?: string; endDate?: string; scope?: 'event' | 'review' }): Promise<TagGroup[]> {
    const qs = new URLSearchParams();
    if (params?.startDate) qs.set('start_date', params.startDate);
    if (params?.endDate) qs.set('end_date', params.endDate);
    if (params?.scope) qs.set('scope', params.scope);
    const url = qs.toString() ? `${BASE}/tags?${qs}` : `${BASE}/tags`;
    const res = await fetch(url, { cache: 'no-cache' });
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

export async function fetchAdminTagSuggestions(
    opts?: { status?: string; source?: 'user' | 'heuristic'; eventId?: string } | string,
): Promise<TagSuggestionResponse[]> {
    // Backwards-compat: accept a bare status string from existing callers.
    const params = new URLSearchParams();
    if (typeof opts === 'string') {
        if (opts) params.set('status', opts);
    } else if (opts) {
        if (opts.status) params.set('status', opts.status);
        if (opts.source) params.set('source', opts.source);
        if (opts.eventId) params.set('event_id', opts.eventId);
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${BASE}/admin/tags/suggestions${qs}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch tag suggestions');
    return res.json();
}

export async function approveTagSuggestion(id: number, tagId?: number): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tagId ? { tag_id: tagId } : {}),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to approve tag suggestion');
}

export async function rejectTagSuggestion(id: number, adminNotes?: string): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminNotes ? { admin_notes: adminNotes } : {}),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to reject tag suggestion');
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

export async function createTagGroup(data: { label: string; color?: string }): Promise<TagGroup> {
    const res = await fetch(`${BASE}/admin/tags/groups`, {
        method: 'POST',
        headers: adminJsonHeaders,
        body: JSON.stringify(data),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to create tag group');
    return res.json();
}

export async function updateTagGroup(groupId: number, data: { label?: string; color?: string; ordinal?: number; enabled?: boolean }): Promise<TagGroup> {
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
