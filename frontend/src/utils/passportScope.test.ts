import { describe, expect, it } from 'vitest'
import { scopePassport } from './passportScope'
import type { PassportMapEvent, PassportMilestone } from '../types'

function ev(overrides: Partial<PassportMapEvent>): PassportMapEvent {
    return {
        event_id: 'e',
        title: 't',
        start: '2026-01-01T20:00:00Z',
        city: null,
        country: null,
        latitude: null,
        longitude: null,
        ...overrides,
    } as PassportMapEvent
}

function milestone(overrides: Partial<PassportMilestone>): PassportMilestone {
    return {
        key: 'k',
        name: 'name',
        description: 'd',
        icon: '🏅',
        category: 'events',
        threshold: 1,
        unit: 'events',
        progress: 1,
        unlocked: true,
        is_new: false,
        unlocked_at: null,
        ...overrides,
    }
}

describe('scopePassport — all time', () => {
    const events = [
        ev({ start: '2024-03-01T20:00:00Z', city: 'Barcelona', country: 'Spain', latitude: 41.4, longitude: 2.1 }),
        ev({ start: '2025-06-01T20:00:00Z', city: 'Barcelona', country: 'Spain', latitude: 41.4, longitude: 2.1 }),
        ev({ start: '2026-02-01T20:00:00Z', city: 'Lisbon', country: 'Portugal', latitude: 38.7, longitude: -9.1 }),
    ]

    it('counts every event, distinct cities and countries', () => {
        const s = scopePassport(events, [], 'all')
        expect(s.totalEvents).toBe(3)
        expect(s.cities).toBe(2)
        expect(s.countries).toBe(2)
    })

    it('picks the most frequent city and collects coordinates', () => {
        const s = scopePassport(events, [], 'all')
        expect(s.topCity).toBe('Barcelona')
        expect(s.coords).toHaveLength(3)
    })

    it('shows the top unlocked milestone per category', () => {
        const milestones = [
            milestone({ key: 'events_10', category: 'events', threshold: 10, name: '10 Events' }),
            milestone({ key: 'events_50', category: 'events', threshold: 50, name: '50 Events' }),
            milestone({ key: 'cities_5', category: 'cities', threshold: 5, name: '5 Cities' }),
            milestone({ key: 'events_100', category: 'events', threshold: 100, name: '100 Events', unlocked: false }),
        ]
        const s = scopePassport(events, milestones, 'all')
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('events_50')
        expect(keys).toContain('cities_5')
        expect(keys).not.toContain('events_10') // superseded by events_50
        expect(keys).not.toContain('events_100') // not unlocked
    })
})

describe('scopePassport — a specific year', () => {
    const events = [
        ev({ start: '2025-11-01T20:00:00Z', city: 'Paris', country: 'France' }),
        ev({ start: '2026-03-01T20:00:00Z', city: 'Berlin', country: 'Germany' }),
        ev({ start: '2026-03-15T20:00:00Z', city: 'Berlin', country: 'Germany' }),
        ev({ start: '2026-04-10T20:00:00Z', city: 'Berlin', country: 'Germany' }),
    ]

    it('only counts events within the year', () => {
        const s = scopePassport(events, [], 2026)
        expect(s.totalEvents).toBe(3)
        expect(s.cities).toBe(1)
        expect(s.countries).toBe(1)
    })

    it('shows milestones unlocked that year', () => {
        const milestones = [
            milestone({ key: 'events_25', unlocked_at: '2026-03-15T20:00:00Z', name: '25 Events' }),
            milestone({ key: 'events_10', unlocked_at: '2024-01-01T20:00:00Z', name: '10 Events' }),
        ]
        const s = scopePassport(events, milestones, 2026)
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('events_25')
        expect(keys).not.toContain('events_10') // unlocked in a prior year
    })

    it('adds computed highlights: busiest month, new places and streak', () => {
        const s = scopePassport(events, [], 2026)
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('busiest_month')
        expect(keys).toContain('new_city') // Berlin is new in 2026 (Paris was 2025)
        expect(keys).toContain('new_country') // Germany is new in 2026
        expect(keys).toContain('in_year_streak') // Mar + Apr consecutive
    })

    it('caps the badge row at four', () => {
        const s = scopePassport(events, [], 2026)
        expect(s.badges.length).toBeLessThanOrEqual(4)
    })
})

describe('scopePassport — edge cases', () => {
    it('returns a null cadence for fewer than two events', () => {
        const s = scopePassport([ev({})], [], 'all')
        expect(s.cadenceDays).toBeNull()
    })

    it('handles an empty year', () => {
        const s = scopePassport([ev({ start: '2024-01-01T20:00:00Z' })], [], 2026)
        expect(s.totalEvents).toBe(0)
        expect(s.badges).toHaveLength(0)
        expect(s.coords).toHaveLength(0)
    })
})
