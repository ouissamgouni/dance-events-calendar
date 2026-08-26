import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import PassportPage from './PassportPage'
import { AuthProvider } from '../context/AuthContext'
import { AttendanceSummariesProvider } from '../context/AttendanceSummariesContext'
import { SavedEventsProvider } from '../context/SavedEventsContext'
import { AttendingEventsProvider } from '../context/AttendingEventsContext'
import { ToastProvider } from '../components/Toast'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'
import { renderCardToBlob, downloadImage } from '../utils/passportShareImage'

// Covers the Passport page rendering summary stats, milestones and the
// Milestones/Journey/Places tabs from the mocked /api/passport +
// /api/passport/timeline endpoints, plus the celebration toast for
// newly-unlocked milestones. The Leaflet-backed EventMap is stubbed so the
// Places tab renders deterministically in jsdom.
vi.mock('../components/EventMap', () => ({
    default: ({ events, cooperativeGestures, detailLinkSource, onMarkerSelect }: {
        events: Array<{ event_id: string; title: string; city?: string | null; country?: string | null }>;
        cooperativeGestures?: boolean;
        detailLinkSource?: string;
        onMarkerSelect?: (event: { event_id: string; title: string; city?: string | null; country?: string | null }) => void;
    }) => (
        <div
            data-testid="passport-map"
            data-cooperative-gestures={String(cooperativeGestures === true)}
            data-detail-link-source={detailLinkSource}
        >
            {events.map((event) => (
                <button key={event.event_id} type="button" aria-label={`${event.title} marker`} onClick={() => onMarkerSelect?.(event)}>
                    {event.title}
                </button>
            ))}
        </div>
    ),
}))

// Rasterising the share card needs a real canvas; stub the capture/share util
// so the test asserts the dialog wiring (token mint + events fetch + scope)
// rather than image encoding.
vi.mock('../utils/passportShareImage', () => ({
    CARD_WIDTH: 360,
    CARD_HEIGHT: 640,
    renderCardToBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
    shareImage: vi.fn(async () => 'unsupported'),
    downloadImage: vi.fn(),
}))

function renderPassport() {
    return render(
        <MemoryRouter initialEntries={['/mine/passport']}>
            <ToastProvider>
                <AuthProvider>
                    <AttendanceSummariesProvider>
                        <SavedEventsProvider>
                            <AttendingEventsProvider>
                                <Routes>
                                    <Route path="/mine/passport" element={<PassportPage />} />
                                    <Route path="/login" element={<p>login page</p>} />
                                    <Route path="/event/:eventId" element={<p>event page</p>} />
                                </Routes>
                            </AttendingEventsProvider>
                        </SavedEventsProvider>
                    </AttendanceSummariesProvider>
                </AuthProvider>
            </ToastProvider>
        </MemoryRouter>,
    )
}

function makeMilestone(overrides: Record<string, unknown> = {}) {
    return {
        key: 'first_event',
        name: 'First Steps',
        description: 'Attend your first event',
        achieved_description: 'Attended your first event',
        icon: '🎉',
        category: 'events',
        threshold: 1,
        unit: 'events',
        progress: 1,
        unlocked: true,
        is_new: false,
        unlocked_at: '2024-01-10T20:00:00',
        prestige: 1,
        ...overrides,
    }
}

const PASSPORT = {
    stats: {
        total_events_attended: 12,
        cities_visited: 3,
        countries_visited: 2,
        reviews_written: 5,
        styles_danced: 4,
        top_style: null,
        active_months_last_12: 3,
        active_months_this_year: 2,
        events_last_30_days: 2,
        avg_gap_days: 11.5,
        first_event_date: '2024-01-10T20:00:00',
        member_since: '2023-06-01T00:00:00',
        dancing_since: null,
    },
    collections: {
        cities: [
            { city: 'Paris', country: 'France', count: 6, latitude: 48.85, longitude: 2.35 },
            { city: 'Berlin', country: 'Germany', count: 1, latitude: 52.52, longitude: 13.4 },
        ],
        countries: [
            { country: 'France', count: 6 },
            { country: 'Germany', count: 1 },
        ],
    },
    milestones: [
        makeMilestone(),
        makeMilestone({ key: 'events_10', name: 'Regular', threshold: 10, progress: 8, unlocked: false }),
    ],
    consistency: null,
}

const TIMELINE = {
    items: [
        {
            event_id: 'evt-1',
            title: 'Paris Salsa Night',
            start: '2024-05-10T20:00:00',
            location: 'Studio A',
            city: 'Paris',
            country: 'France',
            tags: ['Salsa'],
            latitude: null,
            longitude: null,
        },
    ],
    markers: [
        { key: 'first_event', name: 'First Steps', icon: '🎉', description: 'Attend your first event', date: '2024-05-10T20:00:00', event_id: 'evt-1' },
        { key: 'cities_3', name: 'City Starter', icon: '🏙️', description: 'Dance in 3 cities', date: '2024-05-10T20:00:00', event_id: 'evt-1' },
    ],
    total: 1,
}

describe('PassportPage', () => {
    it('renders summary, stats and timeline for a signed-in dancer', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
        )

        renderPassport()

        expect(await screen.findByText('Your stats')).toBeInTheDocument()
        expect(screen.getAllByText('Events').length).toBeGreaterThan(0)
        expect(screen.getByText('Days / event')).toBeInTheDocument()
        expect(screen.queryByText('Last 30 days')).not.toBeInTheDocument()
        expect(screen.queryByText('Avg gap (days)')).not.toBeInTheDocument()
        expect(screen.queryByText(/12 events · 3 cities · 2 countries/)).not.toBeInTheDocument()
        // Journey owns the timeline and heatmap (Milestones is the default tab).
        fireEvent.click(screen.getByRole('tab', { name: 'Journey' }))
        expect(await screen.findByText('Paris Salsa Night')).toBeInTheDocument()
        // Milestone markers interleave into the timeline.
        expect(screen.getByText('First Steps')).toBeInTheDocument()
        expect(screen.getByText('City Starter')).toBeInTheDocument()
        expect(screen.getAllByTestId('journey-entry')).toHaveLength(1)
        expect(screen.getByRole('heading', { name: '2024' })).toBeInTheDocument()
        expect(screen.getByPlaceholderText('Search events by name, city or tag')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Show in map' })).toBeInTheDocument()
        // No "Styles danced" stat card.
        expect(screen.queryByText('Styles danced')).not.toBeInTheDocument()
    })

    it('renders an independent milestone as its own chronological entry', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json({
                ...TIMELINE,
                markers: [
                    ...TIMELINE.markers,
                    { key: 'first_review', name: 'Reviewer', icon: '✍️', description: 'Leave your first review', date: '2024-06-16T12:00:00', event_id: null },
                ],
            })),
        )

        renderPassport()
        await screen.findByText('Your stats')
        fireEvent.click(screen.getByRole('tab', { name: 'Journey' }))

        expect(await screen.findByText('Reviewer')).toBeInTheDocument()
        expect(screen.getAllByTestId('journey-entry')).toHaveLength(2)
        expect(screen.queryByText(/Unlocked/)).not.toBeInTheDocument()
    })

    it('searches the owner timeline by the entered event query', async () => {
        let query = ''
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', ({ request }) => {
                query = new URL(request.url).searchParams.get('q') ?? ''
                return HttpResponse.json(TIMELINE)
            }),
        )

        renderPassport()
        await screen.findByText('Your stats')
        fireEvent.click(screen.getByRole('tab', { name: 'Journey' }))
        fireEvent.change(screen.getByPlaceholderText('Search events by name, city or tag'), { target: { value: 'Salsa' } })

        await waitFor(() => expect(query).toBe('Salsa'))
    })

    it('switches between Cities and Countries inside the Places tab', async () => {
        const mapEvents = [
            { event_id: 'paris-event', title: 'Paris Social', start: '2024-05-10T20:00:00', city: 'Paris', country: 'France', latitude: 48.85, longitude: 2.35 },
            { event_id: 'berlin-event', title: 'Berlin Social', start: '2024-06-10T20:00:00', city: 'Berlin', country: 'Germany', latitude: 52.52, longitude: 13.4 },
        ]
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/passport/events', () => HttpResponse.json(mapEvents)),
        )

        renderPassport()

        // Milestones is the default tab; collections live under Places.
        expect(await screen.findByText('Milestone progress')).toBeInTheDocument()
        expect(screen.queryByText('France')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: 'Places' }))
        const map = await screen.findByTestId('passport-map')
        expect(map).toHaveAttribute('data-cooperative-gestures', 'true')
        expect(map).toHaveAttribute('data-detail-link-source', 'passport')
        expect(screen.getByRole('button', { name: '3 cities' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: '2 countries' })).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('button', { name: 'Paris, France 6 events' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Berlin, Germany 1 event' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^All/ })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Paris, France 6 events' }))
        expect(screen.getByText('Paris Social')).toBeInTheDocument()
        expect(screen.queryByText('Berlin Social')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '2 countries' }))
        expect(screen.getByRole('button', { name: 'France 6 events' })).toBeInTheDocument()
        expect(screen.getByText('Paris Social')).toBeInTheDocument()
        expect(screen.getByText('Berlin Social')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '3 cities' }))
        fireEvent.click(screen.getByRole('button', { name: 'Berlin Social marker' }))
        expect(screen.getByRole('button', { name: 'Berlin, Germany 1 event' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByText('Paris Social')).toBeInTheDocument()
        expect(screen.getByText('Berlin Social')).toBeInTheDocument()
    })

    it('renders milestones with goal text, locked progress and fires a toast for new unlocks', async () => {
        const withNew = {
            ...PASSPORT,
            milestones: [
                makeMilestone({ is_new: true }),
                makeMilestone({ key: 'events_10', name: 'Regular', description: 'Attend 10 events', threshold: 10, progress: 8, unlocked: false }),
            ],
        }
        let acked: string[] | null = null
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(withNew)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.post('*/api/passport/milestones/ack', async ({ request }) => {
                const body = (await request.json()) as { keys: string[] }
                acked = body.keys
                return HttpResponse.json({ acknowledged: body.keys.length })
            }),
        )

        renderPassport()

        expect(await screen.findByText('Milestone progress')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Community, 0 / 0 unlocked' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Events.*1 \/ 2 unlocked/ }))
        expect(await screen.findByRole('dialog', { name: 'Events Milestones' })).toBeInTheDocument()
        expect(screen.getAllByText('First Steps').length).toBeGreaterThan(0)
        expect(screen.getByText('Attended your first event')).toBeInTheDocument()
        expect(screen.getByText('Regular')).toBeInTheDocument()
        expect(screen.getByText('Attend 10 events')).toBeInTheDocument()
        expect(screen.getByText('8 / 10')).toBeInTheDocument()
        expect(screen.getByRole('progressbar', { name: 'Regular progress' })).toHaveAttribute('aria-valuenow', '8')
        fireEvent.click(screen.getByRole('button', { name: 'Close milestone details' }))
        expect(screen.queryByRole('dialog', { name: 'Events Milestones' })).not.toBeInTheDocument()

        // Celebration toast for the newly-unlocked milestone.
        expect(await screen.findByText(/Milestone unlocked!/)).toBeInTheDocument()
        await waitFor(() => expect(acked).toEqual(['first_event']))
    })

    it('prompts to sign in when unauthenticated', async () => {
        server.use(
            http.get('*/api/auth/me', () => new HttpResponse(null, { status: 401 })),
        )

        renderPassport()

        await waitFor(() =>
            expect(screen.getByText(/Sign in to track your dance journey/)).toBeInTheDocument(),
        )
    })

    it('mints a public share link from the share dialog', async () => {
        let shareCalled = false
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/passport/share', () => HttpResponse.json(null)),
            http.post('*/api/passport/share', () => {
                shareCalled = true
                return new HttpResponse(
                    JSON.stringify({ token: 'tok-abc', require_signin: false }),
                    {
                        status: 201,
                        headers: { 'Content-Type': 'application/json' },
                    },
                )
            }),
        )

        renderPassport()

        // Opening the menu does not mint a link yet.
        const openBtn = await screen.findByRole('button', { name: 'Share passport' })
        fireEvent.click(openBtn)
        fireEvent.click(await screen.findByRole('menuitem', { name: /^As link/ }))
        expect(shareCalled).toBe(false)

        // The dialog's own "Share link" button performs the mint.
        const shareBtn = await screen.findByRole('button', { name: 'Share link' })
        fireEvent.click(shareBtn)

        await waitFor(() => expect(shareCalled).toBe(true))
        // A toast surfaces the shareable link (native share is unavailable in jsdom).
        expect(await screen.findByText(/\/shared\/passport\/tok-abc/)).toBeInTheDocument()
    })

    it('generates a shareable image card from the share dialog', async () => {
        let eventsFetched = false
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/passport/share', () => HttpResponse.json(null)),
            http.post('*/api/passport/share', () =>
                HttpResponse.json({ token: 'tok-img', require_signin: false }, { status: 201 }),
            ),
            http.get('*/social/users/*', () =>
                HttpResponse.json({
                    handle: 'dancer',
                    display_name: 'Dana Dancer',
                    passport_show_badges: true,
                    passport_show_cities: true,
                    passport_show_countries: true,
                }),
            ),
            http.get('*/api/passport/events', () => {
                eventsFetched = true
                return HttpResponse.json([
                    {
                        event_id: 'evt-1',
                        title: 'Paris Salsa Night',
                        start: '2026-05-10T20:00:00',
                        city: 'Paris',
                        country: 'France',
                        latitude: 48.85,
                        longitude: 2.35,
                    },
                    {
                        event_id: 'evt-2',
                        title: 'Berlin Bachata',
                        start: '2026-06-10T20:00:00',
                        city: 'Berlin',
                        country: 'Germany',
                        latitude: 52.52,
                        longitude: 13.4,
                    },
                ])
            }),
        )

        renderPassport()

        fireEvent.click(await screen.findByRole('button', { name: 'Share passport' }))
        fireEvent.click(await screen.findByRole('menuitem', { name: /^As card/ }))

        // The dialog prepares the card (mints a link so the QR resolves, loads
        // events + section flags), then Download saves the PNG directly.
        const downloadBtn = await screen.findByRole('button', { name: 'Download' })
        await waitFor(() => expect(downloadBtn).toBeEnabled())
        fireEvent.click(downloadBtn)

        await waitFor(() => expect(vi.mocked(renderCardToBlob)).toHaveBeenCalled())
        expect(eventsFetched).toBe(true)
        expect(vi.mocked(downloadImage)).toHaveBeenCalled()
        expect(await screen.findByText('Image saved')).toBeInTheDocument()
    })

    it('adds a past event to the passport via the search + confirm flow', async () => {
        let attendanceBody: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/auth/attending-events', () => HttpResponse.json({ events: [] })),
            http.get('*/api/events/search', () =>
                HttpResponse.json([
                    {
                        event_id: 'past-1',
                        title: 'Havana Rooftop Social',
                        start: '2023-09-01T21:00:00',
                        location: 'Rooftop Bar',
                    },
                ]),
            ),
            http.get('*/api/events/past-1', () =>
                HttpResponse.json({
                    event_id: 'past-1',
                    calendar_id: 'cal-1',
                    title: 'Havana Rooftop Social',
                    description: 'A long night of son and salsa under the stars.',
                    location: 'Rooftop Bar',
                    latitude: null,
                    longitude: null,
                    start: '2023-09-01T21:00:00',
                    end: '2023-09-02T02:00:00',
                    all_day: false,
                    color: null,
                    view_count: 0,
                }),
            ),
            http.post('*/api/track/event-attendance', async ({ request }) => {
                attendanceBody = (await request.json()) as Record<string, unknown>
                return new HttpResponse(null, { status: 204 })
            }),
        )

        renderPassport()

        // The "Add a past event" control lives at the top of Journey.
        await screen.findByText('Your stats')
        fireEvent.click(screen.getByRole('tab', { name: 'Journey' }))
        const addTrigger = await screen.findByRole('button', { name: 'Add past event' })
        expect(addTrigger.className).toContain('border-line')
        expect(addTrigger.className).not.toContain('danger')
        fireEvent.click(addTrigger)

        // Type a query and pick the returned past event.
        const input = await screen.findByLabelText('Search past events')
        fireEvent.change(input, { target: { value: 'Havana' } })
        const result = await screen.findByText('Havana Rooftop Social')
        // The result card shows the event year (past events span years).
        expect(screen.getByText(/2023 · Rooftop Bar/)).toBeInTheDocument()
        fireEvent.click(result)

        // The confirmation dialog shows the event details and the attendance question.
        expect(await screen.findByText(/Did you really attend this event\?/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Yes, I attended/ }))

        // Attendance is recorded as "going" for the chosen past event.
        await waitFor(() => expect(attendanceBody).not.toBeNull())
        expect(attendanceBody).toMatchObject({ event_id: 'past-1', action: 'going' })
        // Success toast confirms the addition.
        expect(await screen.findByText(/Added to your passport/)).toBeInTheDocument()
    })

    it('hides already-attended events and links to the calendar when past search is empty', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/auth/attending-events', () =>
                HttpResponse.json({
                    events: [{ event_id: 'past-1', share_publicly: false, share_audience: 'private' }],
                }),
            ),
            // The only match is an event the viewer already attended.
            http.get('*/api/events/search', () =>
                HttpResponse.json([
                    {
                        event_id: 'past-1',
                        title: 'Havana Rooftop Social',
                        start: '2023-09-01T21:00:00',
                        location: 'Rooftop Bar',
                    },
                ]),
            ),
        )

        renderPassport()

        await screen.findByText('Your stats')
        fireEvent.click(screen.getByRole('tab', { name: 'Journey' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Add past event' }))

        const input = await screen.findByLabelText('Search past events')
        fireEvent.change(input, { target: { value: 'Havana' } })

        // Already-attended event is filtered out, so the empty-state calendar
        // link is offered instead.
        const calendarLink = await screen.findByRole('link', { name: 'Browse the calendar' })
        expect(calendarLink).toHaveAttribute('href', '/calendar')
        expect(screen.queryByText('Havana Rooftop Social')).not.toBeInTheDocument()
    })
})
