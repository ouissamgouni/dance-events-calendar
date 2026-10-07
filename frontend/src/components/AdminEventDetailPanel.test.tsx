import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AdminEventDetailPanel from './AdminEventDetailPanel'
import { ToastProvider } from './Toast'
import * as api from '../api'
import type { AdminEventModeration, CalendarEvent } from '../types'

vi.mock('../api', () => ({
    addEventsToSeries: vi.fn(),
    applyEventRevision: vi.fn(),
    approveSuggestion: vi.fn(),
    blockEvent: vi.fn(),
    discardAdminEventDraft: vi.fn(),
    discardEventRevision: vi.fn(),
    fetchAdminCalendars: vi.fn(() => Promise.resolve([])),
    fetchAdminEventModeration: vi.fn(),
    fetchAdminSuggestion: vi.fn(),
    fetchSuggestionAudit: vi.fn(() => Promise.resolve([])),
    fetchSuggestionOccurrences: vi.fn(() => Promise.resolve({ total: 0, occurrences: [] })),
    syncSuggestionToGoogle: vi.fn(),
    publishAdminEventDraft: vi.fn(),
    rejectSuggestion: vi.fn(),
    updateAdminEventDraft: vi.fn(),
    updateSuggestion: vi.fn(),
    dismissDuplicateGroup: vi.fn(),
    fetchOverlappingEvents: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
    flagEventsAsDuplicates: vi.fn(),
    fetchAdminEvent: vi.fn(),
    fetchAdminEvents: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
    scanEventDuplicates: vi.fn(),
    fetchAdminEventNotificationStats: vi.fn(),
    fetchEventDuplicateCandidates: vi.fn(),
    fetchEventSeriesCandidates: vi.fn(),
    fetchOptionalAdminEventSchedule: vi.fn(() => Promise.resolve(null)),
    fetchSeriesGroups: vi.fn(),
    keepDuplicateEvent: vi.fn(),
    splitSeriesMember: vi.fn(),
    unblockEvent: vi.fn(),
    updateEvent: vi.fn(),
    setAdminEventStatus: vi.fn(),
    adminSetEventOrganizer: vi.fn(),
    fetchAdminUsers: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
}))

vi.mock('../hooks/useAdminCounters', () => ({
    notifyAdminDataChanged: vi.fn(),
}))

vi.mock('./AdminEventDetailContent', () => ({ default: () => <div /> }))
vi.mock('./EventImageEditor', () => ({ default: () => <div /> }))
vi.mock('./EventReviewsSection', () => ({ default: () => <div /> }))
vi.mock('./EventMessagesSection', () => ({ default: () => <div /> }))
vi.mock('./EventMap', () => ({ default: () => <div /> }))
vi.mock('./AdminMockSourceEditor', () => ({ default: () => <div /> }))

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

const PUBLIC_MODERATION: AdminEventModeration = {
    visibility: 'public',
    wants_public: false,
    submission: null,
    series_dates: 1,
    draft: null,
    open_revisions: [],
    history: [],
}

function renderPanel(event: CalendarEvent, moderation: AdminEventModeration = PUBLIC_MODERATION) {
    vi.mocked(api.fetchAdminEvent).mockResolvedValue(event)
    vi.mocked(api.fetchAdminEventModeration).mockResolvedValue(moderation)
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
    it('renders one organizer block across reloads and shows the saved organizer', async () => {
        renderPanel(makeEvent({
            organizer: { user_id: 'u-9', handle: 'olivia', display_name: 'Olivia', avatar_url: null, is_verified_organizer: true },
        }))

        expect(await screen.findByText('@olivia')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Refresh event' }))
        await userEvent.click(await screen.findByRole('button', { name: 'Refresh event' }))

        await waitFor(() => expect(api.fetchAdminEvent).toHaveBeenCalledTimes(3))
        expect(await screen.findAllByRole('region', { name: 'Organizer' })).toHaveLength(1)
    })

    it('publishes a new event from the footer', async () => {
        vi.mocked(api.updateEvent).mockResolvedValue(makeEvent() as never)
        renderPanel(makeEvent({ status: 'new', review_status: 'pending' }))

        await userEvent.click(await screen.findByRole('button', { name: 'Publish' }))

        await waitFor(() => expect(api.updateEvent).toHaveBeenCalledWith('evt-review-1', { status: 'published' }))
    })
    it('shows removed status and reason on the matching panel surface', async () => {
        const { container } = renderPanel(makeEvent({
            status: 'removed',
            status_reason: 'admin',
            is_blocked: true,
            is_hidden: true,
            block_reason: 'deleted',
            block_reason_detail: 'Removed by an administrator',
        }))

        expect(await screen.findByText('Removed', { selector: 'span' })).toBeInTheDocument()
        expect(screen.getByText('Removed by admin')).toHaveAttribute('title', 'Removed by an administrator')
        expect(container.querySelector('.bg-admin-blocked')).toBeInTheDocument()
        expect(container.querySelector('img[src="/blocked.png"]')).toHaveClass('h-8', 'w-8')
        expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
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

    it('offers sharing only once the event has ended', async () => {
        renderPanel(makeEvent({ end: '2999-09-19T22:00:00Z' }))

        expect(await screen.findByRole('link', { name: /See full details/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Share review link' })).not.toBeInTheDocument()
    })
})

describe('AdminEventDetailPanel moderation', () => {
    const submission = (status: string): NonNullable<AdminEventModeration['submission']> => ({
        suggestion_id: 's-1',
        status,
        edit_locked: false,
        submitter: { user_id: 'u-1', handle: 'dev-user', display_name: 'Dev User', avatar_url: null },
        submitter_name: 'Dev User',
        submitter_email: null,
        submitted_at: '2026-09-01T10:00:00Z',
        reviewed_by: null,
        reviewed_at: null,
        admin_notes: null,
        approved_count: 2,
        rejected_count: 0,
        followers_to_notify: 3,
        dates_total: 12,
        dates_materialised: 10,
    })

    it('shows a public request with its decisions on one row', async () => {
        renderPanel(makeEvent({ review_status: 'pending', is_submission: true }), {
            ...PUBLIC_MODERATION,
            visibility: 'private',
            wants_public: true,
            submission: submission('pending'),
        })

        expect(await screen.findByTestId('event-audience')).toHaveTextContent('Only Dev User')
        const card = screen.getByTestId('submission-card')
        expect(card).toHaveTextContent('Public request')
        expect(card).toHaveTextContent('@dev-user')
        expect(card).toHaveTextContent('3 followers notified · 12 dates created (10 previewed now)')
        expect(card).toHaveTextContent('Lock owner edits')
        expect(screen.getByRole('button', { name: 'Make public' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Keep private…' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Block…' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument()
        expect(screen.getByText('Submitted')).toBeInTheDocument()
        expect(screen.getAllByTestId('visibility-chip')[0]).toHaveAccessibleName('Private')
        expect(screen.getAllByTestId('wants-public-chip').length).toBeGreaterThan(0)
    })

    it('keeps a declined request private, with a reason for the owner', async () => {
        const user = userEvent.setup()
        vi.mocked(api.rejectSuggestion).mockResolvedValue({} as never)
        renderPanel(makeEvent({ review_status: 'pending', is_submission: true }), {
            ...PUBLIC_MODERATION,
            visibility: 'private',
            wants_public: true,
            submission: submission('pending'),
        })

        await user.click(await screen.findByRole('button', { name: 'Keep private…' }))
        await user.type(screen.getByLabelText('Reason'), 'Not a dance event')
        await user.click(screen.getByRole('button', { name: 'Keep private' }))

        await waitFor(() => expect(api.rejectSuggestion).toHaveBeenCalledWith('s-1', 'Not a dance event'))
    })

    it('marks a private event reviewed or removes all its dates with a reason, but cannot publish it', async () => {
        const user = userEvent.setup()
        vi.mocked(api.rejectSuggestion).mockResolvedValue({} as never)
        vi.mocked(api.updateEvent).mockResolvedValue(makeEvent() as never)
        renderPanel(makeEvent({ review_status: 'pending', is_submission: true }), {
            ...PUBLIC_MODERATION,
            visibility: 'private',
            submission: submission('private'),
        })

        expect(await screen.findByTestId('event-audience')).toHaveTextContent('Only Dev User')
        expect(screen.queryByRole('button', { name: 'Make public' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Mark reviewed' }))
        await waitFor(() => expect(api.updateEvent).toHaveBeenCalledWith('evt-review-1', { status: 'published' }))

        await user.click(screen.getByRole('button', { name: 'Remove…' }))
        await user.click(screen.getByRole('radio', { name: 'All 12 dates' }))
        await user.type(screen.getByLabelText('Reason shown to the owner'), 'Spam')
        await user.click(screen.getByRole('button', { name: 'Yes, remove' }))
        await waitFor(() => expect(api.rejectSuggestion).toHaveBeenCalledWith('s-1', 'Spam', true))
    })

    it('removes only this date by default', async () => {
        const user = userEvent.setup()
        vi.mocked(api.setAdminEventStatus).mockResolvedValue({} as never)
        renderPanel(makeEvent({ is_submission: true }), {
            ...PUBLIC_MODERATION,
            submission: submission('approved'),
        })

        await user.click(await screen.findByRole('button', { name: 'Remove…' }))
        expect(screen.getByRole('radio', { name: 'This date' })).toBeChecked()
        await user.click(screen.getByRole('button', { name: 'Yes, remove' }))

        await waitFor(() => expect(api.setAdminEventStatus).toHaveBeenCalledWith('evt-review-1', expect.objectContaining({ status: 'removed' })))
        expect(api.rejectSuggestion).not.toHaveBeenCalled()
    })

    it('cancels every upcoming date of a series when asked', async () => {
        const user = userEvent.setup()
        vi.mocked(api.setAdminEventStatus).mockResolvedValue({} as never)
        renderPanel(makeEvent({ review_status: 'reviewed' }), { ...PUBLIC_MODERATION, series_dates: 4 })

        await user.click(await screen.findByRole('button', { name: 'Cancel event…' }))
        expect(screen.getByRole('radio', { name: 'This date' })).toBeChecked()
        await user.click(screen.getByRole('radio', { name: 'All 4 upcoming dates' }))
        await user.click(screen.getByRole('button', { name: 'Mark cancelled' }))

        await waitFor(() => expect(api.setAdminEventStatus).toHaveBeenCalledWith(
            'evt-review-1',
            expect.objectContaining({ status: 'cancelled', scope: 'series' }),
        ))
    })

    it('keeps Lock owner edits after the event was made public', async () => {
        const user = userEvent.setup()
        vi.mocked(api.updateSuggestion).mockResolvedValue({} as never)
        renderPanel(makeEvent({ review_status: 'reviewed', is_submission: true }), {
            ...PUBLIC_MODERATION,
            submission: submission('approved'),
        })

        await user.click(await screen.findByRole('checkbox', { name: 'Lock owner edits' }))

        await waitFor(() => expect(api.updateSuggestion).toHaveBeenCalledWith('s-1', { edit_locked: true }))
        expect(screen.queryByTestId('submission-actions')).not.toBeInTheDocument()
    })

    it('shows submitter details on Show more', async () => {
        const user = userEvent.setup()
        vi.mocked(api.fetchAdminSuggestion).mockResolvedValue({
            id: 's-1',
            status: 'private',
            submitter_email: 'dev@example.com',
            submitter_timezone: 'Europe/Berlin',
        } as never)
        renderPanel(makeEvent({ review_status: 'pending', is_submission: true }), {
            ...PUBLIC_MODERATION,
            visibility: 'private',
            submission: submission('private'),
        })

        await user.click(await screen.findByRole('button', { name: 'Show more' }))

        const details = await screen.findByTestId('submission-details')
        expect(details).toHaveTextContent('dev@example.com')
        expect(details).toHaveTextContent('Europe/Berlin')
    })

    it('applies a pending source change with the notify choice', async () => {
        const user = userEvent.setup()
        vi.mocked(api.applyEventRevision).mockResolvedValue({} as never)
        renderPanel(makeEvent({ review_status: 'reviewed' }), {
            ...PUBLIC_MODERATION,
            open_revisions: [
                {
                    id: 7,
                    event_id: 'evt-review-1',
                    suggestion_id: null,
                    kind: 'edit',
                    source: 'sync',
                    status: 'pending',
                    changes: { location: { old: 'Studio A', new: 'Studio B' } },
                    material_fields: ['location'],
                    proposed_by: null,
                    proposed_by_admin_email: null,
                    decided_by: null,
                    decided_at: null,
                    notified_count: 0,
                    affected_attendees: 2,
                    series_dates: 3,
                    series_affected_attendees: 5,
                    group_size: 1,
                    created_at: '2026-09-01T10:00:00Z',
                    updated_at: '2026-09-01T10:00:00Z',
                },
            ],
        })

        const card = await screen.findByTestId('pending-revision')
        expect(card).toHaveTextContent('Google source')
        expect(card).toHaveTextContent('Venue: Studio A → Studio B')
        expect(screen.getByLabelText(/Notify 2 attendees/)).toBeChecked()
        await user.click(screen.getByRole('radio', { name: 'All 3 upcoming dates' }))
        await user.click(screen.getByLabelText(/Notify 5 attendees/))
        await user.click(screen.getByRole('button', { name: 'Apply' }))

        await waitFor(() => expect(api.applyEventRevision).toHaveBeenCalledWith(7, false, undefined, 'series'))
    })

    it('leaves notify off by default for a minor change', async () => {
        const user = userEvent.setup()
        vi.mocked(api.applyEventRevision).mockResolvedValue({} as never)
        renderPanel(makeEvent({ review_status: 'reviewed' }), {
            ...PUBLIC_MODERATION,
            open_revisions: [
                {
                    id: 8,
                    event_id: 'evt-review-1',
                    suggestion_id: null,
                    kind: 'edit',
                    source: 'sync',
                    status: 'pending',
                    changes: { description: { old: 'Old', new: 'New' } },
                    material_fields: [],
                    proposed_by: null,
                    proposed_by_admin_email: null,
                    decided_by: null,
                    decided_at: null,
                    notified_count: 0,
                    affected_attendees: 2,
                    series_dates: 1,
                    series_affected_attendees: 2,
                    group_size: 1,
                    created_at: '2026-09-01T10:00:00Z',
                    updated_at: '2026-09-01T10:00:00Z',
                },
            ],
        })

        const checkbox = await screen.findByLabelText(/Notify 2 attendees/)
        expect(checkbox).not.toBeChecked()
        expect(screen.getByText('Off by default: minor change.')).toBeInTheDocument()
        expect(screen.queryByTestId('change-scope')).not.toBeInTheDocument()
        await user.click(checkbox)
        await user.click(screen.getByRole('button', { name: 'Apply' }))

        await waitFor(() => expect(api.applyEventRevision).toHaveBeenCalledWith(8, true, undefined, 'date'))
    })
})

describe('AdminEventDetailPanel overlapping events', () => {
    const overlap = (id: string, title: string, likely: boolean) => ({
        event_id: id,
        title,
        start: '2026-09-19T19:00:00Z',
        end: '2026-09-19T23:00:00Z',
        all_day: false,
        location: 'Club Havana',
        calendar_id: 'cal-2',
        visibility: 'public' as const,
        status: 'published' as const,
        title_similarity: likely ? 0.95 : 0.2,
        same_venue: likely,
        likely_duplicate: likely,
        in_duplicate_group: false,
    })

    it('lists same-time events and opens one in an overview', async () => {
        const user = userEvent.setup()
        vi.mocked(api.fetchOverlappingEvents).mockResolvedValue({
            items: [overlap('evt-twin', 'Sunday Salsa Social!', true), overlap('evt-other', 'Kizomba Night', false)],
            total: 2,
        })
        renderPanel(makeEvent())

        const section = await screen.findByTestId('overlapping-events')
        expect(section).toHaveTextContent('Happening at the same time (2)')
        expect(within(section).queryByText('Likely duplicate')).not.toBeInTheDocument()
        expect(within(section).queryByRole('button', { name: 'Flag as duplicate' })).not.toBeInTheDocument()
        expect(within(section).queryByRole('button', { name: /Merge/ })).not.toBeInTheDocument()

        vi.mocked(api.fetchAdminEvent).mockResolvedValue(makeEvent({ event_id: 'evt-other', title: 'Kizomba Night' }))
        await user.click(within(section).getByRole('button', { name: /Kizomba Night/ }))
        const dialog = await screen.findByRole('dialog', { name: 'Event overview' })
        expect(await within(dialog).findByText('Kizomba Night')).toBeInTheDocument()
        expect(api.fetchAdminEvent).toHaveBeenCalledWith('evt-other')
        await user.click(within(dialog).getByText('Close', { selector: 'button' }))
        expect(screen.queryByRole('dialog', { name: 'Event overview' })).not.toBeInTheDocument()
    })
})

describe('AdminEventDetailPanel potential duplicates', () => {
    it('searches an event and flags it as a duplicate from its overview', async () => {
        const user = userEvent.setup()
        const other = makeEvent({ event_id: 'evt-twin', title: 'Salsa Sunday Social' })
        vi.mocked(api.fetchAdminEvents).mockResolvedValue({ items: [makeEvent(), other], total: 2 })
        vi.mocked(api.flagEventsAsDuplicates).mockResolvedValue({} as never)
        renderPanel(makeEvent())

        const section = await screen.findByTestId('potential-duplicates')
        await user.type(within(section).getByLabelText('Search events'), 'salsa')
        const results = await within(section).findByTestId('duplicate-search-results')
        vi.mocked(api.fetchAdminEvent).mockResolvedValue(other)
        await user.click(await within(results).findByRole('button', { name: /Salsa Sunday Social/ }))
        expect(within(results).queryByRole('button', { name: /Sunday Salsa Social/ })).not.toBeInTheDocument()

        const dialog = await screen.findByRole('dialog', { name: 'Event overview' })
        await user.click(await within(dialog).findByRole('button', { name: 'Flag as duplicate' }))
        await waitFor(() => expect(api.flagEventsAsDuplicates).toHaveBeenCalledWith(['evt-review-1', 'evt-twin']))
        expect(screen.queryByRole('dialog', { name: 'Event overview' })).not.toBeInTheDocument()
    })

    it('scans and shows the groups found', async () => {
        const user = userEvent.setup()
        vi.mocked(api.scanEventDuplicates).mockResolvedValue({
            items: [{
                id: 3,
                status: 'pending',
                source: 'auto',
                kept_event_id: null,
                created_at: '2026-09-01T10:00:00Z',
                resolved_at: null,
                events: [
                    { event_id: 'evt-review-1', title: 'Sunday Salsa Social', start: '2026-09-19T18:00:00Z', end: '2026-09-19T22:00:00Z', calendar_id: 'cal-1', is_hidden: false, is_blocked: false, rejected_duplicate_reason: null },
                    { event_id: 'evt-twin', title: 'Sunday Salsa Social!', start: '2026-09-19T18:00:00Z', end: '2026-09-19T22:00:00Z', calendar_id: 'cal-2', is_hidden: false, is_blocked: false, rejected_duplicate_reason: null },
                ],
            }],
            total: 1,
        } as never)
        renderPanel(makeEvent())

        const section = await screen.findByTestId('potential-duplicates')
        await user.click(within(section).getByRole('button', { name: 'Scan' }))

        await waitFor(() => expect(api.scanEventDuplicates).toHaveBeenCalledWith('evt-review-1'))
        expect(await within(section).findByText(/Sunday Salsa Social!/)).toBeInTheDocument()
        expect(within(section).getByRole('button', { name: 'Keep this event' })).toBeInTheDocument()
    })
})
