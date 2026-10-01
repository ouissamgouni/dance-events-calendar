import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import GoingButton from './GoingButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import { defaultFlags, FeatureFlagsContext, FeatureFlagsProvider } from '../context/FeatureFlagsContext'

function useMobileViewport() {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 639px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }))
}

function LocationProbe() {
    const location = useLocation()
    return <div data-testid="location">{location.pathname + location.search}</div>
}

function renderGoingButton(eventId: string) {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <GoingButton eventId={eventId} eventTitle="Summer Salsa Social" />
        </FeatureFlagsProvider>,
    )
}

// GoingButton drives the AttendingEventsContext optimistic RSVP flow. The
// trigger's accessible name toggles between "I'm going" (not going) and
// "Not going" (going), so we assert state transitions through that name.

describe('GoingButton (anonymous)', () => {
    it('optimistically marks the user as going on a successful write', async () => {
        const { user } = renderGoingButton('evt-1')

        const button = await screen.findByRole('button', { name: "I'm going" })
        expect(button).toHaveClass('h-8', 'w-8', 'rounded-lg', 'bg-action-tile')
        expect(button).not.toHaveClass('shadow-sm', 'border')
        expect(button.querySelector('[data-icon-family="hand"][data-icon-state="default"]')).toBeInTheDocument()
        await user.click(button)

        await waitFor(() => {
            const goingButton = screen.getByRole('button', { name: 'Not going' })
            expect(goingButton).toHaveClass('text-action', 'bg-action/10')
            expect(goingButton.querySelector('[data-icon-family="hand"][data-icon-state="going"]')).toHaveAttribute('fill', 'none')
        })
    })

    it('uses the person-plus and person-check states when configured', async () => {
        server.use(
            http.get('*/api/settings', () =>
                HttpResponse.json({ going_button_icon_variant: 'person' }),
            ),
        )

        const { user } = renderGoingButton('evt-person')

        const button = await screen.findByRole('button', { name: "I'm going" })
        await waitFor(() =>
            expect(button.querySelector('[data-icon-family="person"][data-icon-state="default"]')).toBeInTheDocument(),
        )
        await user.click(button)

        await waitFor(() => {
            const goingButton = screen.getByRole('button', { name: 'Not going' })
            expect(goingButton).toHaveClass('text-action', 'bg-action/10')
            expect(goingButton.querySelector('[data-icon-family="person"][data-icon-state="going"]')).toHaveAttribute('fill', 'none')
        })
    })

    it('rolls back the optimistic RSVP when the write fails', async () => {
        server.use(
            http.post('*/api/track/event-attendance', () =>
                HttpResponse.json({ detail: 'boom' }, { status: 500 }),
            ),
        )

        const { user } = renderGoingButton('evt-1')

        const button = await screen.findByRole('button', { name: "I'm going" })
        await user.click(button)

        await waitFor(() =>
            expect(screen.getByText(/couldn’t mark you as going|couldn't mark you as going/i)).toBeInTheDocument(),
        )
        expect(screen.queryByRole('button', { name: 'Not going' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: "I'm going" })).toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: "You're going!" })).not.toBeInTheDocument()
    })

    it('opens the post-RSVP sheet before the write resolves', async () => {
        useMobileViewport()
        let release: () => void = () => { }
        const pending = new Promise<void>((resolve) => { release = resolve })
        server.use(
            http.post('*/api/track/event-attendance', async () => {
                await pending
                return new HttpResponse(null, { status: 204 })
            }),
        )

        const { user } = renderGoingButton('evt-pending')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))

        expect(await screen.findByRole('dialog', { name: "You're going!" })).toBeInTheDocument()
        release()
    })

    it('requires sign-in without writing anonymous state when the app gate is enabled', async () => {
        let writes = 0
        server.use(
            http.post('*/api/track/event-attendance', () => {
                writes += 1
                return new HttpResponse(null, { status: 204 })
            }),
        )
        const { user } = renderWithProviders(
            <FeatureFlagsContext.Provider
                value={{
                    flags: { ...defaultFlags, appAuthGateEnabled: true },
                    updateFlag: vi.fn(),
                    ready: true,
                }}
            >
                <LocationProbe />
                <GoingButton eventId="evt-gated" />
            </FeatureFlagsContext.Provider>,
            { routerEntries: ['/event/evt-gated?src=share#people'] },
        )

        await user.click(await screen.findByRole('button', { name: "I'm going" }))

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent(
                '/login?next=%2Fevent%2Fevt-gated%3Fsrc%3Dshare%23people',
            ),
        )
        expect(writes).toBe(0)
        expect(screen.getByRole('button', { name: "I'm going" })).toBeInTheDocument()
    })

    it('does not write anonymous state before feature flags resolve', async () => {
        let writes = 0
        server.use(
            http.post('*/api/track/event-attendance', () => {
                writes += 1
                return new HttpResponse(null, { status: 204 })
            }),
        )
        const { user } = renderWithProviders(
            <FeatureFlagsContext.Provider
                value={{ flags: defaultFlags, updateFlag: vi.fn(), ready: false }}
            >
                <GoingButton eventId="evt-loading" />
            </FeatureFlagsContext.Provider>,
        )

        await user.click(await screen.findByRole('button', { name: "I'm going" }))

        expect(writes).toBe(0)
        expect(screen.getByRole('button', { name: "I'm going" })).toBeInTheDocument()
    })
})

describe('GoingButton visibility', () => {
    it('uses mobile bottom sheets with horizontal audience pills', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderGoingButton('evt-mobile-visibility')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))

        const confirmationSheet = await screen.findByRole('dialog', { name: "You're going!" })
        expect(confirmationSheet).toHaveAttribute('aria-modal', 'true')
        expect(screen.getByText('Summer Salsa Social')).toHaveClass('line-clamp-2', 'text-sm')
        expect(screen.getByRole('radiogroup', { name: 'Attendance visibility' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')[0]).toHaveClass('min-h-12', 'text-sm')
        expect(within(confirmationSheet).getByRole('button', { name: 'Share event' })).toBeInTheDocument()

        await user.click(within(confirmationSheet).getByRole('button', { name: 'Done' }))
        await user.click(screen.getByRole('button', { name: 'Not going' }))

        const editSheet = screen.getByRole('dialog', { name: "You're going!" })
        expect(editSheet).toHaveAttribute('aria-modal', 'true')
        expect(screen.getByRole('radiogroup', { name: 'Attendance visibility' })).toHaveClass('flex', 'w-full')
        expect(within(editSheet).getByRole('button', { name: 'Not going' })).toHaveClass('text-danger')
        expect(within(editSheet).getByRole('button', { name: 'Done' })).toBeInTheDocument()
        expect(within(editSheet).getByRole('checkbox', { name: 'Remember my choice for next time' })).toBeChecked()
    })

    it('remembers the audience picked in the post-RSVP sheet as last used', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderGoingButton('evt-last-used')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        await screen.findByRole('dialog', { name: "You're going!" })
        await user.click(screen.getByRole('radio', { name: /^Private/ }))

        await waitFor(() =>
            expect(localStorage.getItem('audience.lastUsed.user-1')).toBe('private'),
        )
    })

    it('saves the picked audience as account default when remember is checked', async () => {
        useMobileViewport()
        const patches: unknown[] = []
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.patch('*/api/social/me/visibility', async ({ request }) => {
                patches.push(await request.json())
                return HttpResponse.json({})
            }),
        )
        const { user } = renderGoingButton('evt-remember')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        await screen.findByRole('dialog', { name: "You're going!" })
        expect(screen.getByRole('checkbox', { name: 'Remember my choice for next time' })).toBeChecked()
        await user.click(screen.getByRole('radio', { name: /^Private/ }))
        expect(patches).toEqual([])
        await user.click(screen.getByRole('button', { name: 'Done' }))

        await waitFor(() =>
            expect(patches).toEqual([{ share_attendance_default_audience: 'private' }]),
        )
        expect(localStorage.getItem('audience.remember.user-1')).toBe('1')
    })

    it('does not remember the choice when leaving via Not going', async () => {
        useMobileViewport()
        const patches: unknown[] = []
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.patch('*/api/social/me/visibility', async ({ request }) => {
                patches.push(await request.json())
                return HttpResponse.json({})
            }),
        )
        const { user } = renderGoingButton('evt-not-going')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        const sheet = await screen.findByRole('dialog', { name: "You're going!" })
        await user.click(within(sheet).getByRole('button', { name: 'Done' }))
        localStorage.removeItem('audience.remember.user-1')
        patches.length = 0

        await user.click(screen.getByRole('button', { name: 'Not going' }))
        const editSheet = await screen.findByRole('dialog', { name: "You're going!" })
        await user.click(screen.getByRole('radio', { name: /^Private/ }))
        await user.click(within(editSheet).getByRole('button', { name: 'Not going' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(patches).toEqual([])
        expect(localStorage.getItem('audience.remember.user-1')).toBeNull()
    })

    it('does not save the account default when remember is unchecked', async () => {
        useMobileViewport()
        const patches: unknown[] = []
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.patch('*/api/social/me/visibility', async ({ request }) => {
                patches.push(await request.json())
                return HttpResponse.json({})
            }),
        )
        const { user } = renderGoingButton('evt-no-remember')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        await screen.findByRole('dialog', { name: "You're going!" })
        await user.click(screen.getByRole('checkbox', { name: 'Remember my choice for next time' }))
        await user.click(screen.getByRole('radio', { name: /^Private/ }))

        await waitFor(() =>
            expect(localStorage.getItem('audience.lastUsed.user-1')).toBe('private'),
        )
        expect(patches).toEqual([])
    })

    it('skips the post-RSVP sheet once the choice is remembered but still opens it on edit', async () => {
        useMobileViewport()
        localStorage.setItem('audience.remember.user-1', '1')
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderGoingButton('evt-remembered')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        expect(await screen.findByRole('button', { name: 'Not going' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Not going' }))
        expect(await screen.findByRole('dialog', { name: "You're going!" })).toBeInTheDocument()
    })

    it('hides the remember checkbox when the flag is off', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/settings', () =>
                HttpResponse.json({ rsvp_remember_visibility_enabled: false }),
            ),
        )
        const { user } = renderGoingButton('evt-flag-off')

        await user.click(await screen.findByRole('button', { name: "I'm going" }))
        await screen.findByRole('dialog', { name: "You're going!" })
        await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument())
    })
})
