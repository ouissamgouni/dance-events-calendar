import { describe, expect, it } from 'vitest';
import { initialEventFilter, initialInterestKind, initialInterestSource } from './MyCalendar';

describe('MyCalendar event filter initialization', () => {
    it('opens the Going scope from the next-event link', () => {
        expect(initialEventFilter('?filter=going')).toBe('going');
    });

    it('falls back to all events for missing or invalid values', () => {
        expect(initialEventFilter('')).toBe('all');
        expect(initialEventFilter('?filter=upcoming')).toBe('all');
    });
});

describe('MyCalendar interest query initialization', () => {
    it('opens the friends-going scope from the For You See all link', () => {
        const search = '?interest_source=friends&interest_kind=going';
        expect(initialInterestSource(search)).toBe('friends');
        expect(initialInterestKind(search)).toBe('going');
    });

    it('falls back to the existing defaults for invalid query values', () => {
        const search = '?interest_source=everyone&interest_kind=maybe';
        expect(initialInterestSource(search)).toBeNull();
        expect(initialInterestKind(search)).toBe('going');
    });
});
