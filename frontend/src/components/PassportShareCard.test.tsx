import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PassportShareCard from './PassportShareCard'
import type { ScopedPassport } from '../utils/passportScope'

const scoped: ScopedPassport = {
    scope: 'all',
    totalEvents: 13,
    cities: 11,
    countries: 7,
    cadenceDays: 9,
    monthStreak: 4,
    topStyle: 'Salsa',
    topCity: 'Barcelona',
    coords: [
        { lat: 41.4, lng: 2.1 },
        { lat: 38.7, lng: -9.1 },
    ],
    badges: [{ key: 'events_50', icon: '🏆', label: 'Veteran', description: 'Attend 50 events' }],
    streakInBadges: false,
}

describe('PassportShareCard', () => {
    it('renders the dancer name, scoped stats and badges on the all-time card', () => {
        render(
            <PassportShareCard
                displayName="Alba"
                handle="alba"
                scoped={scoped}
                memberSince="2024-03-01T00:00:00"
                profileUrl="https://joinmovida.com/u/alba"
            />,
        )
        expect(screen.getByText('Alba')).toBeInTheDocument()
        expect(screen.getByText('13')).toBeInTheDocument()
        expect(screen.getByText('Veteran')).toBeInTheDocument()
        expect(screen.getByText('Attend 50 events')).toBeInTheDocument()
        expect(screen.getByText(/Journey on Movida since/)).toBeInTheDocument()
        // Streak cell renders when the month streak is meaningful (>= 2).
        expect(screen.getByText('🔥 Streak')).toBeInTheDocument()
        // QR footer shows the pretty profile handle, never the old @handle form.
        expect(screen.getByText('joinmovida.com/u/alba')).toBeInTheDocument()
    })

    it('renders a badge tag to the right of the label', () => {
        const tagged: ScopedPassport = {
            ...scoped,
            badges: [{ key: 'events_25', icon: '🔥', label: 'Dedicated', tag: 'Unlocked' }],
        }
        render(
            <PassportShareCard
                displayName="Alba"
                handle="alba"
                scoped={tagged}
                memberSince="2024-03-01T00:00:00"
                profileUrl="https://joinmovida.com/u/alba"
            />,
        )
        expect(screen.getByText('Dedicated')).toBeInTheDocument()
        expect(screen.getByText('Unlocked')).toBeInTheDocument()
    })

    it('hides the "Dancing since" line unless enabled', () => {
        const { rerender } = render(
            <PassportShareCard
                displayName="Alba"
                handle="alba"
                scoped={scoped}
                memberSince="2024-03-01T00:00:00"
                dancingSince="2018-03-15"
                profileUrl="https://joinmovida.com/u/alba"
            />,
        )
        expect(screen.queryByText(/Dancing since/)).not.toBeInTheDocument()

        rerender(
            <PassportShareCard
                displayName="Alba"
                handle="alba"
                scoped={scoped}
                memberSince="2024-03-01T00:00:00"
                dancingSince="2018-03-15"
                profileUrl="https://joinmovida.com/u/alba"
                showDancingSince
            />,
        )
        expect(screen.getByText('Dancing since 2018')).toBeInTheDocument()
    })

    it('shows the year headline and omits top style on the year card', () => {
        const year: ScopedPassport = {
            scope: 2026,
            totalEvents: 7,
            cities: 4,
            countries: 3,
            cadenceDays: 20,
            monthStreak: 3,
            topStyle: null,
            topCity: 'Paris',
            coords: [
                { lat: 48.8, lng: 2.3 },
                { lat: 41.4, lng: 2.1 },
            ],
            badges: [
                { key: 'busiest_month', icon: '📅', label: 'Most active · August', description: '7 events' },
            ],
            streakInBadges: false,
        }
        render(
            <PassportShareCard
                displayName="Yara"
                handle="yara"
                scoped={year}
                memberSince="2024-03-01T00:00:00"
                profileUrl="https://joinmovida.com/u/yara"
            />,
        )
        expect(screen.getByText('My 2026 in Dance')).toBeInTheDocument()
        expect(screen.queryByText(/Journey on Movida since/)).not.toBeInTheDocument()
        // Year card spells the streak out and drops the fire icon.
        expect(screen.getByText('months in a row')).toBeInTheDocument()
        expect(screen.queryByText('🔥 Streak')).not.toBeInTheDocument()
    })

    it('shows a year subtitle and an empty state for a year with no events', () => {
        const empty: ScopedPassport = {
            scope: 2026,
            totalEvents: 0,
            cities: 0,
            countries: 0,
            cadenceDays: null,
            monthStreak: 0,
            topStyle: null,
            topCity: null,
            coords: [],
            badges: [],
            streakInBadges: false,
        }
        render(
            <PassportShareCard
                displayName="Alba"
                handle={null}
                scoped={empty}
                memberSince="2024-03-01T00:00:00"
                profileUrl="https://joinmovida.com/u/alba"
            />,
        )
        expect(screen.getByText('No events yet in 2026')).toBeInTheDocument()
        expect(screen.getByText('Just getting started')).toBeInTheDocument()
    })
})
