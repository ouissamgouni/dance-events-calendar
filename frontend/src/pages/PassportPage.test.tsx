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

// Covers the Passport page rendering summary stats, milestones and the
// Timeline/Cities/Countries tabs from the mocked /api/passport +
// /api/passport/timeline endpoints, plus the celebration toast for
// newly-unlocked milestones. The Leaflet-backed EventMap is stubbed so the
// Cities/Countries tabs render deterministically in jsdom.
vi.mock('../components/EventMap', () => ({
    default: () => <div data-testid="passport-map">event map</div>,
}))

function renderPassport() {
    return render(
        <MemoryRouter initialEntries={['/passport']}>
            <ToastProvider>
                <AuthProvider>
                    <AttendanceSummariesProvider>
                        <SavedEventsProvider>
                            <AttendingEventsProvider>
                                <Routes>
                                    <Route path="/passport" element={<PassportPage />} />
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
        icon: '🎉',
        category: 'events',
        threshold: 1,
        unit: 'events',
        progress: 1,
        unlocked: true,
        is_new: false,
        unlocked_at: '2024-01-10T20:00:00',
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
        longest_month_streak: 3,
        events_last_30_days: 2,
        avg_gap_days: 11.5,
        first_event_date: '2024-01-10T20:00:00',
        member_since: '2023-06-01T00:00:00',
    },
    collections: {
        cities: [
            { city: 'Paris', country: 'France', count: 6, latitude: 48.85, longitude: 2.35 },
            { city: 'Berlin', country: 'Germany', count: 4, latitude: 52.52, longitude: 13.4 },
        ],
        countries: [
            { country: 'France', count: 6 },
            { country: 'Germany', count: 4 },
        ],
    },
    milestones: [
        makeMilestone(),
        makeMilestone({ key: 'events_10', name: 'Regular', threshold: 10, progress: 8, unlocked: false }),
    ],
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
            latitude: null,
            longitude: null,
        },
    ],
    markers: [
        { key: 'first_event', name: 'First Steps', icon: '🎉', date: '2024-05-10T20:00:00' },
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

        expect(await screen.findByText(/12 events · 3 cities · 2 countries/)).toBeInTheDocument()
        // Cadence line in the summary header (avg_gap_days 11.5 -> 12 days).
        expect(screen.getByText(/1 event every 12 days/)).toBeInTheDocument()
        expect(screen.getByText('Events attended')).toBeInTheDocument()
        // Frequency card renamed; the "Last 30 days" card was removed.
        expect(screen.getByText('Days between events')).toBeInTheDocument()
        expect(screen.queryByText('Last 30 days')).not.toBeInTheDocument()
        expect(screen.queryByText('Avg gap (days)')).not.toBeInTheDocument()
        // Timeline lives under its own tab (Milestones is the default tab).
        fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
        expect(await screen.findByText('Paris Salsa Night')).toBeInTheDocument()
        // Milestone markers interleave into the timeline.
        expect(screen.getByText(/First dance event/)).toBeInTheDocument()
        // No "Styles danced" stat card.
        expect(screen.queryByText('Styles danced')).not.toBeInTheDocument()
    })

    it('switches to the Cities and Countries tabs via the tab bar and stat links', async () => {
        server.use(
            http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
            http.get('*/api/passport', () => HttpResponse.json(PASSPORT)),
            http.get('*/api/passport/timeline', () => HttpResponse.json(TIMELINE)),
            http.get('*/api/passport/events', () => HttpResponse.json([])),
        )

        renderPassport()

        // Milestones is the default tab; collections live under their own tabs.
        expect(await screen.findAllByText('First Steps')).not.toHaveLength(0)
        expect(screen.queryByText('France')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: 'Countries' }))
        expect(await screen.findByText('France')).toBeInTheDocument()

        // The "Cities" stat-card label acts as a shortcut to the Cities tab,
        // which shows the (stubbed) EventMap beside the cities list.
        fireEvent.click(screen.getByRole('button', { name: 'Cities' }))
        expect(await screen.findByTestId('passport-map')).toBeInTheDocument()
    })

    it('renders milestones with goal text, locked progress and fires a toast for new unlocks', async () => {
        const withNew = {
            ...PASSPORT,
            milestones: [
                makeMilestone({ is_new: true }),
                makeMilestone({ key: 'events_10', name: 'Regular', threshold: 10, progress: 8, unlocked: false }),
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

        // Milestone badges render (unlocked "First Steps" with its goal text +
        // locked "Regular" showing 8/10).
        expect(await screen.findByText('Milestones')).toBeInTheDocument()
        expect(screen.getAllByText('First Steps').length).toBeGreaterThan(0)
        expect(screen.getByText('Attend your first event')).toBeInTheDocument()
        expect(screen.getByText('Regular')).toBeInTheDocument()
        expect(screen.getByText(/8\/10 events/)).toBeInTheDocument()

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

        // Opening the dialog does not mint a link yet.
        const openBtn = await screen.findByRole('button', { name: 'Share' })
        fireEvent.click(openBtn)
        expect(shareCalled).toBe(false)

        // The dialog's own "Share link" button performs the mint.
        const shareBtn = await screen.findByRole('button', { name: 'Share link' })
        fireEvent.click(shareBtn)

        await waitFor(() => expect(shareCalled).toBe(true))
        // A toast surfaces the shareable link (native share is unavailable in jsdom).
        expect(await screen.findByText(/\/shared\/passport\/tok-abc/)).toBeInTheDocument()
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

        // The "Add a past event" control lives at the top of the Timeline tab.
        await screen.findByText(/12 events · 3 cities · 2 countries/)
        fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
        const addTrigger = await screen.findByRole('button', { name: 'Add a past event' })
        fireEvent.click(addTrigger)

        // Type a query and pick the returned past event.
        const input = await screen.findByLabelText('Search past events by title')
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

        await screen.findByText(/12 events · 3 cities · 2 countries/)
        fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Add a past event' }))

        const input = await screen.findByLabelText('Search past events by title')
        fireEvent.change(input, { target: { value: 'Havana' } })

        // Already-attended event is filtered out, so the empty-state calendar
        // link is offered instead.
        const calendarLink = await screen.findByRole('link', { name: 'Browse the calendar' })
        expect(calendarLink).toHaveAttribute('href', '/calendar')
        expect(screen.queryByText('Havana Rooftop Social')).not.toBeInTheDocument()
    })
})
