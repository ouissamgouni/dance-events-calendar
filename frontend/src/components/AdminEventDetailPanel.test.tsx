import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AdminEventDetailPanel from './AdminEventDetailPanel'
import { ToastProvider } from './Toast'
import * as api from '../api'
import type { CalendarEvent } from '../types'

vi.mock('../api', () => ({
    addEventsToSeries: vi.fn(),
    blockEvent: vi.fn(),
    dismissDuplicateGroup: vi.fn(),
    fetchAdminEvent: vi.fn(),
    fetchEventDuplicateCandidates: vi.fn(),
    fetchEventSeriesCandidates: vi.fn(),
    fetchSeriesGroups: vi.fn(),
    keepDuplicateEvent: vi.fn(),
    splitSeriesMember: vi.fn(),
    unblockEvent: vi.fn(),
    updateEvent: vi.fn(),
}))

vi.mock('../hooks/useAdminCounters', () => ({
    notifyAdminDataChanged: vi.fn(),
}))

vi.mock('./AdminEventDetailContent', () => ({ default: () => <div /> }))
vi.mock('./EventImageEditor', () => ({ default: () => <div /> }))
vi.mock('./EventReviewsSection', () => ({ default: () => <div /> }))
vi.mock('./EventMessagesSection', () => ({ default: () => <div /> }))
vi.mock('./EventMap', () => ({ default: () => <div /> }))

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        event_id: 'evt-review-1',
        calendar_id: 'cal-1',
        title: 'Sunday Salsa Social',
        description: null,
        location: null,
        latitude: null,
        longitude: null,
        start: '2026-09-19T18:00:00Z',
        end: '2026-09-19T22:00:00Z',
        all_day: false,
        color: null,
        view_count: 0,
        price_min: null,
        price_max: null,
        price_currency: null,
        price_is_free: null,
        links: [],
        tags: [],
        ...overrides,
    }
}

function renderPanel(event: CalendarEvent) {
    vi.mocked(api.fetchAdminEvent).mockResolvedValue(event)
    vi.mocked(api.fetchEventDuplicateCandidates).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(api.fetchEventSeriesCandidates).mockResolvedValue({ items: [], total: 0 })

    return render(
        <MemoryRouter>
            <ToastProvider>
                <AdminEventDetailPanel eventId={event.event_id} onClose={vi.fn()} />
            </ToastProvider>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: undefined,
    })
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
})

describe('AdminEventDetailPanel review link', () => {
    it('shares the review deep link through the native share API', async () => {
        const share = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'share', { configurable: true, value: share })
        renderPanel(makeEvent())

        await userEvent.click(await screen.findByRole('button', { name: 'Share review link' }))

        expect(share).toHaveBeenCalledWith({
            title: 'Review Sunday Salsa Social',
            text: 'Share your experience at Sunday Salsa Social',
            url: `${window.location.origin}/event/evt-review-1/review`,
        })
    })

    it('copies the review deep link when native sharing is unavailable', async () => {
        renderPanel(makeEvent())

        await userEvent.click(await screen.findByRole('button', { name: 'Share review link' }))

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            `${window.location.origin}/event/evt-review-1/review`,
        )
        expect(await screen.findByText('Review link copied')).toBeInTheDocument()
    })

    it('does not show an error when native sharing is cancelled', async () => {
        const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
        Object.defineProperty(navigator, 'share', { configurable: true, value: share })
        renderPanel(makeEvent())

        await userEvent.click(await screen.findByRole('button', { name: 'Share review link' }))
        await waitFor(() => expect(share).toHaveBeenCalled())

        expect(screen.queryByText('Could not share review link')).not.toBeInTheDocument()
    })

    it('disables sharing until the event has ended', async () => {
        renderPanel(makeEvent({ end: '2999-09-19T22:00:00Z' }))

        expect(await screen.findByRole('button', { name: 'Share review link' })).toBeDisabled()
        expect(screen.getByText('Available after the event ends')).toBeInTheDocument()
    })
})
