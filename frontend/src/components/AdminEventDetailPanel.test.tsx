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
    fetchAdminEventNotificationStats: vi.fn(),
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

describe('AdminEventDetailPanel notifications section', () => {
    it('shows interest reach + channel counts and refetches when the event reloads', async () => {
        const stats = (matched: number) => ({
            interest: {
                eligible: true,
                ineligible_reason: null,
                matched_profiles: matched,
                matched_users: matched,
                already_notified_users: 1,
                would_alert_app: 2,
                would_alert_email: 1,
                would_alert_push: 1,
            },
            by_kind: [{
                kind: 'interest_event', users: 3, app: 3, email: 1, push: 2,
                app_reads: 2, push_opens: 1, email_clicks: 0,
            }],
            total_users: 3,
        })
        vi.mocked(api.fetchAdminEventNotificationStats)
            .mockResolvedValueOnce(stats(4))
            .mockResolvedValueOnce(stats(7))
        const event = makeEvent()
        renderPanel(event)

        await userEvent.click(await screen.findByRole('button', { name: /notifications/i }))

        expect(await screen.findByText('Saved-search match')).toBeInTheDocument()
        expect(screen.getByText('4 users', { selector: 'strong' })).toBeInTheDocument()
        expect(screen.getByText('2 notified · 2 not notified yet')).toBeInTheDocument()
        expect(
            screen.getByText('3 in-app (2 read) · 1 email (0 clicked) · 2 push (1 opened)'),
        ).toBeInTheDocument()

        vi.mocked(api.fetchAdminEvent).mockResolvedValue({ ...event, title: 'Renamed' })
        await userEvent.click(screen.getByRole('button', { name: 'Refresh event' }))

        await waitFor(() => expect(api.fetchAdminEventNotificationStats).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('7 users', { selector: 'strong' })).toBeInTheDocument()
    })
})

describe('AdminEventDetailPanel review link', () => {
    it('shows blocked status and reason on the matching panel surface', async () => {
        const { container } = renderPanel(makeEvent({
            status: 'blocked',
            is_blocked: true,
            is_hidden: true,
            block_reason: 'deleted',
            block_reason_detail: 'Removed by an administrator',
        }))

        expect(await screen.findByText('blocked')).toBeInTheDocument()
        expect(screen.getByText('Deleted')).toHaveAttribute('title', 'Removed by an administrator')
        expect(container.querySelector('.bg-admin-blocked')).toBeInTheDocument()
        expect(container.querySelector('img[src="/blocked.png"]')).toHaveClass('h-8', 'w-8')
    })

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
