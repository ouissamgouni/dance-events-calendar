import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SaveEventButton from './SaveEventButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// SaveEventButton drives the SavedEventsContext optimistic-save flow end to
// end: a click issues POST /api/track/event-save and flips local state. We
// assert via the button's accessible name, which toggles between
// "Save event" (not saved) and "Edit saved visibility" (saved).

describe('SaveEventButton (anonymous)', () => {
    it('optimistically marks the event saved on a successful write', async () => {
        const { user } = renderWithProviders(<SaveEventButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: 'Save event' })
        await user.click(button)

        await waitFor(() =>
            expect(
                screen.getByRole('button', { name: 'Edit saved visibility' }),
            ).toBeInTheDocument(),
        )
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
})
