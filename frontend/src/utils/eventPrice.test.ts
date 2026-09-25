import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types';
import { formatEventPrice } from './eventPrice';

function price(overrides: Partial<CalendarEvent>): CalendarEvent {
    return {
        price_is_free: false,
        price_min: null,
        price_max: null,
        price_currency: null,
        ...overrides,
    } as CalendarEvent;
}

describe('formatEventPrice', () => {
    it('formats free, fixed, bounded, and minimum-only prices', () => {
        expect(formatEventPrice(price({ price_is_free: true }))).toBe('Free');
        expect(formatEventPrice(price({ price_min: 15, price_max: 15, price_currency: 'EUR' }))).toBe('€15');
        expect(formatEventPrice(price({ price_min: 12, price_max: 18, price_currency: 'EUR' }))).toBe('€12–18');
        expect(formatEventPrice(price({ price_min: 120, price_currency: 'EUR' }))).toBe('€120+');
    });

    it('supports code and repeated-currency display styles', () => {
        const event = price({ price_min: 12, price_max: 18, price_currency: 'EUR' });

        expect(formatEventPrice(event, { currencyDisplay: 'code' })).toBe('EUR 12–18');
        expect(formatEventPrice(event, { repeatCurrency: true })).toBe('€12–€18');
    });

    it('omits incomplete paid prices', () => {
        expect(formatEventPrice(price({ price_min: 12 }))).toBeNull();
        expect(formatEventPrice(price({ price_currency: 'EUR' }))).toBeNull();
    });
});
