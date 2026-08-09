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
    /** Longest run of consecutive calendar months with an event, within scope. */
    monthStreak: number;
    /** Most-danced style label (all-time, from backend); null when unknown. */
    topStyle: string | null;
    topCity: string | null;
    coords: { lat: number; lng: number }[];
    /** Up to MAX_BADGES badges/highlights for the card's badge row. */
    badges: ScopedBadge[];
    /**
     * True when an all-time streak/regularity milestone (e.g. "Consistent")
     * already occupies a badge slot, so the card hides the redundant streak
     * stat cell.
     */
    streakInBadges: boolean;
}

const MAX_BADGES = 6;
const MS_PER_DAY = 86_400_000;

// Badge display order across milestone families: consistency (streak) leads,
// reviews ("Critic") trail. Everything else sits in the middle by prestige.
const CATEGORY_RANK: Record<string, number> = {
    streak: 0,
    events: 1,
    cities: 2,
    countries: 3,
    international: 4,
    reviews: 5,
};

function categoryRank(category: string): number {
    return CATEGORY_RANK[category] ?? CATEGORY_RANK.countries;
}

/**
 * Drop the "international" milestone ("Border Crosser") once any "countries"
 * milestone is present — dancing in multiple countries already implies crossing
 * a border, so the lower-tier badge is redundant.
 */
function suppressRedundant(milestones: PassportMilestone[]): PassportMilestone[] {
    const hasCountries = milestones.some((m) => m.category === 'countries');
    return hasCountries ? milestones.filter((m) => m.category !== 'international') : milestones;
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

/** Longest run of consecutive calendar months containing >=1 event, in scope. */
function monthStreakOf(events: PassportMapEvent[]): number {
    const months = new Set<number>();
    for (const ev of events) {
        const d = new Date(ev.start);
        if (!Number.isNaN(d.getTime())) months.add(d.getFullYear() * 12 + d.getMonth());
    }
    const sorted = [...months].sort((a, b) => a - b);
    let best = 0;
    let run = 0;
    let prev: number | null = null;
    for (const idx of sorted) {
        run = prev !== null && idx - prev === 1 ? run + 1 : 1;
        if (run > best) best = run;
        prev = idx;
    }
    return best;
}

/** Actual-count totals used to describe all-time milestone badges accurately. */
interface AllTimeTotals {
    events: number;
    cities: number;
    countries: number;
    monthStreak: number;
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
        case 'streak':
            return `${totals.monthStreak} ${totals.monthStreak === 1 ? 'month' : 'months'} in a row`;
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
    return suppressRedundant([...best.values()]).sort(
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
    return suppressRedundant([...best.values()]).sort(
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
 */
export function scopePassport(
    events: PassportMapEvent[],
    milestones: PassportMilestone[],
    scope: ShareScope,
    topStyle: string | null = null,
    reviewsTotal = 0,
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
    const monthStreak = monthStreakOf(scoped);

    let badges: ScopedBadge[];
    let streakInBadges = false;
    if (scope === 'all') {
        // Order every badge by family (CATEGORY_RANK): consistency leads, reviews
        // trail. The cadence signature sits with consistency (just after streak)
        // and top style just ahead of reviews, so the least-prestigious "Critic"
        // badge is the first thing dropped when the row overflows.
        const totals: AllTimeTotals = {
            events: scoped.length,
            cities: cityKeys.size,
            countries: countryKeys.size,
            monthStreak,
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
        const cadenceBadge = cadenceBadgeOf(cadenceDays);
        if (cadenceBadge) {
            ranked.push({ badge: cadenceBadge, rank: CATEGORY_RANK.streak + 0.5, category: 'cadence' });
        }
        if (topStyle) {
            ranked.push({
                badge: { key: 'top_style', icon: '❤️', label: `Top style · ${topStyle}` },
                rank: CATEGORY_RANK.reviews - 0.5,
                category: 'style',
            });
        }
        const shown = ranked.sort((a, b) => a.rank - b.rank).slice(0, MAX_BADGES);
        streakInBadges = shown.some((r) => r.category === 'streak');
        badges = shown.map((r) => r.badge);
    } else {
        // Year card: cadence + busiest month lead, then new places / milestones
        // unlocked that year. A geography milestone unlocked in-year absorbs the
        // matching "new countries/cities" detail so the two don't repeat. Streak
        // milestones are dropped here — the spelled-out streak stat cell already
        // carries that fact on the year card.
        const newCountries = newPlaces(scope, events, countryKey, (e) => e.country);
        const newCities = newPlaces(scope, events, cityKey, (e) => e.city);
        const usedGeo = new Set<string>();
        const yearMilestones = milestonesUnlockedInYear(milestones, scope)
            .filter((m) => m.category !== 'streak')
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
        badges = [cadenceBadgeOf(cadenceDays), busiest, ...geoBadges, ...yearMilestones]
            .filter((b): b is ScopedBadge => b !== null)
            .slice(0, MAX_BADGES);
    }

    return {
        scope,
        totalEvents: scoped.length,
        cities: cityKeys.size,
        countries: countryKeys.size,
        cadenceDays,
        monthStreak,
        topStyle: scope === 'all' ? topStyle : null,
        topCity: topCityLabel(scoped),
        coords: coordsOf(scoped),
        badges,
        streakInBadges,
    };
}
