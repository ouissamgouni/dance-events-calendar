import type { CalendarEvent } from '../types';
import { areaDiagonalKm, WIDE_AREA_THRESHOLD_KM } from '../constants/area';

export type ReachFilter = 'any' | 'regional_plus' | 'international';
export type EventReach = 'local' | 'regional' | 'international';

export const REACH_FILTER_LABELS: Record<ReachFilter, string> = {
    any: 'Any',
    regional_plus: 'Regional+',
    international: 'International',
};

export const REACH_FILTER_ICON_SRC: Record<ReachFilter, string> = {
    any: '/reach.png',
    regional_plus: '/nearby-reach.png',
    international: '/international-reach.png',
};

export function eventReach(event: Pick<CalendarEvent, 'tags'>): EventReach | null {
    const slug = event.tags.find((tag) => tag.group_slug === 'reach')?.slug;
    return slug === 'local' || slug === 'regional' || slug === 'international' ? slug : null;
}

export function eventMatchesReach(
    event: Pick<CalendarEvent, 'tags'>,
    reachFilter: ReachFilter,
): boolean {
    if (reachFilter === 'any') return true;
    const reach = eventReach(event);
    if (reachFilter === 'regional_plus') {
        return reach === 'regional' || reach === 'international';
    }
    return reach === 'international';
}

// Hysteresis so the zoom-driven relaxation doesn't flicker around the threshold.
export const CITY_SCALE_ENTER_KM = WIDE_AREA_THRESHOLD_KM;
export const CITY_SCALE_EXIT_KM = 200;

export interface ViewportBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

export function isCityScaleBounds(bounds: ViewportBounds, wasCityScale: boolean): boolean {
    const diagonal = areaDiagonalKm({
        min_lat: bounds.south,
        min_lng: bounds.west,
        max_lat: bounds.north,
        max_lng: bounds.east,
    });
    return diagonal <= (wasCityScale ? CITY_SCALE_EXIT_KM : CITY_SCALE_ENTER_KM);
}

export function eventInBounds(
    event: Pick<CalendarEvent, 'latitude' | 'longitude'>,
    bounds: ViewportBounds,
): boolean {
    if (event.latitude == null || event.longitude == null) return false;
    return event.latitude >= bounds.south
        && event.latitude <= bounds.north
        && event.longitude >= bounds.west
        && event.longitude <= bounds.east;
}

/** Number of events the reach filter removes (untagged events count as local). */
export function countHiddenByReach(
    events: Array<Pick<CalendarEvent, 'tags'>>,
    reachFilter: ReachFilter,
): number {
    if (reachFilter === 'any') return 0;
    return events.reduce((n, event) => (eventMatchesReach(event, reachFilter) ? n : n + 1), 0);
}
