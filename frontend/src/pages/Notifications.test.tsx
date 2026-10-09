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

        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/passport'))
        expect(navigateMock).not.toHaveBeenCalledWith('/event/null')
    })

    it('renders a followed user milestone batch and routes to their profile', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        {
                            id: 92,
                            kind: 'subscription_milestone',
                            event_id: null,
                            event_title: null,
                            event_start: null,
                            context: 'Regular',
                            subject_key: 'events_5',
                            milestones: [
                                { subject_key: 'first_event', name: 'First Steps' },
                                { subject_key: 'events_5', name: 'Regular' },
                                { subject_key: 'events_10', name: 'Committed' },
                                { subject_key: 'cities_5', name: 'City Hopper' },
                            ],
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

        expect(await screen.findByText(/unlocked 4 milestones/i)).toBeInTheDocument()
        expect(screen.getByText('Alice')).toBeInTheDocument()
        expect(screen.getByText(/first steps, regular, committed/i)).toBeInTheDocument()
        expect(screen.getByText(/and 1 more/i)).toBeInTheDocument()
        expect(screen.queryByText(/city hopper/i)).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /alice unlocked 4 milestones/i }))
        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/u/alice'))
    })

    it('renders the alert label as plain text and opens the matched event on row click', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        {
                            id: 93,
                            kind: 'interest_event',
                            event_id: 'ev-match',
                            event_title: 'Oslo Training Weekender',
                            event_start: null,
                            context: 'Europe & nearby',
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

        expect(await screen.findByText('Europe & nearby')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Europe & nearby' })).not.toBeInTheDocument()
        await user.click(screen.getByText('Oslo Training Weekender'))
        expect(navigateMock).toHaveBeenCalledWith('/event/ev-match')
        expect(navigateMock).not.toHaveBeenCalledWith('/saved-searches')
    })

    it('opens the Matches pill from a ?kind=interest_event push deep link', async () => {
        const requests: { kind: string | null; category: string | null; day: string | null }[] = []
        server.use(
            http.get('*/api/notifications', ({ request }) => {
                const sp = new URL(request.url).searchParams
                requests.push({ kind: sp.get('kind'), category: sp.get('category'), day: sp.get('day') })
                return HttpResponse.json({ items: [], total: 0, unread_count: 0, limit: 50, offset: 0 })
            }),
        )
        const user = userEvent.setup()

        render(
            <MemoryRouter initialEntries={['/notifications?kind=interest_event']}>
                <NotificationsPage />
            </MemoryRouter>,
        )

        await waitFor(() =>
            expect(requests.at(-1)).toEqual({ kind: null, category: 'matches', day: null }),
        )
        expect(screen.queryByRole('button', { name: /show all notifications/i })).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Manage alerts' })).toHaveAttribute('href', '/saved-searches')

        await user.click(screen.getByRole('button', { name: /^All$/ }))
        await waitFor(() => expect(requests.at(-1)).toEqual({ kind: null, category: null, day: null }))
    })

    it('scopes the Matches pill to one day from a grouped-row deep link', async () => {
        const requests: (string | null)[] = []
        server.use(
            http.get('*/api/notifications', ({ request }) => {
                const sp = new URL(request.url).searchParams
                requests.push(sp.get('day'))
                return HttpResponse.json({ items: [], total: 4, unread_count: 0, limit: 50, offset: 0 })
            }),
        )
        const user = userEvent.setup()

        render(
            <MemoryRouter initialEntries={['/notifications?kind=interest_event&day=2026-06-25']}>
                <NotificationsPage />
            </MemoryRouter>,
        )

        await waitFor(() => expect(requests.at(-1)).toBe('2026-06-25'))
        const chip = await screen.findByRole('button', { name: 'Show all matches' })
        expect(chip).toHaveTextContent('4 matches')

        await user.click(chip)
        await waitFor(() => expect(requests.at(-1)).toBeNull())
    })

    it('renders a day-grouped interest row as one tap target to that day of matches', async () => {
        const matched = Array.from({ length: 5 }, (_, i) => ({
            event_id: `ev-${i}`,
            title: `Match ${i}`,
            start: null,
            image_url: null,
        }))
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        {
                            id: 94,
                            kind: 'interest_event',
                            event_id: 'ev-0',
                            event_title: 'Match 0',
                            event_start: null,
                            context: 'Salsa, Local',
                            matched_events: matched,
                            matched_event_count: 5,
                            matched_day: '2026-06-25',
                            actor: {
                                handle: 'bob',
                                display_name: 'Bob',
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

        expect(await screen.findByText('5 new events')).toBeInTheDocument()
        expect(screen.getByText('Match 0 · Match 1')).toBeInTheDocument()
        expect(screen.getByText('+3 more')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Match 0' })).not.toBeInTheDocument()

        await user.click(screen.getByText('Match 0 · Match 1'))
        expect(navigateMock).toHaveBeenLastCalledWith('/notifications?kind=interest_event&day=2026-06-25')
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
    it('renders Plan activity count and routes to the planned Program session', async () => {
        server.use(
            http.get('*/api/notifications', () =>
                HttpResponse.json({
                    items: [
                        notif({
                            id: 4,
                            kind: 'plan_session_added',
                            event_id: 'evt-1',
                            event_title: 'Salsa Night',
                            context: 'Musicality Lab',
                            description: '2 sessions planned',
                            schedule_session_id: 'session-2',
                        }),
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

        expect(await screen.findByText('2 sessions planned')).toBeInTheDocument()
        expect(screen.getByText(/added Musicality Lab to their plan for/i)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /ann added Musicality Lab/i }))
        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/event/evt-1/program?session=session-2'))
    })

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
                            actor: actor({ handle: 'ann', display_name: 'Ann Lee' }),
                            actors: [
                                actor({ handle: 'ann', display_name: 'Ann Lee' }),
                                actor({ handle: 'ben', display_name: 'Ben Ortiz' }),
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

    it('filters the feed by category pill on the server', async () => {
        const going = notif({ id: 7, kind: 'subscription_going', event_title: 'Salsa Night' })
        const follower = notif({
            id: 8,
            kind: 'new_follower',
            event_id: null,
            event_title: null,
            actor: actor({ handle: 'ben', display_name: 'Ben' }),
        })
        server.use(
            http.get('*/api/notifications', ({ request }) => {
                const category = new URL(request.url).searchParams.get('category')
                const items = category === 'plans' ? [] : [going, follower]
                return HttpResponse.json({
                    items,
                    total: items.length,
                    unread_count: 0,
                    limit: 50,
                    offset: 0,
                })
            }),
        )

        const user = userEvent.setup()

        render(
            <MemoryRouter>
                <NotificationsPage />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/Salsa Night/)).toBeInTheDocument()
        expect(screen.getByText(/started following you/i)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /My plans/i }))

        expect(await screen.findByText(/No notifications yet/)).toBeInTheDocument()
        expect(screen.queryByText(/Salsa Night/)).not.toBeInTheDocument()
    })

    it('loads the next page with Load more', async () => {
        const offsets: (string | null)[] = []
        server.use(
            http.get('*/api/notifications', ({ request }) => {
                const offset = new URL(request.url).searchParams.get('offset')
                offsets.push(offset)
                const item = offset
                    ? notif({ id: 10, event_title: 'Second Page Party' })
                    : notif({ id: 9, event_title: 'First Page Party' })
                return HttpResponse.json({ items: [item], total: 2, unread_count: 0, limit: 50, offset: 0 })
            }),
        )
        const user = userEvent.setup()

        render(
            <MemoryRouter>
                <NotificationsPage />
            </MemoryRouter>,
        )

        expect(await screen.findByText(/First Page Party/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Load more' }))
        expect(await screen.findByText(/Second Page Party/)).toBeInTheDocument()
        expect(offsets.at(-1)).toBe('1')
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    })
})
