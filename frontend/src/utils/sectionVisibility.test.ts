import { describe, expect, it } from 'vitest'
import { isPriceSectionVisible, isPromoSectionVisible } from './sectionVisibility'
import type { CalendarEvent } from '../types'

// Per-event show_price_override / show_promo_override take precedence over
// the global feature flags when set; null/undefined falls back to the flag.
function event(overrides: Partial<CalendarEvent>): CalendarEvent {
    return overrides as CalendarEvent
}

describe('isPriceSectionVisible', () => {
    it('inherits the global flag when the override is unset', () => {
        expect(isPriceSectionVisible(event({}), true)).toBe(true)
        expect(isPriceSectionVisible(event({}), false)).toBe(false)
    })

    it('forces the section on when the override is true, even if the flag is off', () => {
        expect(isPriceSectionVisible(event({ show_price_override: true }), false)).toBe(true)
    })

    it('forces the section off when the override is false, even if the flag is on', () => {
        expect(isPriceSectionVisible(event({ show_price_override: false }), true)).toBe(false)
    })
})

describe('isPromoSectionVisible', () => {
    it('inherits the global flag when the override is unset', () => {
        expect(isPromoSectionVisible(event({}), true)).toBe(true)
        expect(isPromoSectionVisible(event({}), false)).toBe(false)
    })

    it('forces the section on when the override is true, even if the flag is off', () => {
        expect(isPromoSectionVisible(event({ show_promo_override: true }), false)).toBe(true)
    })

    it('forces the section off when the override is false, even if the flag is on', () => {
        expect(isPromoSectionVisible(event({ show_promo_override: false }), true)).toBe(false)
    })
})
