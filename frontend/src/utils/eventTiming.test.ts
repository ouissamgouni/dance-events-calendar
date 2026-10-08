import { describe, expect, it } from 'vitest';
import type { SeriesEditionSummary } from '../types';
import { findNextEdition, isEventPast, searchResultGroups } from './eventTiming';

const NOW = new Date('2026-06-01T12:00:00Z').getTime();

function edition(event_id: string, start: string): SeriesEditionSummary {
    return {
        event_id,
        title: event_id,
        start,
        end: null,
        review_count: 0,
        average_mood: 0,
        positive_percentage: 0,
        mood_label: null,
        display_state: 'none',
    };
}

describe('isEventPast', () => {
    it('is true only once the event has ended', () => {
        expect(isEventPast({ end: '2026-06-01T11:00:00Z' }, NOW)).toBe(true);
        expect(isEventPast({ end: '2026-06-01T13:00:00Z' }, NOW)).toBe(false);
    });
});

describe('findNextEdition', () => {
    it('returns the earliest edition that has not started', () => {
        const editions = [
            edition('past', '2025-06-01T20:00:00Z'),
            edition('later', '2027-06-01T20:00:00Z'),
            edition('next', '2026-09-01T20:00:00Z'),
        ];
        expect(findNextEdition(editions, NOW)?.event_id).toBe('next');
    });

    it('returns null when every edition has started', () => {
        expect(findNextEdition([edition('past', '2025-06-01T20:00:00Z')], NOW)).toBeNull();
        expect(findNextEdition(undefined, NOW)).toBeNull();
    });
});

describe('searchResultGroups', () => {
    const items = [
        { id: 'old', end: '2025-01-01T00:00:00Z' },
        { id: 'soon', end: '2026-07-01T00:00:00Z' },
        { id: 'older', end: '2024-01-01T00:00:00Z' },
    ];
    const getEnd = (item: { end: string }) => item.end;

    it('splits mixed results into upcoming then past, keeping order', () => {
        const groups = searchResultGroups(items, getEnd, true, NOW);
        expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
            ['Upcoming', ['soon']],
            ['Past', ['old', 'older']],
        ]);
    });

    it('keeps one untitled group when past is excluded or results are not mixed', () => {
        expect(searchResultGroups(items, getEnd, false, NOW)).toEqual([{ key: 'all', title: null, items }]);
        const pastOnly = [items[0], items[2]];
        expect(searchResultGroups(pastOnly, getEnd, true, NOW)).toEqual([{ key: 'all', title: null, items: pastOnly }]);
    });
});
