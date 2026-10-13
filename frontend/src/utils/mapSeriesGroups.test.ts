import { describe, expect, it } from 'vitest'
import { groupSeriesForMap } from './mapSeriesGroups'
import type { CalendarEvent } from '../types'

const NOW = Date.parse('2026-10-13T12:00:00Z')

function event(event_id: string, start: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const end = new Date(Date.parse(start) + 3 * 3600_000).toISOString()
    return { event_id, start, end, latitude: 33.5, longitude: -7.6, ...overrides } as CalendarEvent
}

describe('groupSeriesForMap', () => {
    it('collapses dates of one series at one venue onto the next upcoming date', () => {
        const groups = groupSeriesForMap([
            event('c', '2026-10-25T20:00:00Z', { series_key: 'submission:x' }),
            event('a', '2026-10-11T20:00:00Z', { series_key: 'submission:x' }),
            event('b', '2026-10-18T20:00:00Z', { series_key: 'submission:x' }),
        ], NOW)

        expect(groups).toHaveLength(1)
        expect(groups[0].event.event_id).toBe('b')
        expect(groups[0].members.map((e) => e.event_id)).toEqual(['a', 'b', 'c'])
    })

    it('falls back to the latest date when every date is past', () => {
        const groups = groupSeriesForMap([
            event('a', '2026-09-01T20:00:00Z', { series_key: 'series:1' }),
            event('b', '2026-09-08T20:00:00Z', { series_key: 'series:1' }),
        ], NOW)

        expect(groups[0].event.event_id).toBe('b')
    })

    it('keeps events without a series_key, or at another venue, separate', () => {
        const groups = groupSeriesForMap([
            event('a', '2026-10-18T20:00:00Z'),
            event('b', '2026-10-18T20:00:00Z'),
            event('c', '2026-10-18T20:00:00Z', { series_key: 'series:1' }),
            event('d', '2026-10-25T20:00:00Z', { series_key: 'series:1', latitude: 34.0 }),
        ], NOW)

        expect(groups.map((g) => g.event.event_id)).toEqual(['a', 'b', 'c', 'd'])
    })
})
