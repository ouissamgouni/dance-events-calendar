import { describe, expect, it } from 'vitest'
import { scopePassport } from './passportScope'
import type { PassportConsistency, PassportMapEvent, PassportMilestone } from '../types'

function consistency(overrides: Partial<PassportConsistency> = {}): PassportConsistency {
    return {
        active: false,
        active_months: 0,
        window: 12,
        earned: [],
        locked: [],
        top: null,
        by_year: [],
        new: [],
        ...overrides,
    }
}

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
        achieved_description: 'ad',
        icon: '🏅',
        category: 'events',
        threshold: 1,
        unit: 'events',
        prestige: 1,
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

    it('keeps only the highest-prestige milestone per category, prestige-ranked', () => {
        const milestones = [
            milestone({ key: 'events_10', category: 'events', threshold: 10, prestige: 20, name: 'Regular' }),
            milestone({ key: 'events_50', category: 'events', threshold: 50, prestige: 65, name: 'Veteran' }),
            milestone({ key: 'cities_5', category: 'cities', threshold: 5, prestige: 35, name: 'Explorer' }),
            milestone({ key: 'events_100', category: 'events', threshold: 100, prestige: 90, name: 'Legend', unlocked: false }),
        ]
        const s = scopePassport(events, milestones, 'all', 'Salsa')
        const keys = s.badges.map((b) => b.key)
        expect(keys).not.toContain('events_100') // not unlocked
        expect(keys).not.toContain('events_10') // overshadowed by events_50 in its category
        expect(keys).toContain('events_50')
        expect(keys).toContain('cities_5')
        // Prestige order among the surviving milestones.
        expect(keys.indexOf('events_50')).toBeLessThan(keys.indexOf('cities_5'))
    })

    it('describes milestone badges with actual totals, not the fixed threshold', () => {
        const milestones = [
            milestone({ key: 'countries_5', category: 'countries', threshold: 5, prestige: 70, name: 'World Dancer' }),
        ]
        // These events span 2 countries; the badge should read "2 countries",
        // never the misleading threshold "Dance in 5 countries".
        const s = scopePassport(events, milestones, 'all')
        const badge = s.badges.find((b) => b.key === 'countries_5')
        expect(badge?.description).toBe('2 countries')
    })

    it('guarantees a top-style slot even when many milestones are unlocked', () => {
        const milestones = [
            milestone({ key: 'events_50', category: 'events', prestige: 65, name: 'Veteran' }),
            milestone({ key: 'cities_10', category: 'cities', prestige: 60, name: 'City Hopper' }),
            milestone({ key: 'countries_5', category: 'countries', prestige: 70, name: 'World Dancer' }),
            milestone({ key: 'reviews_10', category: 'reviews', prestige: 40, name: 'Critic' }),
        ]
        const cons = consistency({
            top: { key: 'consistency_5', name: 'Committed', icon: '🗓️', threshold: 5, times: 1 },
        })
        const s = scopePassport(events, milestones, 'all', 'Salsa', 0, cons)
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('top_style')
        expect(s.badges.length).toBeLessThanOrEqual(6)
    })

    it('flags a consistency badge in the badge row so the card hides the active-months cell', () => {
        const cons = consistency({
            active_months: 5,
            top: { key: 'consistency_5', name: 'Committed', icon: '🗓️', threshold: 5, times: 2 },
        })
        const s = scopePassport(events, [], 'all', null, 0, cons)
        expect(s.consistencyInBadges).toBe(true)
        expect(s.badges[0].key).toBe('consistency_top_consistency_5')
    })

    it('adds cadence and top style highlights on the all-time card', () => {
        const s = scopePassport(events, [], 'all', 'Salsa')
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('cadence')
        expect(keys).toContain('top_style')
        expect(s.topStyle).toBe('Salsa')
        expect(s.consistencyInBadges).toBe(false)
    })

    it('leads with consistency and trails with reviews', () => {
        const milestones = [
            milestone({ key: 'reviews_10', category: 'reviews', prestige: 40, name: 'Critic' }),
            milestone({ key: 'countries_5', category: 'countries', prestige: 70, name: 'World Dancer' }),
        ]
        const cons = consistency({
            top: { key: 'consistency_5', name: 'Committed', icon: '🗓️', threshold: 5, times: 1 },
        })
        const s = scopePassport(events, milestones, 'all', null, 0, cons)
        const keys = s.badges.map((b) => b.key)
        expect(keys[0]).toBe('consistency_top_consistency_5') // consistency leads
        expect(keys.indexOf('reviews_10')).toBe(keys.length - 1) // Critic trails
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

    it('adds computed highlights: busiest month and new places, counting active months', () => {
        const s = scopePassport(events, [], 2026)
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('busiest_month')
        expect(keys).toContain('new_city') // Berlin is new in 2026 (Paris was 2025)
        expect(keys).toContain('new_country') // Germany is new in 2026
        expect(s.activeMonths).toBe(2) // Mar + Apr are the two active months
    })

    it('lists up to three new place names, then an ellipsis when more remain', () => {
        const many = [
            ev({ start: '2026-01-01T20:00:00Z', country: 'France' }),
            ev({ start: '2026-02-01T20:00:00Z', country: 'Spain' }),
            ev({ start: '2026-03-01T20:00:00Z', country: 'Italy' }),
            ev({ start: '2026-04-01T20:00:00Z', country: 'Germany' }),
        ]
        const s = scopePassport(many, [], 2026)
        const badge = s.badges.find((b) => b.key === 'new_country')
        expect(badge?.label).toBe('+4 new countries')
        expect(badge?.description).toBe('France, Spain, Italy, …')
    })

    it('merges the new-countries detail into a countries milestone unlocked that year', () => {
        const milestones = [
            milestone({
                key: 'countries_5',
                category: 'countries',
                threshold: 5,
                prestige: 70,
                name: 'World Dancer',
                unlocked_at: '2026-03-15T20:00:00Z',
            }),
        ]
        const s = scopePassport(events, milestones, 2026)
        const keys = s.badges.map((b) => b.key)
        expect(keys).toContain('countries_5')
        expect(keys).not.toContain('new_country') // absorbed into the milestone
        const badge = s.badges.find((b) => b.key === 'countries_5')
        expect(badge?.description).toBe('Germany') // the new country, not "Unlocked in 2026"
    })

    it('omits top style on the year card', () => {
        const s = scopePassport(events, [], 2026, 'Salsa')
        expect(s.topStyle).toBeNull()
        expect(s.badges.map((b) => b.key)).not.toContain('top_style')
    })

    it('shows the cadence highlight on the year card', () => {
        const s = scopePassport(events, [], 2026)
        expect(s.badges.map((b) => b.key)).toContain('cadence')
    })

    it('tags a non-geographic milestone unlocked that year with "Unlocked"', () => {
        const milestones = [
            milestone({ key: 'events_25', category: 'events', unlocked_at: '2026-03-15T20:00:00Z', name: 'Dedicated' }),
        ]
        const s = scopePassport(events, milestones, 2026)
        const badge = s.badges.find((b) => b.key === 'events_25')
        expect(badge?.tag).toBe('Unlocked')
        expect(badge?.description).toBeUndefined()
    })

    it('caps the badge row at six', () => {
        const s = scopePassport(events, [], 2026)
        expect(s.badges.length).toBeLessThanOrEqual(6)
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
