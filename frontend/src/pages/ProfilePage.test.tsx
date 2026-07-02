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
