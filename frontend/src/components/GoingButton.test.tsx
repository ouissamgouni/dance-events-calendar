import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import GoingButton from './GoingButton'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'

function renderGoingButton(eventId: string) {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <GoingButton eventId={eventId} />
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
    })
})
