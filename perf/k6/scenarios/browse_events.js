// Read-only browse-events journey, one full iteration per VU loop.
// Mirrors a typical user opening the calendar, scrolling a date range,
// inspecting a couple of events, and checking who is attending.
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';

import {
    DEFAULT_HEADERS,
    pickN,
    thinkSeconds,
    url,
} from '../lib/config.js';
import { checkOk, trends } from '../lib/checks.js';

const dateWindows = new SharedArray('date_windows', () =>
    JSON.parse(open('../data/date-windows.json')).windows_days
);

function isoDate(date) {
    return date.toISOString().slice(0, 10);
}

function pickDateRange() {
    const days = dateWindows[Math.floor(Math.random() * dateWindows.length)];
    const today = new Date();
    // Shift the window start by 0..3 days back to vary cache keys.
    const startShift = Math.floor(Math.random() * 4);
    const start = new Date(today);
    start.setDate(start.getDate() - startShift);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    return { start_date: isoDate(start), end_date: isoDate(end) };
}

const params = { headers: DEFAULT_HEADERS };
const jsonParams = {
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
};

export default function browseEvents() {
    // 1. List enabled calendars (cold-cache populating step).
    const calRes = http.get(url('/api/events/calendars'), {
        ...params,
        tags: { route: 'calendars', group: 'reads' },
    });
    checkOk(calRes, 'GET /api/events/calendars', trends.calendars);
    sleep(thinkSeconds());

    // 2. List events within a rolling window.
    const range = pickDateRange();
    const listUrl =
        `/api/events?start_date=${range.start_date}&end_date=${range.end_date}`;
    const listRes = http.get(url(listUrl), {
        ...params,
        tags: { route: 'events_list', group: 'reads' },
    });
    const listOk = checkOk(listRes, 'GET /api/events', trends.list);
    let events = [];
    if (listOk) {
        try {
            events = listRes.json();
            if (!Array.isArray(events)) events = [];
        } catch (_e) {
            events = [];
        }
    }
    sleep(thinkSeconds());

    // 3. Batch-fetch a handful of events (My Calendar / saved-events flow).
    // Only fire ~50% of the time to stay under the 30/min POST rate limit.
    if (events.length > 0 && Math.random() < 0.5) {
        const ids = pickN(
            events.map((e) => e.event_id).filter(Boolean),
            Math.min(5, events.length)
        );
        if (ids.length > 0) {
            const byIdsRes = http.post(
                url('/api/events/by-ids'),
                JSON.stringify({ event_ids: ids }),
                { ...jsonParams, tags: { route: 'events_by_ids', group: 'reads' } }
            );
            checkOk(byIdsRes, 'POST /api/events/by-ids', trends.byIds);
        }
        sleep(thinkSeconds());
    }

    // 4. Drill into a single event + its attendance summary.
    // Cap at 1 to respect the 60/min per-IP limit on /api/events/{id}.
    if (events.length > 0) {
        const ev = events[Math.floor(Math.random() * events.length)];
        if (ev && ev.event_id) {
            const detailRes = http.get(url(`/api/events/${ev.event_id}`), {
                ...params,
                tags: { route: 'event_detail', group: 'reads' },
            });
            checkOk(detailRes, 'GET /api/events/{id}', trends.detail);

            const summaryRes = http.get(
                url(`/api/events/${ev.event_id}/attendance-summary`),
                { ...params, tags: { route: 'attendance_summary', group: 'reads' } }
            );
            checkOk(
                summaryRes,
                'GET /api/events/{id}/attendance-summary',
                trends.attendance
            );
        }
        sleep(thinkSeconds());
    }
}
