import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { AuthProvider, useAuth } from './AuthContext'
import ProtectedRoute from '../components/ProtectedRoute'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function AuthProbe() {
    const { user, loading, logout } = useAuth()
    if (loading) return <p>loading</p>
    return (
        <div>
            <p data-testid="who">{user ? user.email : 'anonymous'}</p>
            <button onClick={() => void logout()}>log out</button>
        </div>
    )
}

function renderAuth(ui: React.ReactElement) {
    return {
        user: userEvent.setup(),
        ...render(
            <MemoryRouter>
                <AuthProvider>{ui}</AuthProvider>
            </MemoryRouter>,
        ),
    }
}

describe('AuthContext', () => {
    it('hydrates the current user from /auth/me on mount', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ email: 'me@example.com' }))),
        )

        renderAuth(<AuthProbe />)

        await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('me@example.com'))
    })

    it('clears the user on logout', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ email: 'me@example.com' }))),
        )

        const { user } = renderAuth(<AuthProbe />)
        await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('me@example.com'))

        await user.click(screen.getByRole('button', { name: 'log out' }))

        await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('anonymous'))
    })

    it('leaves the user anonymous when /auth/me is unauthorized', async () => {
        // Default handler already returns 401.
        renderAuth(<AuthProbe />)
        await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('anonymous'))
    })
})

describe('ProtectedRoute', () => {
    it('redirects unauthenticated visitors to /login', async () => {
        render(
            <MemoryRouter initialEntries={['/secret']}>
                <AuthProvider>
                    <Routes>
                        <Route
                            path="/secret"
                            element={
                                <ProtectedRoute>
                                    <p>secret content</p>
                                </ProtectedRoute>
                            }
                        />
                        <Route path="/login" element={<p>login page</p>} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        )

        await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
        expect(screen.queryByText('secret content')).not.toBeInTheDocument()
    })

    it('renders the protected content for an authenticated user', async () => {
        server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser())))

        render(
            <MemoryRouter initialEntries={['/secret']}>
                <AuthProvider>
                    <Routes>
                        <Route
                            path="/secret"
                            element={
                                <ProtectedRoute>
                                    <p>secret content</p>
                                </ProtectedRoute>
                            }
                        />
                        <Route path="/login" element={<p>login page</p>} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        )

        await waitFor(() => expect(screen.getByText('secret content')).toBeInTheDocument())
    })
})
