import type { CalendarEvent } from '../types';

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
