// Helpers wrapping k6's check() with consistent tags and a custom error counter.
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

export const errors = new Counter('errors');

// Per-route latency trends (visible in summary, not threshold-gated).
export const trends = {
    calendars: new Trend('events_calendars_duration', true),
    list: new Trend('events_list_duration', true),
    byIds: new Trend('events_by_ids_duration', true),
    detail: new Trend('event_detail_duration', true),
    attendance: new Trend('attendance_summary_duration', true),
    sitemap: new Trend('sitemap_duration', true),
};

// Wrap an http response with a status check + record the per-route trend.
// Returns true when ok, false otherwise (also bumps the errors counter).
export function checkOk(res, name, trend) {
    const ok = check(res, {
        [`${name} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    });
    if (trend) trend.add(res.timings.duration);
    if (!ok) {
        errors.add(1, { route: name, status: String(res.status) });
    }
    return ok;
}

// Variant that accepts 200 *or* 304 (CDN-cached responses).
export function checkOkOr304(res, name, trend) {
    const ok = check(res, {
        [`${name} status 2xx/304`]: (r) =>
            (r.status >= 200 && r.status < 300) || r.status === 304,
    });
    if (trend) trend.add(res.timings.duration);
    if (!ok) {
        errors.add(1, { route: name, status: String(res.status) });
    }
    return ok;
}
