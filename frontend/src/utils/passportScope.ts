/**
 * Time-scoping for the shareable Dance Passport card.
 *
 * The passport page already has every attended event (via /api/passport/events)
 * with a start date, city, country and lat/lng, plus the all-time milestone list
 * (each carrying `unlocked_at`). That's enough to recompute a full "All time" or
 * "this year" summary entirely client-side — no extra backend call.
 *
 * Milestones are inherently all-time (thresholds like "50 events"), so a
 * year-scoped card instead surfaces the milestones *unlocked that year* plus a
 * few computed highlights (busiest month, new places, in-year streak).
 */
import type { PassportMapEvent, PassportMilestone } from '../types';

/** `'all'` = lifetime; a number = a specific calendar year. */
export type ShareScope = 'all' | number;

export interface ScopedBadge {
    key: string;
    icon: string;
    label: string;
}

export interface ScopedPassport {
    scope: ShareScope;
    totalEvents: number;
    cities: number;
    countries: number;
    /** Average days between events ("1 event every N days"); null if < 2 events. */
    cadenceDays: number | null;
    topCity: string | null;
    coords: { lat: number; lng: number }[];
    /** Up to 4 badges/highlights for the card's badge row. */
    badges: ScopedBadge[];
}

const MAX_BADGES = 4;
const MS_PER_DAY = 86_400_000;

function eventYear(iso: string): number | null {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

function cityKey(ev: PassportMapEvent): string | null {
    const c = (ev.city || '').trim().toLowerCase();
    return c ? c : null;
}

function countryKey(ev: PassportMapEvent): string | null {
    const c = (ev.country || '').trim().toLowerCase();
    return c ? c : null;
}

function topCityLabel(events: PassportMapEvent[]): string | null {
    const counts = new Map<string, { label: string; n: number }>();
    for (const ev of events) {
        const key = cityKey(ev);
        if (!key) continue;
        const label = (ev.city || '').trim();
        const cur = counts.get(key);
        if (cur) cur.n += 1;
        else counts.set(key, { label, n: 1 });
    }
    let best: { label: string; n: number } | null = null;
    for (const v of counts.values()) {
        if (!best || v.n > best.n) best = v;
    }
    return best ? best.label : null;
}

function cadence(events: PassportMapEvent[]): number | null {
    const times = events
        .map((e) => new Date(e.start).getTime())
        .filter((t) => !Number.isNaN(t))
        .sort((a, b) => a - b);
    if (times.length < 2) return null;
    const span = times[times.length - 1] - times[0];
    return Math.max(1, Math.round(span / (times.length - 1) / MS_PER_DAY));
}

function coordsOf(events: PassportMapEvent[]): { lat: number; lng: number }[] {
    const out: { lat: number; lng: number }[] = [];
    for (const ev of events) {
        if (ev.latitude != null && ev.longitude != null) {
            out.push({ lat: ev.latitude, lng: ev.longitude });
        }
    }
    return out;
}

/** Highest-threshold unlocked milestone per category, most impressive first. */
function topMilestonesPerCategory(milestones: PassportMilestone[]): ScopedBadge[] {
    const best = new Map<string, PassportMilestone>();
    for (const m of milestones) {
        if (!m.unlocked) continue;
        const cur = best.get(m.category);
        if (!cur || m.threshold > cur.threshold) best.set(m.category, m);
    }
    return [...best.values()]
        .sort((a, b) => b.threshold - a.threshold)
        .map((m) => ({ key: m.key, icon: m.icon, label: m.name }));
}

function milestonesUnlockedInYear(
    milestones: PassportMilestone[],
    year: number,
): ScopedBadge[] {
    return milestones
        .filter((m) => m.unlocked && m.unlocked_at != null && eventYear(m.unlocked_at) === year)
        .sort((a, b) => b.threshold - a.threshold)
        .map((m) => ({ key: m.key, icon: m.icon, label: m.name }));
}

/** Month with the most events in `yearEvents`, as an icon+label badge. */
function busiestMonthBadge(year: number, yearEvents: PassportMapEvent[]): ScopedBadge | null {
    if (yearEvents.length === 0) return null;
    const perMonth = new Array<number>(12).fill(0);
    for (const ev of yearEvents) {
        const d = new Date(ev.start);
        if (!Number.isNaN(d.getTime())) perMonth[d.getMonth()] += 1;
    }
    let idx = -1;
    for (let i = 0; i < 12; i += 1) {
        if (perMonth[i] > 0 && (idx === -1 || perMonth[i] > perMonth[idx])) idx = i;
    }
    if (idx === -1) return null;
    const name = new Date(year, idx, 1).toLocaleDateString(undefined, { month: 'long' });
    return { key: 'busiest_month', icon: '📅', label: `Busiest: ${name}` };
}

/** Places whose key first appears in `year` (not visited in any earlier year). */
function newPlacesBadge(
    year: number,
    allEvents: PassportMapEvent[],
    keyOf: (ev: PassportMapEvent) => string | null,
    icon: string,
    noun: string,
): ScopedBadge | null {
    const prior = new Set<string>();
    const current = new Set<string>();
    for (const ev of allEvents) {
        const y = eventYear(ev.start);
        const key = keyOf(ev);
        if (y == null || key == null) continue;
        if (y < year) prior.add(key);
        else if (y === year) current.add(key);
    }
    let count = 0;
    for (const key of current) if (!prior.has(key)) count += 1;
    if (count === 0) return null;
    return {
        key: `new_${noun}`,
        icon,
        label: `+${count} new ${count === 1 ? noun : `${noun.replace(/y$/, 'ie')}s`}`,
    };
}

/** Longest run of consecutive months (within the year) that had an event. */
function inYearStreakBadge(yearEvents: PassportMapEvent[]): ScopedBadge | null {
    const active = new Set<number>();
    for (const ev of yearEvents) {
        const d = new Date(ev.start);
        if (!Number.isNaN(d.getTime())) active.add(d.getMonth());
    }
    let best = 0;
    let run = 0;
    for (let i = 0; i < 12; i += 1) {
        if (active.has(i)) {
            run += 1;
            if (run > best) best = run;
        } else {
            run = 0;
        }
    }
    if (best < 2) return null;
    return { key: 'in_year_streak', icon: '🔥', label: `${best}-month streak` };
}

/**
 * Build the scoped summary the share card renders.
 *
 * @param events  All attended events (from /api/passport/events).
 * @param milestones  The all-time milestone list (with `unlocked_at`).
 * @param scope  `'all'` or a calendar year.
 */
export function scopePassport(
    events: PassportMapEvent[],
    milestones: PassportMilestone[],
    scope: ShareScope,
): ScopedPassport {
    const scoped =
        scope === 'all'
            ? events
            : events.filter((e) => eventYear(e.start) === scope);

    const cityKeys = new Set<string>();
    const countryKeys = new Set<string>();
    for (const ev of scoped) {
        const ck = cityKey(ev);
        if (ck) cityKeys.add(ck);
        const nk = countryKey(ev);
        if (nk) countryKeys.add(nk);
    }

    let badges: ScopedBadge[];
    if (scope === 'all') {
        badges = topMilestonesPerCategory(milestones).slice(0, MAX_BADGES);
    } else {
        const highlights = [
            busiestMonthBadge(scope, scoped),
            newPlacesBadge(scope, events, cityKey, '🗺️', 'city'),
            newPlacesBadge(scope, events, countryKey, '🌍', 'country'),
            inYearStreakBadge(scoped),
        ].filter((b): b is ScopedBadge => b !== null);
        badges = [...milestonesUnlockedInYear(milestones, scope), ...highlights].slice(0, MAX_BADGES);
    }

    return {
        scope,
        totalEvents: scoped.length,
        cities: cityKeys.size,
        countries: countryKeys.size,
        cadenceDays: cadence(scoped),
        topCity: topCityLabel(scoped),
        coords: coordsOf(scoped),
        badges,
    };
}
