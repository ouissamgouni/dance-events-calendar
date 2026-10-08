import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import EventsPanel, { MatchesCell } from './EventsPanel'
import * as api from '../api'
import type { CalendarEvent } from '../types'

vi.mock('../api', () => ({
    fetchAdminEvents: vi.fn(),
    fetchEventFilterOptions: vi.fn(() => Promise.resolve({ calendars: [], audiences: [], statuses: [], flags: [], geo_statuses: [], tags: [] })),
    fetchAdminTagGroups: vi.fn(() => Promise.resolve([])),
    fetchAdminUsers: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
}))
vi.mock('../hooks/useAdminCounters', () => ({ notifyAdminDataChanged: vi.fn() }))
vi.mock('./AdminEventDetailPanel', () => ({ default: () => null }))

const reach = {
    eligible: true,
    ineligible_reason: null,
    matched_profiles: 5,
    matched_users: 4,
    already_notified_users: 1,
    would_alert_app: 3,
    would_alert_email: 2,
    would_alert_push: 1,
}

describe('MatchesCell', () => {
    it('shows notified/matching users with a tooltip explaining the rest', () => {
        const { container } = render(<MatchesCell reach={reach} />)
        const cell = container.firstElementChild as HTMLElement
        expect(cell).toHaveTextContent('1/4')
        expect(cell.title).toBe(
            '1 of 4 matching users notified (5 saved searches) · 3 not notified yet, alerted on next event update',
        )
    })

    it('shows a dash with the reason when the event cannot trigger alerts', () => {
        render(<MatchesCell reach={{ ...reach, eligible: false, ineligible_reason: 'pending review' }} />)
        expect(screen.getByText('—')).toHaveAttribute(
            'title',
            'No saved-search alerts: pending review · 1 notified earlier',
        )
    })
})

function adminEvent(id: string, title: string): CalendarEvent {
    return {
        event_id: id,
        title,
        start: '2026-10-16T20:00:00Z',
        end: '2026-10-16T23:00:00Z',
        location: 'Studio',
        tags: [],
        review_status: 'pending',
    } as unknown as CalendarEvent
}

describe('EventsPanel on phones', () => {
    const originalMatchMedia = window.matchMedia

    beforeEach(() => {
        window.matchMedia = vi.fn((query: string) => ({
            matches: query === '(max-width: 639px)',
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })) as unknown as typeof window.matchMedia
        vi.mocked(api.fetchAdminEvents).mockReset()
    })

    afterEach(() => {
        window.matchMedia = originalMatchMedia
        vi.useRealTimers()
    })

    const renderPanel = () => render(
        <MemoryRouter>
            <EventsPanel isOpen onClose={vi.fn()} preset="all" />
        </MemoryRouter>,
    )

    it('enters selection mode on long-press and lists bulk actions in a sheet', async () => {
        vi.mocked(api.fetchAdminEvents).mockResolvedValue({ items: [adminEvent('e1', 'Friday Salsa')], total: 1 } as never)
        renderPanel()
        const title = await screen.findByText('Friday Salsa')

        vi.useFakeTimers()
        fireEvent.pointerDown(title.closest('li')!)
        act(() => { vi.advanceTimersByTime(500) })
        vi.useRealTimers()

        expect(screen.getByText('1 selected')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Actions (1)' }))

        const sheet = screen.getByRole('dialog', { name: 'Bulk actions' })
        expect(within(sheet).getByText('Assign tags')).toBeInTheDocument()
        expect(within(sheet).getByRole('button', { name: /Merge…/ })).toBeDisabled()
        expect(within(sheet).getByText('Select 2–6 events')).toBeInTheDocument()
    })

    it('appends the next page on Load more', async () => {
        vi.mocked(api.fetchAdminEvents).mockImplementation(async (params) => (
            params?.offset
                ? { items: [adminEvent('e2', 'Sunday Bachata')], total: 2 }
                : { items: [adminEvent('e1', 'Friday Salsa')], total: 2 }
        ) as never)
        renderPanel()
        await screen.findByText('Friday Salsa')

        await userEvent.click(screen.getByRole('button', { name: 'Load more' }))

        expect(await screen.findByText('Sunday Bachata')).toBeInTheDocument()
        expect(screen.getByText('Friday Salsa')).toBeInTheDocument()
        expect(vi.mocked(api.fetchAdminEvents)).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1, limit: 25 }))
    })

    it('sorts and groups from a Sort & view sheet, apart from filters', async () => {
        vi.mocked(api.fetchAdminEvents).mockResolvedValue({ items: [adminEvent('e1', 'Friday Salsa')], total: 1 } as never)
        renderPanel()
        await screen.findByText('Friday Salsa')
        const lastParams = () => vi.mocked(api.fetchAdminEvents).mock.lastCall?.[0]

        await userEvent.click(screen.getByRole('button', { name: /^Sort and view/ }))
        const sheet = screen.getByRole('dialog', { name: 'Sort & view' })
        await userEvent.click(within(sheet).getByRole('button', { name: 'Going' }))
        await userEvent.click(within(sheet).getByRole('button', { name: 'Ascending ↑' }))
        await userEvent.click(within(sheet).getByRole('switch', { name: 'Group by series' }))

        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ sort: 'going', order: 'asc', group: 'series' })))
        expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent(/^Filters$/)
    })
})

describe('EventsPanel on desktop', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.mocked(api.fetchAdminEvents).mockReset()
        vi.mocked(api.fetchAdminEvents).mockResolvedValue({ items: [adminEvent('e1', 'Friday Salsa')], total: 1 } as never)
        vi.mocked(api.fetchEventFilterOptions).mockResolvedValue({
            calendars: [], audiences: [], statuses: [], flags: [], geo_statuses: [], tags: [],
            prices: [{ value: 'paid', label: 'Paid', count: 3 }, { value: 'free', label: 'Free', count: 1 }],
            total_count: 1,
            quick_views: { all: 40, review: 14 },
        })
    })

    const renderPanel = async () => {
        render(
            <MemoryRouter>
                <EventsPanel isOpen onClose={vi.fn()} preset="all" />
            </MemoryRouter>,
        )
        await screen.findByText('Friday Salsa')
    }
    const lastParams = () => vi.mocked(api.fetchAdminEvents).mock.lastCall?.[0]

    it('sorts server-side from a column header', async () => {
        await renderPanel()

        await userEvent.click(screen.getByRole('button', { name: 'Going' }))

        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ sort: 'going', order: undefined })))
        expect(screen.getByRole('columnheader', { name: /Going/ })).toHaveAttribute('aria-sort', 'descending')
    })

    it('hides a column from the Columns menu and remembers it', async () => {
        await renderPanel()
        expect(screen.getByRole('columnheader', { name: /Going/ })).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
        await userEvent.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'Going' }))

        expect(screen.queryByRole('columnheader', { name: /Going/ })).not.toBeInTheDocument()
        expect(JSON.parse(localStorage.getItem('admin:events-table:v1')!).hidden).toContain('going')
    })

    it('adds a filter from the + Filter menu and removes it from its chip', async () => {
        await renderPanel()

        await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
        await userEvent.click(screen.getByRole('button', { name: /^Price/ }))
        await userEvent.click(screen.getByRole('checkbox', { name: /Paid/ }))

        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ price: ['paid'] })))
        expect(screen.getByRole('button', { name: 'Edit filter: Price: Paid' })).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: 'Remove filter Price' }))
        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ price: [] })))
    })

    it('applies a quick view and focuses search with "/"', async () => {
        await renderPanel()

        await userEvent.click(screen.getByRole('button', { name: /^Needs review/ }))
        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ status: ['new'] })))
        expect(screen.getByRole('button', { name: /^Needs review\s*14$/ })).toHaveAttribute('aria-pressed', 'true')

        await userEvent.keyboard('/')
        expect(screen.getByRole('textbox', { name: 'Search events' })).toHaveFocus()
    })

    it('labels plain columns and shows the default dates chip as active', async () => {
        await renderPanel()

        expect(screen.queryByRole('columnheader', { name: /^Submitter/ })).not.toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: /^Image/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Edit filter: Upcoming' }).parentElement).toHaveClass('border-action')
    })

    it('applies a custom date range only after Apply', async () => {
        await renderPanel()
        const callsBefore = vi.mocked(api.fetchAdminEvents).mock.calls.length

        await userEvent.click(screen.getByRole('button', { name: 'Edit filter: Upcoming' }))
        await userEvent.click(screen.getByRole('radio', { name: 'Custom range' }))
        expect(vi.mocked(api.fetchAdminEvents).mock.calls.length).toBe(callsBefore)
        const apply = screen.getByRole('button', { name: 'Apply' })
        expect(apply).toBeDisabled()

        fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } })
        await userEvent.click(apply)

        await waitFor(() => expect(lastParams()).toEqual(expect.objectContaining({ start_from: '2026-01-01' })))
    })
})
