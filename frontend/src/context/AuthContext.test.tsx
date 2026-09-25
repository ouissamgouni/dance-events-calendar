import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
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
    const LoginLocation = () => {
        const location = useLocation()
        return <p>login page {location.search}</p>
    }

    it('redirects unauthenticated visitors to /login', async () => {
        render(
            <MemoryRouter initialEntries={['/secret?tab=one#details']}>
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
                        <Route path="/login" element={<LoginLocation />} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        )

        await waitFor(() => expect(screen.getByText('login page', { exact: false })).toBeInTheDocument())
        expect(screen.getByText(/next=%2Fsecret%3Ftab%3Done%23details/)).toBeInTheDocument()
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

    it.each([false, undefined])('redirects a non-admin user home when admin access is required', async (isAdmin) => {
        server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ is_admin: isAdmin }))))

        render(
            <MemoryRouter initialEntries={['/admin']}>
                <AuthProvider>
                    <Routes>
                        <Route
                            path="/admin"
                            element={
                                <ProtectedRoute requireAdmin>
                                    <p>admin content</p>
                                </ProtectedRoute>
                            }
                        />
                        <Route path="/" element={<p>home page</p>} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        )

        await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument())
        expect(screen.queryByText('admin content')).not.toBeInTheDocument()
    })

    it('renders admin content for an admin user', async () => {
        server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ is_admin: true }))))

        render(
            <MemoryRouter initialEntries={['/admin']}>
                <AuthProvider>
                    <Routes>
                        <Route
                            path="/admin"
                            element={
                                <ProtectedRoute requireAdmin>
                                    <p>admin content</p>
                                </ProtectedRoute>
                            }
                        />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        )

        await waitFor(() => expect(screen.getByText('admin content')).toBeInTheDocument())
    })
})
