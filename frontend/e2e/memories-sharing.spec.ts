import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Shared memories UI contract (route-mocked; backend leak checks live in
// backend/tests/api/test_event_memories_sharing.py).

const EVENT: Record<string, unknown> = {
    event_id: 'evt-memories-e2e',
    calendar_id: 'cal-1',
    title: 'Memories Gala',
    description: 'Test event for shared memories.',
    location: 'Test Venue, Paris, France',
    latitude: 48.85,
    longitude: 2.35,
    start: '2026-01-10T20:00:00Z',
    end: '2026-01-10T23:00:00Z',
    all_day: false,
    color: '#64748b',
    view_count: 0,
    price_min: null,
    price_max: null,
    price_currency: null,
    price_is_free: true,
    links: [],
    tags: [],
}

const memory = (id: string, owner: { handle: string; name: string; friend?: boolean; mine?: boolean }) => ({
    id,
    event_id: EVENT.event_id,
    kind: 'memory',
    content_type: 'image/webp',
    url: null,
    thumb_url: null,
    full_url: null,
    file_url: null,
    width: null,
    height: null,
    visibility: 'friends',
    caption: `${owner.name} ${id}`,
    created_at: '2026-01-11T10:00:00Z',
    is_owner: Boolean(owner.mine),
    owner_display_name: owner.name,
    owner_avatar_url: null,
    owner_handle: owner.mine ? 'testdancer' : owner.handle,
    owner_is_friend: Boolean(owner.friend),
})

const ASSETS = {
    event_id: EVENT.event_id,
    is_going: true,
    assets: [
        memory('o1', { handle: 'olga', name: 'Olga' }),
        memory('f1', { handle: 'fred', name: 'Fred', friend: true }),
        memory('m1', { handle: 'testdancer', name: 'Test Dancer', mine: true }),
    ],
    ticket_count: 0,
    memory_count: 1,
    max_tickets: 2,
    max_memories: 5,
    max_ticket_mb: 5,
    max_memory_mb: 10,
    can_add_ticket: false,
    can_add_memory: false,
    memory_window_opens_at: '2026-01-10T20:00:00Z',
    memory_window_closes_at: '2026-02-09T20:00:00Z',
    ticket_expires_at: '2026-02-10T00:00:00Z',
}

const NOTIFICATIONS = {
    items: [
        {
            id: 7,
            kind: 'subscription_memories',
            event_id: EVENT.event_id,
            event_title: EVENT.title,
            event_start: EVENT.start,
            actor: { handle: 'fred', display_name: 'Fred', avatar_url: null, is_verified_organizer: false },
            actors: [{ handle: 'fred', display_name: 'Fred', avatar_url: null, is_verified_organizer: false }],
            actor_count: 1,
            context: null,
            created_at: '2026-01-11T10:00:00Z',
            read_at: null,
        },
    ],
    total: 1,
    unread_count: 1,
    limit: 50,
    offset: 0,
}

const SHARED_PASSPORT = {
    display_name: 'Fred',
    avatar_url: null,
    stats: {
        total_events_attended: 1, cities_visited: 1, countries_visited: 1, reviews_written: 0,
        styles_danced: 1, top_style: null, active_months_last_12: 1, active_months_this_year: 1,
        events_last_30_days: 0, avg_gap_days: null, first_event_date: '2026-01-10T00:00:00',
        member_since: '2025-01-01T00:00:00', dancing_since: null,
    },
    collections: { cities: [], countries: [] },
    milestones: [],
    consistency: null,
    events: [],
    sections: ['timeline'],
    timeline_items: [{ event_id: EVENT.event_id, title: EVENT.title, start: EVENT.start, location: null, city: 'Paris', country: 'France', lat: null, lng: null }],
    timeline_markers: [],
    monthly_activity: [],
    handle: 'fred',
    is_self: false,
    is_following: true,
}

async function mockRoutes(page: Page, { signedIn = true }: { signedIn?: boolean } = {}) {
    const assetRequests: string[] = []
    await page.route('**/api/**', async (route) => {
        const req = route.request()
        const path = new URL(req.url()).pathname
        const json = (body: unknown, status = 200) =>
            route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

        if (path.includes('event-assets') || path.endsWith('/assets')) assetRequests.push(path)

        if (path.endsWith('/api/auth/me')) {
            return signedIn
                ? json({
                    user_id: 'user-1', email: 'dancer@example.com', name: 'Test Dancer', handle: 'testdancer',
                    is_admin: false, is_new_user: false, share_attendance_default_audience: 'friends',
                    onboarded_at: '2025-01-01T00:00:00Z', needs_onboarding: false, timezone: 'UTC',
                })
                : json({ detail: 'not authenticated' }, 401)
        }
        if (path.endsWith('/api/auth/mode')) return json({ dev_auth: false, google_client_id: '' })
        if (path.endsWith('/api/settings')) {
            return json({
                since_date: '2025-01-01', show_prices: false, show_popularity: true, show_ratings: true,
                popularity_threshold: 10, event_color_bar_color: '#64748b', tag_sort_mode: 'group',
                default_explorer_period: 'next_3_months', event_memories_enabled: true,
            })
        }
        if (path.endsWith(`/api/events/${EVENT.event_id}/assets`)) return json(ASSETS)
        if (path.endsWith(`/api/events/${EVENT.event_id}`)) return json(EVENT)
        if (path.endsWith('/api/passport/shared/tok-fred')) return json(SHARED_PASSPORT)
        if (path.endsWith('/api/notifications/unread-count')) return json({ count: 1 })
        if (path.endsWith('/api/notifications') && req.method() === 'GET') return json(NOTIFICATIONS)
        if (path.match(/\/api\/notifications\/\d+\/read$/) || path.endsWith('/api/notifications/read-all')) return json({})
        if (path.endsWith('/api/tags')) return json([])
        if (path.endsWith(`/api/events/${EVENT.event_id}/rating`)) return json({ event_id: EVENT.event_id, average: 0, count: 0, distribution: {} })
        if (path.endsWith(`/api/events/${EVENT.event_id}/rating/me`)) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
        if (path.endsWith(`/api/events/${EVENT.event_id}/reviews`)) return json({ items: [], total: 0 })
        if (path.endsWith('/api/me/event-assets/summary') || path.includes('/event-assets/summary')) return json({})
        if (
            path.endsWith('/api/config/info')
            || path.endsWith('/api/auth/attending-events')
            || path.endsWith('/api/auth/saved-events')
            || path.endsWith('/api/users/me/ratings')
            || path.endsWith('/attendance-summary')
            || path.endsWith('/attendees')
            || path.endsWith('/going-wedge')
            || path.endsWith('/api/events/ratings/aggregate')
        ) {
            return json([])
        }
        return route.continue()
    })
    return assetRequests
}

test('event page shows one memory trail per person: you, friends, then others', async ({ page }) => {
    await mockRoutes(page)
    await page.goto(`/event/${EVENT.event_id}#memories`)

    const trails = page.getByTestId('memory-trail')
    await expect(trails).toHaveCount(3)
    await expect(trails.nth(0).getByRole('heading')).toContainText('You')
    await expect(trails.nth(1).getByRole('heading')).toContainText('Fred')
    await expect(trails.nth(2).getByRole('heading')).toContainText('Olga')

    await trails.nth(1).getByRole('button', { name: 'Fred f1' }).click()
    const viewer = page.getByRole('dialog', { name: 'Memory' })
    await expect(viewer.getByText('Shared by Fred')).toBeVisible()
    await expect(viewer.getByRole('link', { name: 'Report this photo' })).toBeVisible()
    await expect(viewer.getByRole('button', { name: /Delete/ })).toHaveCount(0)
})

test("a friend's memories notification lands on their highlighted trail", async ({ page }) => {
    await mockRoutes(page)
    await page.goto('/notifications')

    await page.getByText(/shared memories from/).first().click()

    await expect(page).toHaveURL(new RegExp(`/event/${EVENT.event_id}\\?by=fred#memories$`))
    await expect(page.locator('#memories-by-fred')).toHaveClass(/ring-action/)
})

test('a shared passport link never requests or renders memories', async ({ page }) => {
    const assetRequests = await mockRoutes(page)
    await page.goto('/shared/passport/tok-fred')

    await page.getByRole('tab', { name: 'Journey' }).click()
    await expect(page.getByText(EVENT.title as string)).toBeVisible()
    await expect(page.getByTestId('memories-strip')).toHaveCount(0)
    expect(assetRequests).toEqual([])
})

test('signed-out visitors get no memories tab and no asset requests', async ({ page }) => {
    const assetRequests = await mockRoutes(page, { signedIn: false })
    await page.goto(`/event/${EVENT.event_id}`)

    await expect(page.getByRole('tab', { name: 'Overview' }).first()).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Memories' })).toHaveCount(0)
    expect(assetRequests).toEqual([])
})
