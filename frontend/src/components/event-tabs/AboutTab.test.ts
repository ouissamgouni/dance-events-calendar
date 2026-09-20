import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../types';
import { priceRange } from './AboutTab';

function eventWithPrice(overrides: Partial<CalendarEvent>): CalendarEvent {
    return {
        price_is_free: null,
        price_min: null,
        price_max: null,
        price_currency: null,
        ...overrides,
    } as CalendarEvent;
}

describe('priceRange', () => {
    it('returns Free only for explicitly free events', () => {
        expect(priceRange(eventWithPrice({ price_is_free: true }))).toBe('Free');
        expect(priceRange(eventWithPrice({ price_is_free: false }))).toBeNull();
    });

    it('formats paid prices only when an amount and currency are available', () => {
        expect(priceRange(eventWithPrice({
            price_is_free: false,
            price_min: 12,
            price_max: 15,
            price_currency: 'EUR',
        }))).toBe('€12–15');
        expect(priceRange(eventWithPrice({ price_is_free: false, price_min: 12 }))).toBeNull();
    });
});
