import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SuggestEventModal from './SuggestEventModal'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// Covers the event-submission flow: client-side validation guards and a
// successful POST /api/suggestions that swaps the form for the thank-you
// confirmation.

function fillDateRange() {
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
    expect(dateInputs.length).toBeGreaterThanOrEqual(2)
    fireEvent.change(dateInputs[0], { target: { value: '2026-07-01T20:00' } })
    fireEvent.change(dateInputs[1], { target: { value: '2026-07-01T23:00' } })
}

describe('SuggestEventModal', () => {
    it('blocks submission and shows an error when the title is empty', async () => {
        const { user } = renderWithProviders(<SuggestEventModal onClose={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: 'Submit' }))

        expect(await screen.findByText('Title is required')).toBeInTheDocument()
    })

    it('rejects an end date earlier than the start date', async () => {
        const { user } = renderWithProviders(<SuggestEventModal onClose={vi.fn()} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
        fireEvent.change(dateInputs[0], { target: { value: '2026-07-01T23:00' } })
        fireEvent.change(dateInputs[1], { target: { value: '2026-07-01T20:00' } })

        await user.click(screen.getByRole('button', { name: 'Submit' }))

        expect(await screen.findByText('End must be after start')).toBeInTheDocument()
    })

    it('submits a valid event and shows the confirmation', async () => {
        const { user } = renderWithProviders(<SuggestEventModal onClose={vi.fn()} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        fillDateRange()

        await user.click(screen.getByRole('button', { name: 'Submit' }))

        expect(await screen.findByText('Thank you!')).toBeInTheDocument()
    })

    it('surfaces the server error message when submission fails', async () => {
        server.use(
            http.post('*/api/suggestions', () =>
                HttpResponse.json({ detail: 'Event already exists' }, { status: 409 }),
            ),
        )

        const { user } = renderWithProviders(<SuggestEventModal onClose={vi.fn()} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        fillDateRange()

        await user.click(screen.getByRole('button', { name: 'Submit' }))

        expect(await screen.findByText('Event already exists')).toBeInTheDocument()
        expect(screen.queryByText('Thank you!')).not.toBeInTheDocument()
    })
})
