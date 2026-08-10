import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import SharedPassportPage from './SharedPassportPage'
import { AuthProvider } from '../context/AuthContext'
import { server } from '../test/server'

const PUBLIC_PASSPORT = {
    display_name: 'Alba',
    stats: {
        total_events_attended: 12,
        cities_visited: 3,
        countries_visited: 2,
        reviews_written: 5,
        styles_danced: 2,
        top_style: null,
        active_months_last_12: 3,
        active_months_this_year: 2,
        events_last_30_days: 1,
        avg_gap_days: 14,
        first_event_date: '2023-06-01T00:00:00',
        member_since: '2023-06-01T00:00:00',
        dancing_since: null,
    },
    collections: { cities: [], countries: [] },
    milestones: [
        {
            key: 'first_event',
            name: 'First Steps',
            description: 'Attend your first event',
            achieved_description: 'Attended your first event',
            icon: '🎉',
            category: 'events',
            threshold: 1,
            unit: 'events',
            progress: 1,
            unlocked: true,
            is_new: false,
            unlocked_at: '2023-06-01T00:00:00',
            prestige: 1,
        },
    ],
    consistency: null,
    events: [],
    sections: ['milestones', 'cities', 'countries'],
    timeline_items: [],
    timeline_markers: [],
    handle: 'alba',
    is_self: false,
    is_following: false,
}

function renderShared(token = 'tok-abc') {
    return render(
        <MemoryRouter initialEntries={[`/shared/passport/${token}`]}>
            <AuthProvider>
                <Routes>
                    <Route path="/shared/passport/:token" element={<SharedPassportPage />} />
                    <Route path="/login" element={<p>login page</p>} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    )
}

describe('SharedPassportPage', () => {
    it('renders the shared passport with stats and milestones', async () => {
        server.use(
            http.get('*/api/passport/shared/tok-abc', () =>
                HttpResponse.json(PUBLIC_PASSPORT),
            ),
        )

        renderShared()

        expect(await screen.findByText(/12 events · 3 cities · 2 countries/)).toBeInTheDocument()
        expect(screen.getByText(/Alba.*Dance Passport/)).toBeInTheDocument()
        expect(screen.getByText('First Steps')).toBeInTheDocument()
        expect(screen.getByText(/1\/1 unlocked/)).toBeInTheDocument()
    })

    it('shows a graceful message for an unknown token', async () => {
        server.use(
            http.get('*/api/passport/shared/*', () => new HttpResponse(null, { status: 404 })),
        )

        renderShared('missing')

        await waitFor(() =>
            expect(
                screen.getByText(/This passport link is no longer available/),
            ).toBeInTheDocument(),
        )
    })

    it('prompts anonymous viewers to sign in when the link requires it', async () => {
        server.use(
            http.get('*/api/passport/shared/*', () => new HttpResponse(null, { status: 401 })),
        )

        renderShared('gated')

        await waitFor(() =>
            expect(
                screen.getByText(/shared with signed-in dancers only/i),
            ).toBeInTheDocument(),
        )
        expect(screen.getByRole('link', { name: /sign in to view/i })).toBeInTheDocument()
    })

    it('offers a sign-in-to-follow CTA for anonymous viewers', async () => {
        server.use(
            http.get('*/api/passport/shared/tok-abc', () =>
                HttpResponse.json(PUBLIC_PASSPORT),
            ),
        )

        renderShared()

        await waitFor(() =>
            expect(screen.getByRole('link', { name: /sign in to follow/i })).toBeInTheDocument(),
        )
    })
})
