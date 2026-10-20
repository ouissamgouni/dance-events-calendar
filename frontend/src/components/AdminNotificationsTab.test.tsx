import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AdminNotificationsTab from './AdminNotificationsTab'
import * as api from '../api'
import type { NotificationActivityItem, NotificationActivityResponse } from '../api'

vi.mock('../api', () => ({
    fetchAdminNotificationActivity: vi.fn(),
}))

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
        app_at: '2026-10-18T06:00:00Z',
        email_at: '2026-10-18T09:00:00Z',
        push_at: '2026-10-18T09:00:00Z',
        read_at: null,
        push_opened_at: null,
        email_clicked_at: id === 1 ? '2026-10-18T09:05:00Z' : null,
        latency_seconds: 10800,
    }
}

const RESPONSE: NotificationActivityResponse = {
    summary: {
        email_digest: 1, email_instant: 0, push: 1, in_app_items: 0,
        auto: 1, user: 0, forced: 0, unknown: 0,
        email_items: 2, email_clicked: 1, push_items: 2, push_opened: 0, app_read: 0,
    },
    total_groups: 1,
    groups: [{
        day: '2026-10-18',
        user: { id: 'u-alice', email: 'alice@example.com', handle: 'alice', display_name: 'Alice' },
        last_at: '2026-10-18T09:00:00Z',
        in_app: null,
        messages: [{
            channels: ['email', 'push'],
            mode: 'digest',
            source: 'tick',
            trigger: 'auto',
            sent_at: '2026-10-18T09:00:00Z',
            item_count: 2,
            engaged_count: 1,
            topics: [{ topic: 'friends_going', count: 1 }, { topic: 'interest_matches', count: 1 }],
            items: [item(1, 'Bob is going to Salsa Night', 'friends_going'), item(2, 'New match: Salsa Night', 'interest_matches')],
        }],
    }],
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchAdminNotificationActivity).mockResolvedValue(RESPONSE)
})

function renderTab() {
    return render(<MemoryRouter><AdminNotificationsTab /></MemoryRouter>)
}

describe('AdminNotificationsTab', () => {
    it('groups a digest under its user and expands to its items', async () => {
        const user = userEvent.setup()
        renderTab()

        const row = await screen.findByRole('button', { name: /Digest · 2 items/ })
        expect(screen.getByRole('button', { name: 'Alice (@alice)' })).toBeInTheDocument()
        expect(row).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('Bob is going to Salsa Night')).not.toBeInTheDocument()

        await user.click(row)

        expect(row).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Bob is going to Salsa Night')).toBeInTheDocument()
        expect(screen.getByText('New match: Salsa Night')).toBeInTheDocument()
        const params = vi.mocked(api.fetchAdminNotificationActivity).mock.calls[0][0]
        expect(params.include_in_app).toBe(false)
        expect(params.tz).toBeTruthy()
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
})
