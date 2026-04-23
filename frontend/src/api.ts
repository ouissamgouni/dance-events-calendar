import type { CalendarEvent, CalendarSetting, AppInfo, TestPlan, EventSuggestionCreate, EventSuggestion, Tag, TagGroup, TagSuggestionCreate, TagSuggestionResponse } from './types';

const BASE = '/api';

export async function fetchEvents(params?: { startDate?: string; endDate?: string; tagIds?: number[] }): Promise<CalendarEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set('start_date', params.startDate);
    if (params?.endDate) searchParams.set('end_date', params.endDate);
    if (params?.tagIds?.length) searchParams.set('tag_ids', params.tagIds.join(','));
    const qs = searchParams.toString();
    const res = await fetch(`${BASE}/events${qs ? `?${qs}` : ''}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to fetch events');
    return res.json();
}

export async function fetchEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/events/${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('Failed to fetch event');
    return res.json();
}

export interface SiteSettings {
    since_date: string;
    sync_interval_minutes: number;
    show_prices: boolean;
    show_popularity: boolean;
    popularity_threshold: number;
}

export async function fetchSettings(): Promise<SiteSettings> {
    const res = await fetch(`${BASE}/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
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
    const res = await fetch(`${BASE}/admin/calendars/${calendarId}/toggle`, {
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

export async function triggerSync(): Promise<Record<string, number>> {
    const res = await fetch(`${BASE}/admin/sync`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to trigger sync');
    return res.json();
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

export async function loginWithGoogle(
    credential: string,
): Promise<{ email: string; name: string }> {
    const res = await fetch(`${BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Login failed');
    return res.json();
}

export async function fetchMe(): Promise<{ email: string; name: string }> {
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
}

export async function fetchSyncLogs(limit = 20, offset = 0): Promise<SyncLogEntry[]> {
    const res = await fetch(`${BASE}/admin/sync-logs?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch sync logs');
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
    update: Partial<Omit<CalendarEvent, 'event_id' | 'calendar_id' | 'color'>>,
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

// --- Event Save Tracking ---

export async function trackEventSave(
    eventId: string,
    deviceId: string,
    action: 'save' | 'unsave',
): Promise<void> {
    await fetch(`${BASE}/track/event-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, device_id: deviceId, action }),
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
}

export async function fetchMostViewedEvents(limit = 20): Promise<MostViewedEvent[]> {
    const res = await fetch(`${BASE}/admin/most-viewed-events?limit=${limit}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch most viewed events');
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

export async function fetchTagGroups(): Promise<TagGroup[]> {
    const res = await fetch(`${BASE}/tags`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to fetch tags');
    return res.json();
}

export async function submitTagSuggestion(body: TagSuggestionCreate): Promise<void> {
    const res = await fetch(`${BASE}/tags/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to submit tag suggestion');
}

export async function fetchAdminTagSuggestions(status?: string): Promise<TagSuggestionResponse[]> {
    const qs = status ? `?status=${status}` : '';
    const res = await fetch(`${BASE}/admin/tags/suggestions${qs}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}` },
    });
    if (!res.ok) throw new Error('Failed to fetch tag suggestions');
    return res.json();
}

export async function approveTagSuggestion(id: number, tagId?: number): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
        },
        body: JSON.stringify(tagId ? { tag_id: tagId } : {}),
    });
    if (!res.ok) throw new Error('Failed to approve tag suggestion');
}

export async function rejectTagSuggestion(id: number, adminNotes?: string): Promise<void> {
    const res = await fetch(`${BASE}/admin/tags/suggestions/${id}/reject`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
        },
        body: JSON.stringify(adminNotes ? { admin_notes: adminNotes } : {}),
    });
    if (!res.ok) throw new Error('Failed to reject tag suggestion');
}

export async function updateEventTags(eventId: string, tagIds: number[]): Promise<void> {
    const res = await fetch(`${BASE}/admin/events/${encodeURIComponent(eventId)}/tags`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
        },
        body: JSON.stringify({ tag_ids: tagIds }),
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

const adminHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
});

export async function fetchAdminTagGroups(): Promise<AdminTagGroup[]> {
    const res = await fetch(`${BASE}/admin/tags/groups`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}` },
    });
    if (!res.ok) throw new Error('Failed to fetch admin tag groups');
    return res.json();
}

export async function createTagGroup(data: { label: string; color?: string }): Promise<TagGroup> {
    const res = await fetch(`${BASE}/admin/tags/groups`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create tag group');
    return res.json();
}

export async function updateTagGroup(groupId: number, data: { label?: string; color?: string; ordinal?: number; enabled?: boolean }): Promise<TagGroup> {
    const res = await fetch(`${BASE}/admin/tags/groups/${groupId}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update tag group');
    return res.json();
}

export async function createTag(data: { group_id: number; label: string; color?: string }): Promise<Tag> {
    const res = await fetch(`${BASE}/admin/tags`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create tag');
    return res.json();
}

export async function updateTag(tagId: number, data: { label?: string; color?: string; ordinal?: number; enabled?: boolean }): Promise<Tag> {
    const res = await fetch(`${BASE}/admin/tags/${tagId}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update tag');
    return res.json();
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
