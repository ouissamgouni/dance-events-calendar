import type { CalendarEvent, TagGroup } from '../types';

/**
 * Disjunctive faceting filter shared by the Explorer and the onboarding
 * live preview so both apply the same tag semantics:
 *  - Within a multi-select group: OR (event must match ANY selected tag in
 *    that group).
 *  - Across groups: AND (event must satisfy every group that has a selection).
 * Single-select groups behave the same as OR (only one tag can be selected).
 */
export function filterEventsByTags(
    events: CalendarEvent[],
    activeTagIds: Set<number>,
    tagGroups: TagGroup[],
): CalendarEvent[] {
    if (activeTagIds.size === 0) return events;

    const tagToGroupSlug = new Map<number, string>();
    for (const g of tagGroups) {
        for (const t of g.tags) tagToGroupSlug.set(t.id, g.slug);
    }
    const groupBuckets = new Map<string, number[]>();
    const ungrouped: number[] = [];
    for (const id of activeTagIds) {
        const slug = tagToGroupSlug.get(id);
        if (!slug) { ungrouped.push(id); continue; }
        const arr = groupBuckets.get(slug);
        if (arr) arr.push(id);
        else groupBuckets.set(slug, [id]);
    }

    return events.filter((event) => {
        const tagSet = new Set((event.tags ?? []).map((tag) => tag.id));
        for (const ids of groupBuckets.values()) {
            if (!ids.some((id) => tagSet.has(id))) return false;
        }
        for (const id of ungrouped) {
            if (!tagSet.has(id)) return false;
        }
        return true;
    });
}
