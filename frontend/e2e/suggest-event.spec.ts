import { expect, test } from '@playwright/test'

test('logged-in user submits stepped event with going default on', async ({ page }) => {
    let suggestionPayload: Record<string, unknown> | null = null

    await page.route('**/api/**', async (route) => {
        const req = route.request()
        const url = new URL(req.url())
        const path = url.pathname

        if (path.endsWith('/api/auth/me')) {
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

        if (path.endsWith('/api/events')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([]),
            })
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
                    show_ratings: false,
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
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([
                    {
                        id: 1,
                        slug: 'dance-style',
                        label: 'Dance style',
                        color: '#3b82f6',
                        ordinal: 1,
                        allow_multiple: true,
                        enabled: true,
                        onboarding_eligible: false,
                        scope: 'event',
                        tags: [
                            {
                                id: 101,
                                slug: 'salsa',
                                label: 'Salsa',
                                color: '#3b82f6',
                                ordinal: 1,
                                group_slug: 'dance-style',
                                group_label: 'Dance style',
                                group_color: '#3b82f6',
                                enabled: true,
                                is_hero_filter: false,
                                hero_ordinal: null,
                            },
                        ],
                    },
                    {
                        id: 2,
                        slug: 'reach',
                        label: 'Reach',
                        color: '#0f766e',
                        ordinal: 2,
                        allow_multiple: true,
                        enabled: true,
                        onboarding_eligible: false,
                        scope: 'event',
                        tags: [
                            {
                                id: 201,
                                slug: 'local',
                                label: 'Local',
                                color: '#0f766e',
                                ordinal: 1,
                                group_slug: 'reach',
                                group_label: 'Reach',
                                group_color: '#0f766e',
                                enabled: true,
                                is_hero_filter: false,
                                hero_ordinal: null,
                            },
                        ],
                    },
                ]),
            })
            return
        }

        if (path.endsWith('/api/suggestions/geocode')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([
                    {
                        display_name: 'Berlin Center',
                        latitude: 52.52,
                        longitude: 13.405,
                    },
                ]),
            })
            return
        }

        if (path.endsWith('/api/suggestions') && req.method() === 'POST') {
            suggestionPayload = (await req.postDataJSON()) as Record<string, unknown>
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ id: 'sugg-1', message: 'ok' }),
            })
            return
        }

        if (path.endsWith('/api/auth/saved-events') || path.endsWith('/api/auth/attending-events')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ events: [] }),
            })
            return
        }

        if (path.endsWith('/api/events/attendance-summary')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ summaries: [] }),
            })
            return
        }

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({}),
        })
    })

    await page.goto('/?submit=1')

    await expect(page.getByRole('heading', { name: 'Suggest an Event' })).toBeVisible()

    await page.getByPlaceholder('Event name').fill('Salsa Social')
    await page.locator('input[type="datetime-local"]').nth(0).fill('2026-07-01T20:00')
    await page.locator('input[type="datetime-local"]').nth(1).fill('2026-07-01T23:00')
    await page.getByPlaceholder('Type an address…').fill('Berlin')
    await page.getByText('Berlin Center').click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    await page.getByRole('button', { name: /^Next$/ }).click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    await page.getByRole('button', { name: 'Salsa', exact: true }).click()
    await page.getByRole('button', { name: 'Local', exact: true }).click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    await page.getByRole('button', { name: /^Next$/ }).click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    await expect(page.getByLabel(/Mark me going by default/i)).toBeChecked()
    await page.getByRole('button', { name: /^Submit$/ }).click()

    await expect(page.getByText('Your event is live and under review.')).toBeVisible()
    await expect.poll(() => suggestionPayload?.going).toBe(true)
    await expect.poll(() => suggestionPayload?.going_audience).toBe('friends')
})
