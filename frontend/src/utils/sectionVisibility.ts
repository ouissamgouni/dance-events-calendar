import type { CalendarEvent } from '../types';

/**
 * Effective price-section visibility for an event: the per-event
 * ``show_price_override`` takes precedence over the global ``showPrices``
 * feature flag when set (``true``/``false``); ``null``/``undefined`` means
 * inherit the global flag.
 */
export function isPriceSectionVisible(event: CalendarEvent, globalShowPrices: boolean): boolean {
    return event.show_price_override ?? globalShowPrices;
}

/**
 * Effective promo-code-section visibility for an event: the per-event
 * ``show_promo_override`` takes precedence over the global
 * ``promoCodesEnabled`` feature flag when set; ``null``/``undefined`` means
 * inherit the global flag.
 */
export function isPromoSectionVisible(event: CalendarEvent, globalPromoCodesEnabled: boolean): boolean {
    return event.show_promo_override ?? globalPromoCodesEnabled;
}
