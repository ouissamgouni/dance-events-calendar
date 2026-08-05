import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Event Quality Layer e2e smoke (Phase 3: post-event review-prompt nudge).
// Fully route-mocked (no real backend needed), mirroring event-experience.spec.ts.

const EVENT: Record<string, unknown> = {
    event_id: 'evt-review-prompt-e2e',
    calendar_id: 'cal-1',
    title: 'Rooftop Salsa Social',
    description: 'Test event for the review-prompt nudge.',
    location: 'Test Venue, Lisbon, Portugal',
    latitude: 38.7139,
    longitude: -9.1394,
    start: '2026-07-01T20:00:00Z',
    end: '2026-07-01T23:00:00Z',
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

const NOTIFICATIONS_RESPONSE = {
    items: [
        {
            id: 1,
            kind: 'event_review_prompt',
            event_id: EVENT.event_id,
            event_title: EVENT.title,
            event_start: EVENT.start,
            actor: {
                handle: 'testdancer',
                display_name: 'Test Dancer',
                avatar_url: null,
                is_verified_organizer: false,
            },
            context: null,
            created_at: '2026-07-02T10:00:00Z',
            read_at: null,
        },
    ],
    total: 1,
    unread_count: 1,
    limit: 50,
    offset: 0,
}

async function mockCommonRoutes(page: Page, { signedIn = true }: { signedIn?: boolean } = {}) {
    await page.route('**/api/**', async (route) => {
        const req = route.request()
        const url = new URL(req.url())
        const path = url.pathname

        if (path.endsWith('/api/auth/me')) {
            if (!signedIn) {
                await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'not authenticated' }) })
                return
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    user_id: 'user-1',
                    email: 'dancer@example.com',
                    name: 'Test Dancer',
                    handle: 'testdancer',
                    is_admin: false,
                    is_new_user: false,
                    share_attendance_default_audience: 'friends',
                    onboarded_at: '2025-01-01T00:00:00Z',
                    needs_onboarding: false,
                    timezone: 'UTC',
                }),
            })
            return
        }

        if (path.endsWith('/api/auth/mode')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ dev_auth: false, google_client_id: '' }),
            })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}`)) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EVENT) })
            return
        }


        if (path.endsWith('/api/settings')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    since_date: '2025-01-01',
                    sync_since_date: '2025-01-01',
                    sync_interval_minutes: 60,
                    auto_sync_enabled: true,
                    auto_sync_mode: 'incremental',
                    show_prices: false,
                    show_popularity: true,
                    show_ratings: true,
                    popularity_threshold: 10,
                    event_color_bar_color: '#64748b',
                    tag_sort_mode: 'group',
                    default_explorer_period: 'next_3_months',
                    suggest_event_required_dance_group_id: 1,
                    suggest_event_required_reach_group_id: 2,
                }),
            })
            return
        }

        if (path.endsWith('/api/tags')) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}/rating`) && req.method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ event_id: EVENT.event_id, average: 0, count: 0, distribution: {} }),
            })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}/rating/me`)) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}/reviews`)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ items: [], total: 0 }),
            })
            return
        }

        if (path.endsWith('/api/notifications/unread-count')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ count: 1 }),
            })
            return
        }

        if (path.endsWith('/api/notifications') && req.method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(NOTIFICATIONS_RESPONSE),
            })
            return
        }

        if (path.match(/\/api\/notifications\/\d+\/read$/) || path.endsWith('/api/notifications/read-all')) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
            return
        }

        if (
            path.endsWith('/api/config/info') ||
            path.endsWith('/api/auth/attending-events') ||
            path.endsWith('/api/auth/saved-events') ||
            path.endsWith('/api/users/me/ratings') ||
            path.endsWith('/attendance-summary') ||
            path.endsWith('/attendees') ||
            path.endsWith('/going-wedge') ||
            path.endsWith('/api/events/ratings/aggregate')
        ) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
            return
        }

        await route.continue()
    })
}

test('clicking a review-prompt notification navigates to the event and auto-opens the Rate modal', async ({ page }) => {
    await mockCommonRoutes(page)

    await page.goto('/notifications')
    await expect(page.getByText(/How was it\?/)).toBeVisible()
    await expect(page.getByText(EVENT.title as string)).toBeVisible()

    await page.getByText(/How was it\?/).click()

    await expect(page).toHaveURL(new RegExp(`/event/${EVENT.event_id}`))
    // Both the desktop and mobile RateEventButton instances share the same
    // autoOpenToken, so two dialogs (one per layout) can mount — use .first().
    await expect(page.getByRole('dialog', { name: 'Rate this event' }).first()).toBeVisible()

    // The `?rate=1` param is a one-shot trigger — it must not linger in the URL.
    await expect(page).not.toHaveURL(/rate=1/)
    // The `#community` anchor is preserved (not stripped alongside `rate=1`)
    // and the review-prompt notification should land on the reviews section.
    await expect(page).toHaveURL(/#community$/)
})

test('opening a review-prompt link while signed out redirects to login and back to the review URL', async ({ page }) => {
    await mockCommonRoutes(page, { signedIn: false })

    await page.goto(`/event/${EVENT.event_id}?rate=1#community`)

    // Not signed in — bounced to login with the original review URL preserved.
    await expect(page).toHaveURL(/\/login\?next=/)
    const url = new URL(page.url())
    expect(decodeURIComponent(url.searchParams.get('next') ?? '')).toBe(
        `/event/${EVENT.event_id}?rate=1#community`,
    )
})
