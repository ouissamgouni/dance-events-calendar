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
    topCity: 'Barcelona',
    coords: [
        { lat: 41.4, lng: 2.1 },
        { lat: 38.7, lng: -9.1 },
    ],
    badges: [{ key: 'events_50', icon: '🏆', label: '50 Events' }],
}

describe('PassportShareCard', () => {
    it('renders the dancer name, scoped stats and badges on the all-time card', () => {
        render(
            <PassportShareCard
                displayName="Alba"
                handle="alba"
                scoped={scoped}
                memberSince="2024-03-01T00:00:00"
                shareUrl="https://joinmovida.com/shared/passport/tok"
            />,
        )
        expect(screen.getByText('Alba')).toBeInTheDocument()
        expect(screen.getByText('13')).toBeInTheDocument()
        expect(screen.getByText('50 Events')).toBeInTheDocument()
        expect(screen.getByText(/Dancer since/)).toBeInTheDocument()
        expect(screen.getByText(/Most active in/)).toHaveTextContent('Barcelona')
    })

    it('shows a year subtitle and an empty state for a year with no events', () => {
        const empty: ScopedPassport = {
            scope: 2026,
            totalEvents: 0,
            cities: 0,
            countries: 0,
            cadenceDays: null,
            topCity: null,
            coords: [],
            badges: [],
        }
        render(
            <PassportShareCard
                displayName="Alba"
                handle={null}
                scoped={empty}
                memberSince="2024-03-01T00:00:00"
                shareUrl="https://joinmovida.com/shared/passport/tok"
            />,
        )
        expect(screen.getByText('No events yet in 2026')).toBeInTheDocument()
        expect(screen.getByText('Just getting started')).toBeInTheDocument()
    })
})
