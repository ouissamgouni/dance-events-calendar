import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import Login from './Login'
import { AuthProvider } from '../context/AuthContext'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function renderLogin() {
    return {
        user: userEvent.setup(),
        ...render(
            <MemoryRouter initialEntries={['/login']}>
                <AuthProvider>
                    <Routes>
                        <Route path="/login" element={<Login />} />
                        <Route path="/" element={<p>home page</p>} />
                    </Routes>
                </AuthProvider>
            </MemoryRouter>,
        ),
    }
}

describe('Login — email one-time code', () => {
    beforeEach(() => {
        // Google path (no dev auth) so the email-code form renders alongside it.
        server.use(
            http.get('*/api/auth/mode', () =>
                HttpResponse.json({ dev_auth: false, google_client_id: '' }),
            ),
        )
    })

    it('requests a code then verifies it and signs the user in', async () => {
        server.use(
            http.post('*/api/auth/email-code/request', () =>
                HttpResponse.json({ sent: true, expires_in: 600, dev_code: '123456' }),
            ),
            http.post('*/api/auth/email-code/verify', () =>
                HttpResponse.json(makeUser({ is_new_user: true })),
            ),
        )

        const { user } = renderLogin()

        const emailInput = await screen.findByLabelText(/sign in with an email code/i)
        await user.type(emailInput, 'alice@example.com')
        await user.click(screen.getByRole('button', { name: /send code/i }))

        const codeInput = await screen.findByLabelText(/6-digit code/i)
        expect(screen.getByText(/123456/)).toBeInTheDocument()

        await user.type(codeInput, '123456')
        await user.click(screen.getByRole('button', { name: /verify & sign in/i }))

        await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument())
    })

    it('surfaces an error when the request is throttled', async () => {
        server.use(
            http.post('*/api/auth/email-code/request', () =>
                HttpResponse.json(
                    { detail: 'Please wait before requesting another code' },
                    { status: 429 },
                ),
            ),
        )

        const { user } = renderLogin()

        const emailInput = await screen.findByLabelText(/sign in with an email code/i)
        await user.type(emailInput, 'alice@example.com')
        await user.click(screen.getByRole('button', { name: /send code/i }))

        await waitFor(() =>
            expect(
                screen.getByText(/please wait before requesting another code/i),
            ).toBeInTheDocument(),
        )
    })

    it('surfaces an error for an invalid code', async () => {
        server.use(
            http.post('*/api/auth/email-code/request', () =>
                HttpResponse.json({ sent: true, expires_in: 600, dev_code: '123456' }),
            ),
            http.post('*/api/auth/email-code/verify', () =>
                HttpResponse.json({ detail: 'Invalid or expired code' }, { status: 400 }),
            ),
        )

        const { user } = renderLogin()

        const emailInput = await screen.findByLabelText(/sign in with an email code/i)
        await user.type(emailInput, 'alice@example.com')
        await user.click(screen.getByRole('button', { name: /send code/i }))

        const codeInput = await screen.findByLabelText(/6-digit code/i)
        await user.type(codeInput, '000000')
        await user.click(screen.getByRole('button', { name: /verify & sign in/i }))

        await waitFor(() =>
            expect(screen.getByText(/invalid or expired code/i)).toBeInTheDocument(),
        )
    })
})
