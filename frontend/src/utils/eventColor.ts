import type { CalendarEvent } from '../types';

export const MAX_TAG_STRIPES = 3;

/**
 * Returns up to MAX_TAG_STRIPES hex color strings derived from the event's
 * hero tags (`is_hero_filter === true`), sorted by `hero_ordinal` (then
 * label as tiebreaker). Each tag's color priority is `group_color ?? color`.
 * Hero tags without a color are skipped. Returns an empty array when the
 * event has no hero tags.
 */
export function getTagColors(event: CalendarEvent): string[] {
    const heroTags = (event.tags || []).filter((t) => t.is_hero_filter);
    const sorted = heroTags.sort((a, b) => {
        const ao = a.hero_ordinal ?? Number.MAX_SAFE_INTEGER;
        const bo = b.hero_ordinal ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (a.label || '').localeCompare(b.label || '');
    });
    const colors: string[] = [];
    for (const t of sorted) {
        const c = t.group_color ?? t.color;
        if (c) {
            colors.push(c);
            if (colors.length >= MAX_TAG_STRIPES) break;
        }
    }
    return colors;
}
