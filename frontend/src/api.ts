import type { CalendarEvent, CalendarSetting, AppInfo, TestPlan, EventSuggestionCreate, EventSuggestion } from './types';

const BASE = '/api';

export async function fetchEvents(params?: { startDate?: string; endDate?: string }): Promise<CalendarEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set('start_date', params.startDate);
    if (params?.endDate) searchParams.set('end_date', params.endDate);
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

export async function trackEventView(eventId: string): Promise<void> {
    await fetch(`${BASE}/track/event-view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId }),
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
}

export async function fetchSyncLogs(limit = 20, offset = 0): Promise<SyncLogEntry[]> {
    const res = await fetch(`${BASE}/admin/sync-logs?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch sync logs');
    return res.json();
}

// --- Admin Events ---

export async function fetchAdminEvents(): Promise<CalendarEvent[]> {
    const res = await fetch(`${BASE}/admin/events`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch events');
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

// --- Pending Review ---

export async function fetchPendingEvents(): Promise<CalendarEvent[]> {
    const res = await fetch(`${BASE}/admin/events/pending`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to fetch pending events');
    return res.json();
}

export async function reviewEvent(eventId: string): Promise<CalendarEvent> {
    const res = await fetch(`${BASE}/admin/events/${eventId}/review`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to review event');
    return res.json();
}

export async function markAllReviewed(): Promise<{ marked_reviewed: number }> {
    const res = await fetch(`${BASE}/admin/events/mark-all-reviewed`, {
        method: 'POST',
        credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to mark all reviewed');
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
