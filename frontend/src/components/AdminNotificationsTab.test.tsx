import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AdminNotificationsTab from './AdminNotificationsTab'
import * as api from '../api'
import type { NotificationActivityItem, NotificationActivityResponse, NotificationActivityRow } from '../api'

vi.mock('../api', () => ({
    fetchAdminNotificationActivity: vi.fn(),
}))

const ALICE = { id: 'u-alice', email: 'alice@example.com', handle: 'alice', display_name: 'Alice' }
const BOB = { id: 'u-bob', email: 'bob@example.com', handle: 'bob', display_name: 'Bob' }

function item(id: number, summary: string, topic: string): NotificationActivityItem {
    return {
        notification_id: id,
        kind: 'subscription_going',
        topic,
        summary,
        created_at: '2026-10-18T06:00:00Z',
        event_id: `evt-${id}`,
        event_title: 'Salsa Night',
        actor_display_name: 'Bob',
        actor_handle: 'bob',
        read_at: id === 1 ? '2026-10-18T09:05:00Z' : null,
        push_opened_at: null,
        email_clicked_at: id === 1 ? '2026-10-18T09:05:00Z' : null,
        latency_seconds: 10800,
    }
}

const DIGEST: NotificationActivityRow = {
    user: ALICE,
    channels: ['email'],
    mode: 'digest',
    source: 'tick',
    trigger: 'auto',
    sent_at: '2026-10-18T09:00:00Z',
    item_count: 2,
    engaged_count: 1,
    read_count: 1,
    email_clicked: 1,
    email_opened: 0,
    push_opened: 0,
    topics: [{ topic: 'friends_going', count: 1 }, { topic: 'interest_matches', count: 1 }],
    items: [item(1, 'Bob is going to Salsa Night', 'friends_going'), item(2, 'New match: Salsa Night', 'interest_matches')],
}

const REMINDER: NotificationActivityRow = {
    ...DIGEST,
    user: BOB,
    channels: ['email', 'push'],
    mode: 'instant',
    sent_at: '2026-10-18T08:00:00Z',
    item_count: 1,
    engaged_count: 1,
    read_count: 1,
    email_clicked: 0,
    push_opened: 1,
    topics: [{ topic: 'event_reminders', count: 1 }],
    items: [{ ...item(3, 'Salsa Night starts soon', 'event_reminders'), push_opened_at: '2026-10-18T08:05:00Z', email_clicked_at: null }],
}

const SUMMARY: NotificationActivityResponse['summary'] = {
    email_digest: 1, email_instant: 1, push: 1, in_app_items: 0,
    auto: 2, user: 0, forced: 0, unknown: 0,
    email_items: 3, email_clicked: 1, push_items: 1, push_opened: 1, app_read: 0,
}

const RESPONSE: NotificationActivityResponse = { summary: SUMMARY, rows: [DIGEST, REMINDER], groups: [], total: 2 }

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchAdminNotificationActivity).mockResolvedValue(RESPONSE)
})

function renderTab() {
    return render(<MemoryRouter><AdminNotificationsTab /></MemoryRouter>)
}

describe('AdminNotificationsTab', () => {
    it('lists sends by time with the recipient on each row and expands a digest', async () => {
        const user = userEvent.setup()
        renderTab()

        const digest = await screen.findByRole('button', { name: /^Friends going\s*1\s*Interest matches\s*1$/ })
        const names = screen.getAllByRole('button', { name: /\(@(alice|bob)\)/ }).map((b) => b.textContent)
        expect(names).toEqual(['Alice (@alice)', 'Bob (@bob)'])
        expect(screen.getByText('Clicked 1/2')).toBeInTheDocument()
        expect(digest).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('New match: Salsa Night')).not.toBeInTheDocument()

        await user.click(digest)

        expect(digest).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('New match: Salsa Night')).toBeInTheDocument()
        const params = vi.mocked(api.fetchAdminNotificationActivity).mock.calls[0][0]
        expect(params).toMatchObject({ include_in_app: false, limit: 50 })
        expect(params.group).toBeUndefined()
    })

    it('shows a single send inline with its event link and secondary channel', async () => {
        renderTab()

        const text = await screen.findByText('Salsa Night starts soon')
        expect(text.closest('button')).toBeNull()
        const row = text.closest('li') as HTMLElement
        expect(within(row).getByRole('link', { name: 'View event ↗' })).toHaveAttribute('href', '/event/evt-3')
        expect(within(row).getByText('Also sent by push')).toBeInTheDocument()
        expect(within(row).getByText('Tapped')).toBeInTheDocument()
    })

    it('toggles a filter from a stat card', async () => {
        const user = userEvent.setup()
        renderTab()

        const card = await screen.findByRole('button', { name: /Email click rate/ })
        await user.click(card)

        await waitFor(() => {
            const last = vi.mocked(api.fetchAdminNotificationActivity).mock.calls.at(-1)?.[0]
            expect(last).toMatchObject({ channel: 'email', engaged: true })
        })
        expect(card).toHaveAttribute('aria-pressed', 'true')

        await user.click(card)
        await waitFor(() => {
            const last = vi.mocked(api.fetchAdminNotificationActivity).mock.calls.at(-1)?.[0]
            expect(last?.channel).toBeUndefined()
            expect(last?.engaged).toBe(false)
        })
    })

    it('filters to a user when their name is clicked', async () => {
        const user = userEvent.setup()
        renderTab()

        await user.click(await screen.findByRole('button', { name: 'Alice (@alice)' }))

        await waitFor(() => {
            const last = vi.mocked(api.fetchAdminNotificationActivity).mock.calls.at(-1)?.[0]
            expect(last?.user_id).toBe('u-alice')
        })
        expect(screen.getByText(/User: Alice/)).toBeInTheDocument()
    })

    it('groups by recipient on demand via the server', async () => {
        const user = userEvent.setup()
        renderTab()
        await screen.findByText('Salsa Night starts soon')
        vi.mocked(api.fetchAdminNotificationActivity).mockResolvedValue({
            summary: SUMMARY,
            rows: [],
            groups: [{ day: '2026-10-18', user: ALICE, rows: [DIGEST] }],
            total: 1,
        })

        await user.click(screen.getByLabelText('Group by recipient'))

        await waitFor(() => {
            const last = vi.mocked(api.fetchAdminNotificationActivity).mock.calls.at(-1)?.[0]
            expect(last).toMatchObject({ group: 'recipient', limit: 20, offset: 0 })
        })
        expect(await screen.findByText('1 recipient-day')).toBeInTheDocument()
        expect(screen.queryByText('Salsa Night starts soon')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Alice (@alice)' })).toBeInTheDocument()
    })

    it('shows unsent rows only through their pill', async () => {
        const user = userEvent.setup()
        vi.mocked(api.fetchAdminNotificationActivity).mockResolvedValue({ ...RESPONSE, summary: { ...SUMMARY, push_failed: 2 } })
        renderTab()

        const pill = await screen.findByRole('button', { name: /Push failed\s*2/ })
        expect(vi.mocked(api.fetchAdminNotificationActivity).mock.calls[0][0].outcome).toBeUndefined()
        vi.mocked(api.fetchAdminNotificationActivity).mockResolvedValue({
            ...RESPONSE,
            rows: [{ ...REMINDER, channels: ['push'], status: 'failed', detail: 'Device unsubscribed (endpoint gone)' }],
            total: 1,
        })

        await user.click(pill)

        await waitFor(() => {
            const last = vi.mocked(api.fetchAdminNotificationActivity).mock.calls.at(-1)?.[0]
            expect(last?.outcome).toBe('push_failed')
        })
        expect(await screen.findByText('Failed · Device unsubscribed (endpoint gone)')).toBeInTheDocument()
        expect(pill).toHaveAttribute('aria-pressed', 'true')
    })
})
