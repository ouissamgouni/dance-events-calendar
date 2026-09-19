import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Tag } from '../types';
import { eventMatchesReach, type ReachFilter } from './reach';

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
