import type { SeriesEditionSummary } from '../types';

export function isEventPast(event: { end: string }, now: number = Date.now()): boolean {
    return new Date(event.end).getTime() < now;
}

/** Earliest edition of the series that hasn't started yet. */
export function findNextEdition(
    editions: SeriesEditionSummary[] | undefined,
    now: number = Date.now(),
): SeriesEditionSummary | null {
    let next: SeriesEditionSummary | null = null;
    for (const e of editions ?? []) {
        const start = new Date(e.start).getTime();
        if (start <= now) continue;
        if (!next || start < new Date(next.start).getTime()) next = e;
    }
    return next;
}

export interface ResultGroup<T> {
    key: 'all' | 'upcoming' | 'past';
    title: string | null;
    items: T[];
}

/** Keeps relevance order within each group; past results go last when mixed. */
export function searchResultGroups<T>(
    items: T[],
    getEnd: (item: T) => string | null | undefined,
    includePast: boolean,
    now: number = Date.now(),
): ResultGroup<T>[] {
    if (!includePast) return [{ key: 'all', title: null, items }];
    const upcoming: T[] = [];
    const past: T[] = [];
    for (const item of items) {
        const end = getEnd(item);
        (end && isEventPast({ end }, now) ? past : upcoming).push(item);
    }
    if (past.length === 0 || upcoming.length === 0) return [{ key: 'all', title: null, items }];
    return [
        { key: 'upcoming', title: 'Upcoming', items: upcoming },
        { key: 'past', title: 'Past', items: past },
    ];
}
