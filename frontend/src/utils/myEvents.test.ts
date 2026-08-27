import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types';
import {
    buildJourneyLegs,
    eventsForMyEventsTab,
    eventsOverlappingRange,
    groupMyEventsByMonth,
    initialMyEventsTab,
    sequenceMappableEvents,
} from './myEvents';

function event(id: string, start: string, end: string, located = true): CalendarEvent {
    return {
        event_id: id,
        calendar_id: 'cal',
        title: id,
        description: null,
        location: null,
        latitude: located ? 48 : null,
        longitude: located ? 2 : null,
        start,
        end,
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: true,
        links: null,
        tags: [],
    };
}

const now = new Date('2026-08-25T12:00:00Z').getTime();
const past = event('past', '2026-07-02T20:00:00Z', '2026-07-02T22:00:00Z');
const first = event('first', '2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
const overlap = event('overlap', '2026-10-05T20:00:00Z', '2026-10-05T22:00:00Z');
const unmapped = event('unmapped', '2026-11-05T20:00:00Z', '2026-11-05T22:00:00Z', false);
const all = [overlap, past, unmapped, first];
const saved = new Set(['overlap', 'unmapped']);
const attending = new Set(['past', 'first', 'overlap']);

describe('initialMyEventsTab', () => {
    it('supports canonical tabs and legacy saved/going links', () => {
        expect(initialMyEventsTab('?tab=past')).toBe('past');
        expect(initialMyEventsTab('?filter=saved')).toBe('saved');
        expect(initialMyEventsTab('?filter=going')).toBe('upcoming');
    });
});

describe('eventsForMyEventsTab', () => {
    it('allows saved and upcoming membership to overlap', () => {
        const isSaved = (id: string) => saved.has(id);
        const isAttending = (id: string) => attending.has(id);

        expect(eventsForMyEventsTab(all, 'upcoming', isSaved, isAttending, now).map((item) => item.event_id))
            .toEqual(['first', 'overlap']);
        expect(eventsForMyEventsTab(all, 'saved', isSaved, isAttending, now).map((item) => item.event_id))
            .toEqual(['overlap', 'unmapped']);
        expect(eventsForMyEventsTab(all, 'past', isSaved, isAttending, now).map((item) => item.event_id))
            .toEqual(['past']);
    });
});

describe('My Events chronology', () => {
    it('includes every event overlapping the visible calendar range', () => {
        const rangeStart = new Date('2026-09-01T00:00:00Z');
        const rangeEnd = new Date('2026-09-22T00:00:00Z');
        const spanningStart = event('spanning-start', '2026-08-31T20:00:00Z', '2026-09-01T01:00:00Z');
        const endingAtStart = event('ending-at-start', '2026-08-31T20:00:00Z', '2026-09-01T00:00:00Z');
        const startingAtEnd = event('starting-at-end', '2026-09-22T00:00:00Z', '2026-09-22T02:00:00Z');

        expect(eventsOverlappingRange([first, spanningStart, endingAtStart, startingAtEnd], rangeStart, rangeEnd)
            .map((item) => item.event_id))
            .toEqual(['first', 'spanning-start', 'ending-at-start']);
    });

    it('groups the rendered order by month and sequences only mappable events oldest-first', () => {
        expect(groupMyEventsByMonth([first, overlap]).map((group) => group.key)).toEqual(['2026-09', '2026-10']);
        expect(sequenceMappableEvents([overlap, unmapped, first]).map(({ event: item, sequence }) => [item.event_id, sequence]))
            .toEqual([['first', 1], ['overlap', 2]]);
    });

    it('builds one curved directional leg between each chronological location', () => {
        const legs = buildJourneyLegs([first, overlap]);
        expect(legs).toHaveLength(1);
        expect(legs[0].path).toHaveLength(21);
        expect(legs[0].path[0]).toEqual([48, 2]);
        expect(legs[0].arrow).toHaveLength(3);
    });
});
