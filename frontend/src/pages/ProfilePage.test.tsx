import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import ProfilePage from './ProfilePage'
import { AuthProvider } from '../context/AuthContext'
import { server } from '../test/server'
import { makeProfile, makeUser } from '../test/handlers'

// Covers the follow flow on a public profile: an authenticated viewer
// follows a public account and the CTA transitions Follow → Following via
// POST /api/social/users/:handle/follow.

function renderProfile(handle = 'testorg') {
    return {
        user: userEvent.setup(),
        ...render(
            <MemoryRouter initialEntries={[`/u/${handle}`]}>
                <AuthProvider>
                    <Routes>
                        <Route path="/u/:handle" element={<ProfilePage />} />
                        <Route path="/login" element={<p>login page</p>} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        ),
    }
}

describe('ProfilePage follow flow', () => {
    it('lets an authenticated viewer follow a public profile', async () => {
        server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser())))

        const { user } = renderProfile()

        const followBtn = await screen.findByRole('button', { name: 'Follow' })
        await user.click(followBtn)

        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Following' })).toBeInTheDocument(),
        )
    })

    it('unfollows a profile the viewer already follows', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/social/users/:handle', ({ params }) =>
                HttpResponse.json(
                    makeProfile({ handle: String(params.handle), is_following: true, is_subscribed: true }),
                ),
            ),
        )

        const { user } = renderProfile()

        const followingBtn = await screen.findByRole('button', { name: 'Following' })
        await user.click(followingBtn)

        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument(),
        )
    })

    it('redirects an anonymous viewer to sign in when following', async () => {
        // Default /auth/me is 401 (anonymous).
        const { user } = renderProfile()

        const followBtn = await screen.findByRole('button', { name: /follow/i })
        await user.click(followBtn)

        await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
    })
})

describe('ProfilePage Dance Passport tab', () => {
    const passportBody = {
        display_name: 'Test Org',
        stats: {
            total_events_attended: 7,
            cities_visited: 2,
            countries_visited: 1,
            reviews_written: 0,
            styles_danced: 1,
            top_style: null,
            active_months_last_12: 1,
            active_months_this_year: 1,
            events_last_30_days: 0,
            avg_gap_days: null,
            first_event_date: '2024-01-01T00:00:00',
            member_since: '2024-01-01T00:00:00',
            dancing_since: null,
        },
        collections: { cities: [], countries: [] },
        milestones: [],
        consistency: null,
        events: [],
        sections: ['milestones', 'cities', 'countries'],
        timeline_items: [],
        timeline_markers: [],
        handle: 'testorg',
        is_self: false,
        is_following: false,
    }

    it('shows the Dance Passport as the first tab when viewable', async () => {
        server.use(
            http.get('*/api/social/users/:handle', ({ params }) =>
                HttpResponse.json(
                    makeProfile({
                        handle: String(params.handle),
                        can_view_passport: true,
                        passport_visibility: 'public',
                    }),
                ),
            ),
            http.get('*/api/social/users/:handle/passport', () =>
                HttpResponse.json(passportBody),
            ),
        )

        renderProfile()

        // Passport is the default (first) tab, so its stats render immediately.
        await waitFor(() =>
            expect(screen.getByText('7')).toBeInTheDocument(),
        )
    })

    it('shows a placeholder on the passport tab when not viewable', async () => {
        server.use(
            http.get('*/api/social/users/:handle', ({ params }) =>
                HttpResponse.json(
                    makeProfile({
                        handle: String(params.handle),
                        can_view_passport: false,
                        passport_visibility: 'private',
                    }),
                ),
            ),
        )

        renderProfile()

        // Tab is always present now; content shows a visibility-aware message.
        await screen.findByRole('button', { name: 'Dance Passport' })
        expect(
            screen.getByText(/keeps their Dance Passport private/i),
        ).toBeInTheDocument()
    })

    it('shows a friends-only placeholder on the passport tab', async () => {
        server.use(
            http.get('*/api/social/users/:handle', ({ params }) =>
                HttpResponse.json(
                    makeProfile({
                        handle: String(params.handle),
                        can_view_passport: false,
                        passport_visibility: 'friends',
                    }),
                ),
            ),
        )

        renderProfile()

        await screen.findByRole('button', { name: 'Dance Passport' })
        expect(
            screen.getByText(/shares their Dance Passport with friends only/i),
        ).toBeInTheDocument()
    })
})
