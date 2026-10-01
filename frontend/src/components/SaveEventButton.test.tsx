import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import SaveEventButton from './SaveEventButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext'

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

// SaveEventButton drives the SavedEventsContext optimistic-save flow end to
// end: a click issues POST /api/track/event-save and flips local state. We
// assert via the button's accessible name, which toggles between
// "Save event" (not saved) and "Unsave event" (saved).

describe('SaveEventButton (anonymous)', () => {
    it('optimistically marks the event saved on a successful write', async () => {
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: 'Save event' })
        expect(button).toHaveClass('h-8', 'w-8', 'rounded-lg', 'bg-action-tile')
        expect(button).not.toHaveClass('shadow-sm', 'border')
        expect(button.querySelector('[data-icon-family="bookmark"][data-icon-state="default"]')).toHaveAttribute('fill', 'none')
        await user.click(button)

        await waitFor(() => {
            const savedButton = screen.getByRole('button', { name: 'Unsave event' })
            expect(savedButton).toHaveClass('text-saved', 'bg-action-tile')
            expect(savedButton.querySelector('[data-icon-family="bookmark"][data-icon-state="saved"]')).toHaveAttribute('fill', 'currentColor')
        })
    })

    it('rolls back the optimistic save when the write fails', async () => {
        server.use(
            http.post('*/api/track/event-save', () =>
                HttpResponse.json({ detail: 'boom' }, { status: 500 }),
            ),
        )

        const { user } = renderWithProviders(<SaveEventButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: 'Save event' })
        await user.click(button)

        // The failed write surfaces an inline error toast and the saved state is
        // rolled back, so the button never advertises the event as saved.
        await waitFor(() =>
            expect(screen.getByText(/couldn’t save|couldn't save/i)).toBeInTheDocument(),
        )
        expect(
            screen.queryByRole('button', { name: 'Unsave event' }),
        ).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Save event' })).toBeInTheDocument()
    })

    it('requires sign-in without writing anonymous state when the app gate is enabled', async () => {
        let writes = 0
        server.use(
            http.post('*/api/track/event-save', () => {
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
                <SaveEventButton eventId="evt-gated" />
            </FeatureFlagsContext.Provider>,
            { routerEntries: ['/event/evt-gated?src=share#people'] },
        )

        await user.click(await screen.findByRole('button', { name: 'Save event' }))

        await waitFor(() =>
            expect(screen.getByTestId('location')).toHaveTextContent(
                '/login?next=%2Fevent%2Fevt-gated%3Fsrc%3Dshare%23people',
            ),
        )
        expect(writes).toBe(0)
        expect(screen.getByRole('button', { name: 'Save event' })).toBeInTheDocument()
    })

    it('does not write anonymous state before feature flags resolve', async () => {
        let writes = 0
        server.use(
            http.post('*/api/track/event-save', () => {
                writes += 1
                return new HttpResponse(null, { status: 204 })
            }),
        )
        const { user } = renderWithProviders(
            <FeatureFlagsContext.Provider
                value={{ flags: defaultFlags, updateFlag: vi.fn(), ready: false }}
            >
                <SaveEventButton eventId="evt-loading" />
            </FeatureFlagsContext.Provider>,
        )

        await user.click(await screen.findByRole('button', { name: 'Save event' }))

        expect(writes).toBe(0)
        expect(screen.getByRole('button', { name: 'Save event' })).toBeInTheDocument()
    })
})

describe('SaveEventButton visibility', () => {
    it('uses a mobile bottom sheet with horizontal audience pills', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-mobile-visibility" eventTitle="Summer Salsa Social" />)

        await user.click(await screen.findByRole('button', { name: 'Save event' }))

        const sheet = await screen.findByRole('dialog', { name: 'Saved!' })
        expect(sheet).toHaveAttribute('aria-modal', 'true')
        expect(screen.getByText('Summer Salsa Social')).toHaveClass('line-clamp-2', 'text-sm')
        expect(screen.getByRole('radiogroup', { name: 'Saved event visibility' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')).toHaveLength(3)
        expect(screen.getAllByRole('radio')[0]).toHaveClass('min-h-12', 'text-sm')
        expect(within(sheet).getByRole('button', { name: 'Unsave' })).toHaveClass('text-danger')
        expect(within(sheet).getByRole('button', { name: 'Done' })).toBeInTheDocument()
    })

    it('opens the visibility sheet with an Unsave action when the event is already saved', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-unsave" eventTitle="Summer Salsa Social" />)

        await user.click(await screen.findByRole('button', { name: 'Save event' }))
        const sheet = await screen.findByRole('dialog', { name: 'Saved!' })
        await user.click(within(sheet).getByRole('button', { name: 'Done' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Unsave event' }))
        const editSheet = await screen.findByRole('dialog', { name: 'Saved!' })
        await user.click(within(editSheet).getByRole('button', { name: 'Unsave' }))

        expect(await screen.findByRole('button', { name: 'Save event' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('skips the sheet on a new save once the choice is remembered', async () => {
        useMobileViewport()
        localStorage.setItem('audience.remember.user-1', '1')
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        )
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-remembered" eventTitle="Summer Salsa Social" />)

        await user.click(await screen.findByRole('button', { name: 'Save event' }))
        expect(await screen.findByRole('button', { name: 'Unsave event' })).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Unsave event' }))
        await screen.findByRole('dialog', { name: 'Saved!' })
        expect(screen.getByRole('radio', { name: /^Friends/ })).toHaveAttribute('aria-checked', 'true')
    })

    it('defaults to public audience for users without a saved preference', async () => {
        useMobileViewport()
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(makeUser({ share_attendance_default_audience: undefined })),
            ),
        )
        const { user } = renderWithProviders(
            <SaveEventButton eventId="evt-default-public" eventTitle="Summer Salsa Social" />,
        )

        await user.click(await screen.findByRole('button', { name: 'Save event' }))

        await screen.findByRole('dialog', { name: 'Saved!' })
        const radios = screen.getAllByRole('radio')
        expect(radios[0]).toBeChecked()
        expect(screen.getByText('Anyone who can view your profile will see this in your saved list.')).toBeInTheDocument()
    })

    it('uses the last-used audience when there is no account default and remembers changes', async () => {
        useMobileViewport()
        localStorage.setItem('audience.lastUsed.user-1', 'friends')
        server.use(
            http.get('*/api/auth/me', () =>
                HttpResponse.json(makeUser({ share_attendance_default_audience: undefined })),
            ),
        )
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-last-used" eventTitle="Summer Salsa Social" />)

        await user.click(await screen.findByRole('button', { name: 'Save event' }))
        await screen.findByRole('dialog', { name: 'Saved!' })
        expect(screen.getByRole('radio', { name: /^Friends/ })).toHaveAttribute('aria-checked', 'true')

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
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-remember" eventTitle="Summer Salsa Social" />)

        await user.click(await screen.findByRole('button', { name: 'Save event' }))
        await screen.findByRole('dialog', { name: 'Saved!' })
        expect(screen.getByRole('checkbox', { name: 'Remember my choice for next time' })).toBeChecked()
        await user.click(screen.getByRole('radio', { name: /^Private/ }))
        await user.click(screen.getByRole('button', { name: 'Done' }))

        await waitFor(() =>
            expect(patches).toEqual([{ share_attendance_default_audience: 'private' }]),
        )
    })
})
