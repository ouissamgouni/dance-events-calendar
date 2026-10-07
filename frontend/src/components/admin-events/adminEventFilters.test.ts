import { describe, expect, it } from 'vitest'
import {
    DEFAULT_FILTERS,
    FILTER_DIMENSIONS,
    clearDimension,
    dimensionCount,
    dimensionPresenceCount,
    dimensionSummary,
    loadCustomPresets,
    matchQuickView,
    nextSort,
    presetFrom,
    saveCustomPresets,
    toFilterParams,
} from './adminEventFilters'
import { defaultTablePrefs, sanitizeTablePrefs } from './useAdminEventsTablePrefs'

const dim = (id: string) => FILTER_DIMENSIONS.find((d) => d.id === id)!

describe('admin event filters', () => {
    it('reads counts by API param name', () => {
        const options = {
            calendars: [], audiences: [], statuses: [], flags: [], geo_statuses: [], tags: [], total_count: 0,
            dimension_counts: { geo_status: 4, price: 2, dates: 9 },
            has_counts: { has_image: { yes: 5, no: 1 } },
            min_counts: { going_min: 7 },
        }
        expect(dimensionCount(dim('geo'), options)).toBe(4)
        expect(dimensionCount(dim('price'), options)).toBe(2)
        expect(dimensionCount(dim('dates'), options)).toBe(9)
        expect(dimensionPresenceCount(dim('has_image'), options)).toBe(5)
        expect(dimensionPresenceCount(dim('goingMin'), options)).toBe(7)
        expect(dimensionPresenceCount(dim('price'), options)).toBeUndefined()
    })
    it('maps state to API params, dates only when in range mode', () => {
        const params = toFilterParams({
            ...DEFAULT_FILTERS,
            price: ['paid'],
            goingMin: 3,
            has: { has_tags: false },
            dateMode: 'range',
            startFrom: '2026-10-01',
        })
        expect(params).toMatchObject({ price: ['paid'], going_min: 3, has: { has_tags: false }, start_from: '2026-10-01' })
        expect(params.include_past).toBeUndefined()
        expect(toFilterParams({ ...DEFAULT_FILTERS, startFrom: '2026-10-01' }).start_from).toBeUndefined()
        expect(toFilterParams({ ...DEFAULT_FILTERS, dateMode: 'all' }).include_past).toBe(true)
    })

    it('summarises and clears each kind of filter', () => {
        const state = { ...DEFAULT_FILTERS, engagedMin: 2, has: { has_image: false } }
        expect(dimensionSummary(dim('engagedMin'), state, null)).toBe('Engaged (going or saved) ≥ 2')
        expect(dimensionSummary(dim('has_image'), state, null)).toBe('No image')
        expect(clearDimension(dim('has_image'), state).has).toEqual({})
    })

    it('recognises quick views and custom combinations', () => {
        expect(matchQuickView(DEFAULT_FILTERS)).toBe('all')
        expect(matchQuickView({ ...DEFAULT_FILTERS, has: { has_tags: false } })).toBe('untagged')
        expect(matchQuickView({ ...DEFAULT_FILTERS, status: ['new'], price: ['free'] })).toBeNull()
    })

    it('saves custom presets and matches them', () => {
        const state = { ...DEFAULT_FILTERS, status: ['new' as const], price: ['free' as const] }
        const preset = presetFrom('Free new', state)
        saveCustomPresets([preset])
        const loaded = loadCustomPresets()
        expect(loaded.map((p) => p.label)).toEqual(['Free new'])
        expect(matchQuickView(state, loaded)).toBe(preset.id)
        expect(matchQuickView(DEFAULT_FILTERS, loaded)).toBeNull()
        localStorage.removeItem('admin:events-presets:v1')
    })

    it('cycles header sorting: default direction, reversed, then back to date', () => {
        expect(nextSort('start', 'asc', 'going')).toEqual(['going', 'desc'])
        expect(nextSort('going', 'desc', 'going')).toEqual(['going', 'asc'])
        expect(nextSort('going', 'asc', 'going')).toEqual(['start', 'asc'])
    })
})

describe('table prefs', () => {
    it('drops unknown columns and slots new ones at their default position', () => {
        const defaults = defaultTablePrefs()
        const saved = { order: ['going', 'date', 'bogus'], hidden: ['date'], sizing: { date: 200, title: -1 } }
        const prefs = sanitizeTablePrefs(saved)
        expect(prefs.order).not.toContain('bogus')
        expect(prefs.order.indexOf('going')).toBeLessThan(prefs.order.indexOf('date'))
        // 'saved' follows 'going' by default, so it is slotted right after it.
        expect(prefs.order.indexOf('saved')).toBe(prefs.order.indexOf('going') + 1)
        expect(new Set(prefs.order)).toEqual(new Set(defaults.order))
        expect(prefs.hidden).toContain('date')
        expect(prefs.hidden).toContain('price')
        expect(prefs.sizing).toEqual({ date: 200 })
    })
})
