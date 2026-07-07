/**
 * OnboardingGate — redirect-once behavior when the server flags the
 * user as needing (or re-needing) onboarding.
 */
import { describe, expect, it } from 'vitest'
import { render, waitFor, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import OnboardingGate from './OnboardingGate'
import { AuthProvider } from '../context/AuthContext'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function LocationProbe() {
    const location = useLocation()
    return <div data-testid="loc">{location.pathname + location.search}</div>
}

function renderGate(initialPath = '/') {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <AuthProvider>
                <OnboardingGate />
                <Routes>
                    <Route path="*" element={<LocationProbe />} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    )
}

describe('OnboardingGate', () => {
    it('leaves already-onboarded users on the current page', async () => {
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(makeUser({ needs_onboarding: false })),
            ),
        )
        renderGate('/explorer')
        // Wait long enough for the effect to fire had it wanted to redirect.
        await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/explorer'))
    })

    it('redirects users flagged with needs_onboarding=true', async () => {
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(makeUser({ needs_onboarding: true, onboarded_at: null })),
            ),
        )
        renderGate('/explorer')
        await waitFor(() =>
            expect(screen.getByTestId('loc')).toHaveTextContent(
                '/onboarding/preferences?next=%2Fexplorer',
            ),
        )
    })

    it('redirects re-onboarding users even if onboarded_at is set', async () => {
        // Server bumped the wizard version; the user has an older
        // ``onboarded_at`` but ``needs_onboarding`` is true again.
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(
                    makeUser({
                        needs_onboarding: true,
                        onboarded_at: '2024-01-01T00:00:00Z',
                    }),
                ),
            ),
        )
        renderGate('/for-you')
        await waitFor(() =>
            expect(screen.getByTestId('loc')).toHaveTextContent(
                '/onboarding/preferences?next=%2Ffor-you',
            ),
        )
    })

    it('does not redirect anonymous users', async () => {
        server.use(
            http.get('*/api/auth/me', () => new HttpResponse(null, { status: 401 })),
        )
        renderGate('/explorer')
        await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/explorer'))
    })

    it('does not redirect when already on /onboarding', async () => {
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(makeUser({ needs_onboarding: true, onboarded_at: null })),
            ),
        )
        renderGate('/onboarding/preferences')
        await waitFor(() =>
            expect(screen.getByTestId('loc')).toHaveTextContent('/onboarding/preferences'),
        )
    })
})
