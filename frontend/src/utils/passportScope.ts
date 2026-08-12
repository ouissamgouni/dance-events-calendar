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
import type { PassportConsistency, PassportMapEvent, PassportMilestone, MonthlyActivity } from '../types';

/** `'all'` = lifetime; a number = a specific calendar year. */
export type ShareScope = 'all' | number;

export interface ScopedBadge {
    key: string;
    icon: string;
    label: string;
    /** Optional one-line explainer shown under the label (e.g. "Dance in 5 cities"). */
    description?: string;
    /** Optional extra-small note shown to the right of the label (e.g. "Unlocked"). */
    tag?: string;
}

export interface ScopedPassport {
    scope: ShareScope;
    totalEvents: number;
    cities: number;
    countries: number;
    /** Average days between events ("Danced every N days"); null if < 2 events. */
    cadenceDays: number | null;
    /**
     * Active months in scope: for the all-time card this is the rolling
     * 12-month active-month count (from the recurring consistency engine); for
     * a year card it's the number of distinct calendar months with an event
     * that year.
     */
    activeMonths: number;
    /** Denominator for {@link activeMonths}: 12 all-time, else 12 (calendar). */
    activeMonthsOf: number;
    /** Most-danced style label (all-time, from backend); null when unknown. */
    topStyle: string | null;
    topCity: string | null;
    coords: { lat: number; lng: number }[];
    /** Up to MAX_BADGES badges/highlights for the card's badge row. */
    badges: ScopedBadge[];
    /** Per-month attended-event counts in scope (for the activity heatmap). */
    monthly: MonthlyActivity[];
    /**
     * True when a recurring consistency badge (e.g. "Committed") already
     * occupies a badge slot, so the card hides the redundant active-months
     * stat cell.
     */
    consistencyInBadges: boolean;
}

const MAX_BADGES = 6;
const MS_PER_DAY = 86_400_000;

// Badge display order across milestone families: consistency leads,
// reviews ("Critic") trail. Everything else sits in the middle by prestige.
const CATEGORY_RANK: Record<string, number> = {
    consistency: 0,
    events: 1,
    cities: 2,
    countries: 3,
    reviews: 4,
};

function categoryRank(category: string): number {
    return CATEGORY_RANK[category] ?? CATEGORY_RANK.countries;
}

/** Signature "Danced every N days" cadence badge; null when cadence is unknown. */
function cadenceBadgeOf(cadenceDays: number | null): ScopedBadge | null {
    if (cadenceDays == null) return null;
    return {
        key: 'cadence',
        icon: '🔁',
        label: `Danced every ${cadenceDays} ${cadenceDays === 1 ? 'day' : 'days'}`,
    };
}

function eventYear(iso: string): number | null {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

/** Per-month attended-event counts ("YYYY-MM"), oldest first. */
function monthlyFromEvents(events: PassportMapEvent[]): MonthlyActivity[] {
    const counts = new Map<string, number>();
    for (const ev of events) {
        const d = new Date(ev.start);
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, count]) => ({ month, count }));
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

/** Distinct calendar months with >=1 event in `year`. */
function activeMonthsInYear(events: PassportMapEvent[], year: number): number {
    const months = new Set<number>();
    for (const ev of events) {
        const d = new Date(ev.start);
        if (!Number.isNaN(d.getTime()) && d.getFullYear() === year) months.add(d.getMonth());
    }
    return months.size;
}

/** Actual-count totals used to describe all-time milestone badges accurately. */
interface AllTimeTotals {
    events: number;
    cities: number;
    countries: number;
    reviews: number;
}

function pluralNoun(n: number, noun: string): string {
    if (n === 1) return noun;
    if (noun === 'city') return 'cities';
    if (noun === 'country') return 'countries';
    return `${noun}s`;
}

function countLabel(n: number, noun: string): string {
    return `${n} ${pluralNoun(n, noun)}`;
}

/**
 * Description for an all-time milestone badge that reflects the dancer's
 * *actual* totals rather than the milestone's fixed threshold (e.g. "World
 * Dancer" reads "7 countries", not the misleading "Dance in 5 countries" when
 * they've reached 7).
 */
function milestoneDescription(m: PassportMilestone, totals: AllTimeTotals): string {
    switch (m.category) {
        case 'events':
            return countLabel(totals.events, 'event');
        case 'cities':
            return countLabel(totals.cities, 'city');
        case 'countries':
            return countLabel(totals.countries, 'country');
        case 'reviews':
            return countLabel(totals.reviews, 'review');
        default:
            return m.description;
    }
}

/**
 * Highest-prestige unlocked milestone per category, ordered for the badge row.
 *
 * Only the most impressive badge in each family surfaces — e.g. "World Dancer"
 * (5 countries) replaces "Passport Stamped" (3 countries) rather than showing
 * both — so the card never repeats an overshadowed lower tier. Consistency
 * (streak) leads and reviews trail via CATEGORY_RANK.
 */
function topMilestonePerCategory(milestones: PassportMilestone[]): PassportMilestone[] {
    const best = new Map<string, PassportMilestone>();
    for (const m of milestones) {
        if (!m.unlocked) continue;
        const cur = best.get(m.category);
        if (
            !cur ||
            m.prestige > cur.prestige ||
            (m.prestige === cur.prestige && m.threshold > cur.threshold)
        ) {
            best.set(m.category, m);
        }
    }
    return [...best.values()].sort(
        (a, b) =>
            categoryRank(a.category) - categoryRank(b.category) ||
            b.prestige - a.prestige ||
            b.threshold - a.threshold,
    );
}

/** Milestones unlocked within `year` (ordered for the badge row). */
function milestonesUnlockedInYear(
    milestones: PassportMilestone[],
    year: number,
): PassportMilestone[] {
    const best = new Map<string, PassportMilestone>();
    for (const m of milestones) {
        if (!m.unlocked || m.unlocked_at == null || eventYear(m.unlocked_at) !== year) continue;
        const cur = best.get(m.category);
        if (
            !cur ||
            m.prestige > cur.prestige ||
            (m.prestige === cur.prestige && m.threshold > cur.threshold)
        ) {
            best.set(m.category, m);
        }
    }
    return [...best.values()].sort(
        (a, b) =>
            categoryRank(a.category) - categoryRank(b.category) ||
            b.prestige - a.prestige ||
            b.threshold - a.threshold,
    );
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
    const n = perMonth[idx];
    return {
        key: 'busiest_month',
        icon: '📅',
        label: `Most active · ${name}`,
        description: `${n} ${n === 1 ? 'event' : 'events'}`,
    };
}

/** New places (with labels) whose key first appears in `year`. */
interface NewPlaces {
    count: number;
    names: string[];
}

function newPlaces(
    year: number,
    allEvents: PassportMapEvent[],
    keyOf: (ev: PassportMapEvent) => string | null,
    labelOf: (ev: PassportMapEvent) => string | null,
): NewPlaces | null {
    const prior = new Set<string>();
    const currentLabels = new Map<string, string>();
    for (const ev of allEvents) {
        const y = eventYear(ev.start);
        const key = keyOf(ev);
        if (y == null || key == null) continue;
        if (y < year) prior.add(key);
        else if (y === year && !currentLabels.has(key)) currentLabels.set(key, (labelOf(ev) || '').trim());
    }
    const names: string[] = [];
    for (const [key, label] of currentLabels) if (!prior.has(key)) names.push(label);
    if (names.length === 0) return null;
    return { count: names.length, names };
}

/** Up to 3 place names, then ", …" when more remain. */
function placesDescription(places: NewPlaces): string {
    const shown = places.names.slice(0, 3).join(', ');
    return places.names.length > 3 ? `${shown}, …` : shown;
}

function newPlacesBadge(noun: string, icon: string, places: NewPlaces): ScopedBadge {
    return {
        key: `new_${noun}`,
        icon,
        label: `+${places.count} new ${pluralNoun(places.count, noun)}`,
        description: placesDescription(places),
    };
}

/**
 * Build the scoped summary the share card renders.
 *
 * @param events  All attended events (from /api/passport/events).
 * @param milestones  The all-time milestone list (with `unlocked_at`).
 * @param scope  `'all'` or a calendar year.
 * @param topStyle  Most-danced style label (all-time, from backend stats).
 * @param reviewsTotal  All-time approved review count (for the reviews badge).
 * @param consistency  Recurring-consistency summary (for the all-time active-
 *   months count and the lifetime consistency badge); null when unavailable.
 */
export function scopePassport(
    events: PassportMapEvent[],
    milestones: PassportMilestone[],
    scope: ShareScope,
    topStyle: string | null = null,
    reviewsTotal = 0,
    consistency: PassportConsistency | null = null,
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

    const cadenceDays = cadence(scoped);
    const activeMonths =
        scope === 'all'
            ? (consistency?.active_months ?? 0)
            : activeMonthsInYear(scoped, scope);

    let badges: ScopedBadge[];
    let consistencyInBadges = false;
    if (scope === 'all') {
        // Order every badge by family (CATEGORY_RANK): consistency leads, reviews
        // trail. The cadence signature sits with consistency (just after it)
        // and top style just ahead of reviews, so the least-prestigious "Critic"
        // badge is the first thing dropped when the row overflows.
        const totals: AllTimeTotals = {
            events: scoped.length,
            cities: cityKeys.size,
            countries: countryKeys.size,
            reviews: reviewsTotal,
        };
        type Ranked = { badge: ScopedBadge; rank: number; category: string };
        const ranked: Ranked[] = topMilestonePerCategory(milestones).map((m) => ({
            badge: {
                key: m.key,
                icon: m.icon,
                label: m.name,
                description: milestoneDescription(m, totals),
            },
            rank: categoryRank(m.category),
            category: m.category,
        }));
        // Lifetime consistency highlight: strongest level ever reached, with a
        // "×N" note when it recurred across multiple periods.
        const top = consistency?.top;
        if (top) {
            const win = consistency?.window ?? 12;
            const recur =
                top.times === 1
                    ? ''
                    : top.times === 2
                        ? ', twice'
                        : `, ${top.times} times`;
            ranked.push({
                badge: {
                    key: `consistency_top_${top.key}`,
                    icon: top.icon,
                    label: top.times > 1 ? `${top.name} ×${top.times}` : top.name,
                    description: `${top.threshold}/${win} active months${recur}`,
                },
                rank: CATEGORY_RANK.consistency,
                category: 'consistency',
            });
        }
        const cadenceBadge = cadenceBadgeOf(cadenceDays);
        if (cadenceBadge) {
            ranked.push({
                badge: cadenceBadge,
                rank: CATEGORY_RANK.consistency + 0.5,
                category: 'cadence',
            });
        }
        if (topStyle) {
            ranked.push({
                badge: { key: 'top_style', icon: '❤️', label: `Top style · ${topStyle}` },
                rank: CATEGORY_RANK.reviews - 0.5,
                category: 'style',
            });
        }
        const shown = ranked.sort((a, b) => a.rank - b.rank).slice(0, MAX_BADGES);
        consistencyInBadges = shown.some((r) => r.category === 'consistency');
        badges = shown.map((r) => r.badge);
    } else {
        // Year card: cadence + busiest month lead, then new places / milestones
        // unlocked that year. A geography milestone unlocked in-year absorbs the
        // matching "new countries/cities" detail so the two don't repeat.
        const newCountries = newPlaces(scope, events, countryKey, (e) => e.country);
        const newCities = newPlaces(scope, events, cityKey, (e) => e.city);
        const usedGeo = new Set<string>();
        const yearMilestones = milestonesUnlockedInYear(milestones, scope)
            .map((m): ScopedBadge => {
                if (m.category === 'countries' && newCountries) {
                    usedGeo.add('countries');
                    return { key: m.key, icon: m.icon, label: m.name, description: placesDescription(newCountries) };
                }
                if (m.category === 'cities' && newCities) {
                    usedGeo.add('cities');
                    return { key: m.key, icon: m.icon, label: m.name, description: placesDescription(newCities) };
                }
                return { key: m.key, icon: m.icon, label: m.name, tag: 'Unlocked' };
            });
        const geoBadges: ScopedBadge[] = [];
        if (newCountries && !usedGeo.has('countries')) {
            geoBadges.push(newPlacesBadge('country', '🌍', newCountries));
        }
        if (newCities && !usedGeo.has('cities')) {
            geoBadges.push(newPlacesBadge('city', '✈️', newCities));
        }
        const busiest = busiestMonthBadge(scope, scoped);
        // Yearly consistency highlight: the displayed calendar year's own Jan–Dec
        // active-month count, classified to a level (no periods, no lifetime
        // unlock). Leads the year card when the count qualifies.
        const yearLevel = consistency?.by_year.find((y) => y.year === scope);
        const consistencyYearBadge: ScopedBadge | null =
            yearLevel && yearLevel.key
                ? {
                    key: `consistency_year_${yearLevel.key}`,
                    icon: yearLevel.icon ?? '📅',
                    label: yearLevel.name ?? 'Consistent',
                    description: `${yearLevel.threshold}/12 active months`,
                }
                : null;
        badges = [
            consistencyYearBadge,
            cadenceBadgeOf(cadenceDays),
            busiest,
            ...geoBadges,
            ...yearMilestones,
        ]
            .filter((b): b is ScopedBadge => b !== null)
            .slice(0, MAX_BADGES);
    }

    return {
        scope,
        totalEvents: scoped.length,
        cities: cityKeys.size,
        countries: countryKeys.size,
        cadenceDays,
        activeMonths,
        activeMonthsOf: 12,
        topStyle: scope === 'all' ? topStyle : null,
        topCity: topCityLabel(scoped),
        coords: coordsOf(scoped),
        badges,
        monthly: monthlyFromEvents(scoped),
        consistencyInBadges,
    };
}
