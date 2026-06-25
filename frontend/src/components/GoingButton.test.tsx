import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import GoingButton from './GoingButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// GoingButton drives the AttendingEventsContext optimistic RSVP flow. The
// trigger's accessible name toggles between "I'm going" (not going) and
// "Not going" (going), so we assert state transitions through that name.

describe('GoingButton (anonymous)', () => {
    it('optimistically marks the user as going on a successful write', async () => {
        const { user } = renderWithProviders(<GoingButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: "I'm going" })
        await user.click(button)

        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Not going' })).toBeInTheDocument(),
        )
    })

    it('rolls back the optimistic RSVP when the write fails', async () => {
        server.use(
            http.post('*/api/track/event-attendance', () =>
                HttpResponse.json({ detail: 'boom' }, { status: 500 }),
            ),
        )

        const { user } = renderWithProviders(<GoingButton eventId="evt-1" />)

        const button = await screen.findByRole('button', { name: "I'm going" })
        await user.click(button)

        await waitFor(() =>
            expect(screen.getByText(/couldn’t mark you as going|couldn't mark you as going/i)).toBeInTheDocument(),
        )
        expect(screen.queryByRole('button', { name: 'Not going' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: "I'm going" })).toBeInTheDocument()
    })
})
