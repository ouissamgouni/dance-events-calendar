import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'
import type { CalendarEvent } from '../types'
import RailEventCard from './RailEventCard'

vi.mock('./AttendeeAvatarStack', () => ({
    default: ({ size }: { size?: string }) => <span data-testid="attendee-avatar-stack" data-size={size}>Attendees</span>,
}))

const event: CalendarEvent = {
    event_id: 'evt-trending-1',
    calendar_id: 'cal-1',
    title: 'Salsa Social Friday',
    description: null,
    location: 'Paris, France',
    latitude: null,
    longitude: null,
    start: '2026-08-21T20:00:00',
    end: '2026-08-21T23:00:00',
    all_day: false,
    color: null,
    view_count: 42,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: false,
    links: null,
    tags: [],
}

const start = new Date(event.start)
const inlineDate = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
})

describe('RailEventCard', () => {
    it('renders the opt-in date rail with location above attendees', () => {
        render(
            <FeatureFlagsProvider>
                <RailEventCard
                    event={event}
                    onClick={vi.fn()}
                    variant="compact"
                    dateRail
                />
            </FeatureFlagsProvider>,
        )

        const button = screen.getByRole('button', { name: /Open Salsa Social Friday/ })
        const card = button.parentElement
        expect(card).toHaveClass('w-[224px]', 'rounded-r-card')
        expect(card).not.toHaveClass('rounded-card')

        const rail = screen.getByTestId('rail-card-date-rail')
        expect(within(rail).getByText(start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase())).toBeInTheDocument()
        expect(within(rail).getByText(start.toLocaleDateString(undefined, { month: 'short' }).toUpperCase())).toBeInTheDocument()
        expect(within(rail).getByText(String(start.getDate()))).toBeInTheDocument()
        expect(screen.queryByText(inlineDate)).not.toBeInTheDocument()

        const location = screen.getByTestId('rail-card-location')
        const attendees = screen.getByTestId('rail-card-attendees')
        expect(location.compareDocumentPosition(attendees) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(within(attendees).getByTestId('attendee-avatar-stack')).toBeInTheDocument()
        expect(within(attendees).getByTestId('attendee-avatar-stack')).toHaveAttribute('data-size', 'md')
    })

    it('keeps the existing compact layout when the date rail is disabled', () => {
        render(
            <FeatureFlagsProvider>
                <RailEventCard
                    event={event}
                    onClick={vi.fn()}
                    variant="compact"
                />
            </FeatureFlagsProvider>,
        )

        const button = screen.getByRole('button', { name: /Open Salsa Social Friday/ })
        expect(button.parentElement).toHaveClass('w-[208px]', 'rounded-card')
        expect(screen.queryByTestId('rail-card-date-rail')).not.toBeInTheDocument()
        expect(screen.getByText(inlineDate)).toBeInTheDocument()
    })
})
