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

const actor = (over: Record<string, unknown> = {}) => ({
    handle: 'ann',
    display_name: 'Ann',
    avatar_url: null,
    is_verified_organizer: false,
    ...over,
})

const notif = (over: Record<string, unknown>) => ({
    id: 1,
    kind: 'subscription_going',
    event_id: 'evt-1',
    event_title: 'Salsa Night',
    event_start: null,
    event_image_url: null,
    context: null,
    description: null,
    subject_key: null,
    actor: actor(),
    actors: undefined,
    actor_count: 1,
    member_ids: [],
    created_at: '2026-06-25T10:00:00Z',
    read_at: null,
    ...over,
})

describe('NotificationsPage (redesigned rows)', () => {
    it('renders a subscription_saved row with "is interested in" and a thumbnail', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        notif({
                            id: 5,
                            kind: 'subscription_saved',
                            event_image_url: '/cover.jpg',
                        }),
                    ],
                    total: 1,
                    unread_count: 1,
                    limit: 50,
                    offset: 0,
                }),
            ),
        )

        render(
            <MemoryRouter>
                <NotificationsPage />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/is interested in/i)).toBeInTheDocument()
        // Ann has no avatar, so the only <img> is the event thumbnail (decorative
        // alt="", so it is queried by src rather than role).
        expect(document.querySelector('img[src="/cover.jpg"]')).not.toBeNull()
    })

    it('aggregates a multi-actor going row with a plural verb and +N others', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        notif({
                            id: 6,
                            actor: actor({ handle: 'ann', display_name: 'Ann' }),
                            actors: [
                                actor({ handle: 'ann', display_name: 'Ann' }),
                                actor({ handle: 'ben', display_name: 'Ben' }),
                                actor({ handle: 'cara', display_name: 'Cara' }),
                            ],
                            actor_count: 3,
                        }),
                    ],
                    total: 1,
                    unread_count: 1,
                    limit: 50,
                    offset: 0,
                }),
            ),
        )

        render(
            <MemoryRouter>
                <NotificationsPage />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/Ann, Ben \+1 others/)).toBeInTheDocument()
        expect(screen.getByText(/are going to/i)).toBeInTheDocument()
    })

    it('filters the feed by category pill', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        notif({ id: 7, kind: 'subscription_going', event_title: 'Salsa Night' }),
                        notif({
                            id: 8,
                            kind: 'new_follower',
                            event_id: null,
                            event_title: null,
                            actor: actor({ handle: 'ben', display_name: 'Ben' }),
                        }),
                    ],
                    total: 2,
                    unread_count: 2,
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

        expect(await screen.findByText(/Salsa Night/)).toBeInTheDocument()
        expect(screen.getByText(/started following you/i)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Network/i }))

        expect(screen.queryByText(/Salsa Night/)).not.toBeInTheDocument()
        expect(screen.getByText(/started following you/i)).toBeInTheDocument()
    })
})
