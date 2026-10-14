import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { SignInSheetProvider, useSignIn } from './SignInSheetContext'
import { ToastProvider } from '../components/Toast'
import { clearPendingAuth, readPendingAuth } from '../components/auth/pendingAuth'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function SaveTrigger() {
    const openSignIn = useSignIn()
    return (
        <button
            type="button"
            onClick={() => openSignIn('save', { action: { kind: 'save', eventId: 'evt-1', eventTitle: 'Summer Salsa Social' } })}
        >
            Save event
        </button>
    )
}

function renderSheet() {
    return renderWithProviders(
        <ToastProvider>
            <SignInSheetProvider>
                <SaveTrigger />
            </SignInSheetProvider>
        </ToastProvider>,
        { routerEntries: ['/browse?tag=salsa'] },
    )
}

describe('SignInSheetProvider', () => {
    let saveBodies: Array<Record<string, unknown>>

    beforeEach(() => {
        saveBodies = []
        server.use(
            http.get('*/api/auth/mode', () => HttpResponse.json({ dev_auth: false, google_client_id: '' })),
            http.post('*/api/track/event-save', async ({ request }) => {
                saveBodies.push((await request.json()) as Record<string, unknown>)
                return new HttpResponse(null, { status: 204 })
            }),
        )
    })

    afterEach(() => clearPendingAuth())

    it('shows the save copy and dismisses without side effects, restoring focus', async () => {
        const { user } = renderSheet()
        const trigger = screen.getByRole('button', { name: 'Save event' })
        await user.click(trigger)

        const dialog = await screen.findByRole('dialog', { name: 'Keep it in your plans.' })
        expect(dialog).toHaveTextContent('Sign in to save this event and find it later.')
        expect(dialog).not.toHaveTextContent('Plan together')
        expect(readPendingAuth()?.action).toEqual({ kind: 'save', eventId: 'evt-1', eventTitle: 'Summer Salsa Social' })

        await user.keyboard('{Escape}')

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await waitFor(() => expect(trigger).toHaveFocus())
        expect(readPendingAuth()).toBeNull()
        expect(saveBodies).toHaveLength(0)
    })

    it('completes the requested save once after an email-code sign-in', async () => {
        server.use(
            http.post('*/api/auth/email-code/request', () =>
                HttpResponse.json({ sent: true, expires_in: 600, dev_code: '123456' }),
            ),
            http.post('*/api/auth/email-code/verify', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderSheet()
        await user.click(screen.getByRole('button', { name: 'Save event' }))
        await screen.findByRole('dialog', { name: 'Keep it in your plans.' })

        await user.click(await screen.findByRole('button', { name: /continue with email/i }))
        await user.type(screen.getByLabelText(/email address/i), 'alice@example.com')
        await user.click(screen.getByRole('button', { name: /email me a code/i }))
        await user.type(await screen.findByLabelText(/6-digit code/i), '123456')

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(await screen.findByText('Saved to your plans')).toBeInTheDocument()
        expect(saveBodies).toHaveLength(1)
        expect(saveBodies[0]).toMatchObject({ event_id: 'evt-1', action: 'save' })
        expect(readPendingAuth()?.action).toBeUndefined()
    })

    it('flags an invalid email inline without sending a code', async () => {
        let requests = 0
        server.use(
            http.post('*/api/auth/email-code/request', () => {
                requests += 1
                return HttpResponse.json({ sent: true })
            }),
        )
        const { user } = renderSheet()
        await user.click(screen.getByRole('button', { name: 'Save event' }))
        await user.click(await screen.findByRole('button', { name: /continue with email/i }))
        await user.type(screen.getByLabelText(/email address/i), 'not-an-email')
        await user.click(screen.getByRole('button', { name: /email me a code/i }))

        expect(await screen.findByRole('alert')).toHaveTextContent(/valid email address/i)
        expect(screen.getByLabelText(/email address/i)).toHaveAttribute('aria-invalid', 'true')
        expect(requests).toBe(0)
    })
})
