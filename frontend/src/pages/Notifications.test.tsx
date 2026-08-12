import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import NotificationsPage from './Notifications'
import { server } from '../test/server'

const navigateMock = vi.fn()
const markReadMock = vi.fn(async () => { })
const markAllReadMock = vi.fn(async () => { })
const markSeenMock = vi.fn()

vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
    return {
        ...actual,
        useNavigate: () => navigateMock,
    }
})

vi.mock('../context/NotificationsContext', () => ({
    useNotifications: () => ({
        markRead: markReadMock,
        markAllRead: markAllReadMock,
        markSeen: markSeenMock,
    }),
}))

beforeEach(() => {
    navigateMock.mockReset()
    markReadMock.mockClear()
    markAllReadMock.mockClear()
    markSeenMock.mockClear()
})

describe('NotificationsPage (milestone rows)', () => {
    it('renders the milestone unlocked row and routes to the passport (never /event/null)', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        {
                            id: 91,
                            kind: 'milestone_unlocked',
                            event_id: null,
                            event_title: null,
                            event_start: null,
                            context: 'City Hopper',
                            description: 'Attended events in 10 cities',
                            subject_key: 'cities_10',
                            actor: {
                                handle: 'alice',
                                display_name: 'Alice',
                                avatar_url: null,
                                is_verified_organizer: false,
                            },
                            created_at: '2026-06-25T10:00:00Z',
                            read_at: null,
                        },
                    ],
                    total: 1,
                    unread_count: 1,
                    limit: 50,
                    offset: 0,
                }),
            ),
        )

        const user = userEvent.setup()

        render(
            <MemoryRouter>
                <NotificationsPage />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/milestone unlocked/i)).toBeInTheDocument()
        expect(screen.getByText(/city hopper/i)).toBeInTheDocument()
        // Regression guard: it must NOT render the generic "updated an event" copy.
        expect(screen.queryByText(/updated/i)).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /milestone unlocked/i }))

        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/mine/passport'))
        expect(navigateMock).not.toHaveBeenCalledWith('/event/null')
    })
})
