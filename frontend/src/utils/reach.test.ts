import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Tag } from '../types';
import { countHiddenByReach, eventMatchesReach, isCityScaleBounds, type ReachFilter } from './reach';

function event(reach: 'local' | 'regional' | 'international' | null): Pick<CalendarEvent, 'tags'> {
    return {
        tags: reach === null ? [] : [{ group_slug: 'reach', slug: reach } as Tag],
    };
}

describe('eventMatchesReach', () => {
    const cases: Array<[ReachFilter, boolean, boolean, boolean, boolean]> = [
        ['any', true, true, true, true],
        ['regional_plus', false, false, true, true],
        ['international', false, false, false, true],
    ];

    it.each(cases)(
        '%s matches the expected reach classifications',
        (filter, unclassified, local, regional, international) => {
            expect(eventMatchesReach(event(null), filter)).toBe(unclassified);
            expect(eventMatchesReach(event('local'), filter)).toBe(local);
            expect(eventMatchesReach(event('regional'), filter)).toBe(regional);
            expect(eventMatchesReach(event('international'), filter)).toBe(international);
        },
    );
});

describe('countHiddenByReach', () => {
    const events = [event(null), event('local'), event('regional'), event('international')];

    it('counts untagged and lower-reach events as hidden', () => {
        expect(countHiddenByReach(events, 'any')).toBe(0);
        expect(countHiddenByReach(events, 'regional_plus')).toBe(2);
        expect(countHiddenByReach(events, 'international')).toBe(3);
    });
});

describe('isCityScaleBounds', () => {
    // ~0.5° lat box ≈ 55 km tall; ~2° box ≈ 220+ km diagonal.
    const city = { south: 48.6, north: 49.1, west: 2.1, east: 2.6 };
    const between = { south: 48.3, north: 49.4, west: 1.6, east: 3.0 };
    const region = { south: 47.5, north: 50, west: 0.5, east: 4.5 };

    it('enters at city scale and keeps relaxing until the wider exit threshold', () => {
        expect(isCityScaleBounds(city, false)).toBe(true);
        expect(isCityScaleBounds(between, false)).toBe(false);
        expect(isCityScaleBounds(between, true)).toBe(true);
        expect(isCityScaleBounds(region, true)).toBe(false);
    });
});
