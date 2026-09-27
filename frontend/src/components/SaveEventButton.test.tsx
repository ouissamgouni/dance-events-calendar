import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import SaveEventButton from './SaveEventButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { defaultFlags, FeatureFlagsContext } from '../context/FeatureFlagsContext'

function LocationProbe() {
    const location = useLocation()
    return <div data-testid="location">{location.pathname + location.search}</div>
}

// SaveEventButton drives the SavedEventsContext optimistic-save flow end to
// end: a click issues POST /api/track/event-save and flips local state. We
// assert via the button's accessible name, which toggles between
// "Save event" (not saved) and "Edit saved visibility" (saved).

describe('SaveEventButton (anonymous)', () => {
    it('optimistically marks the event saved on a successful write', async () => {
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: 'Save event' })
        expect(button).toHaveClass('h-8', 'w-8', 'rounded-lg', 'bg-action-tile')
        expect(button).not.toHaveClass('shadow-sm', 'border')
        expect(button.querySelector('[data-icon-family="bookmark"][data-icon-state="default"]')).toHaveAttribute('fill', 'none')
        await user.click(button)

        await waitFor(() => {
            const savedButton = screen.getByRole('button', { name: 'Edit saved visibility' })
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
            screen.queryByRole('button', { name: 'Edit saved visibility' }),
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
