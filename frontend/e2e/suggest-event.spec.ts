import { expect, test, type Page } from '@playwright/test'

type Payload = Record<string, unknown>

interface MockApiOptions {
    anonymous?: boolean
    authPending?: Promise<void>
}

async function mockApi(
    page: Page,
    onSuggestion: (payload: Payload) => void,
    { anonymous = false, authPending }: MockApiOptions = {},
) {
    await page.route('**/api/**', async (route) => {
        const req = route.request()
        const url = new URL(req.url())
        const path = url.pathname

        if (path.endsWith('/api/auth/me')) {
            await authPending
            if (anonymous) {
                await route.fulfill({ status: 401, body: '' })
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
            onSuggestion((await req.postDataJSON()) as Payload)
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

        if (path.endsWith('/api/interest-profiles')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([]),
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
}

test('anonymous user keeps the submit wizard open after auth resolves', async ({ page }) => {
    let resolveAuth!: () => void
    const authPending = new Promise<void>((resolve) => {
        resolveAuth = resolve
    })
    await mockApi(page, () => { }, { anonymous: true, authPending })

    await page.goto('/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Submit Event' }).click()

    await expect(page).toHaveURL(/\/suggest$/)
    await expect(page.getByRole('heading', { name: 'Suggest an event' })).toBeVisible()

    const authResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/me'))
    resolveAuth()
    expect((await authResponse).status()).toBe(401)

    await expect(page).toHaveURL(/\/suggest$/)
    await expect(page.getByRole('heading', { name: 'Suggest an event' })).toBeVisible()

    await page.getByRole('dialog', { name: 'Suggest an event' }).getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/')
    expect(new URL(page.url()).searchParams.has('submit')).toBe(false)
})

test('logged-in user submits stepped event with going default on', async ({ page }) => {
    let suggestionPayload: Payload | null = null
    await mockApi(page, (payload) => {
        suggestionPayload = payload
    })

    await page.goto('/?submit=1')

    await expect(page.getByRole('heading', { name: 'Suggest an event' })).toBeVisible()
    await expect(page).toHaveURL(/\/suggest$/)

    // Step 1 — Event
    await expect(page.getByText('Step 1 of 3')).toBeVisible()
    await page.getByLabel('Event name').fill('Salsa Social')

    // Location comes before the dates and is picked on its own full-screen page.
    await page.getByRole('button', { name: /^Location/ }).click()
    await page.getByLabel('Search for a place or address').fill('Berlin')
    await page.getByText('Berlin Center').click()
    await expect(page.getByRole('button', { name: /^Location Berlin Center$/ })).toBeVisible()

    // Native pickers, not a custom calendar widget.
    await page.getByLabel('Start', { exact: true }).fill('2026-07-01T20:00')
    await page.getByLabel('End', { exact: true }).fill('2026-07-01T23:00')

    // Repeat is a sub-page, and the sticky footer unmounts while it is open so
    // the sub-page owns the only primary action on screen.
    await page.getByRole('button', { name: /^Repeat Does not repeat$/ }).click()
    await expect(page.getByRole('button', { name: 'Submit Event' })).toHaveCount(0)
    await page.getByRole('button', { name: /^Weekly$/ }).click()
    await page.getByRole('button', { name: /^Done$/ }).click()
    await expect(page.getByRole('button', { name: /^Repeat Weekly$/ })).toBeVisible()

    await page.getByRole('button', { name: /^Next$/ }).click()

    // Step 2 — Details (pricing deliberately lives on step 3)
    await expect(page.getByText('Step 2 of 3')).toBeVisible()
    await expect(page.getByText('Free event')).toHaveCount(0)
    await page.getByRole('button', { name: 'Salsa', exact: true }).click()
    await page.getByRole('button', { name: 'Local', exact: true }).click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    // Step 3 — Publish
    await expect(page.getByText('Step 3 of 3')).toBeVisible()
    await expect(page.getByLabel("I'm going")).toBeChecked()
    // Pricing starts at "No pricing", not "Free event".
    await expect(page.getByRole('button', { name: /^Pricing No pricing$/ })).toBeVisible()

    // The promo editor is a full-page sub-state: Submit must not be reachable
    // from it, and its Done button only closes the editor.
    await page.getByRole('button', { name: /^Promo code Add a promo code$/ }).click()
    await expect(page.getByRole('button', { name: 'Submit Event' })).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Promo code' }).fill('MOVIDA10')
    await page.getByRole('button', { name: /^Done$/ }).click()
    expect(suggestionPayload).toBeNull()
    await expect(page.getByRole('button', { name: 'Promo code MOVIDA10' })).toBeVisible()

    await page.getByRole('button', { name: 'Submit Event' }).click()

    await expect(page.getByText('Your event is live and under review.')).toBeVisible()
    await expect.poll(() => suggestionPayload?.going).toBe(true)
    await expect.poll(() => suggestionPayload?.going_audience).toBe('friends')
    await expect.poll(() => suggestionPayload?.recurrence_rule).toMatch(/^RRULE:FREQ=WEEKLY/)
})

test('never scrolls horizontally at a 320px viewport', async ({ page }) => {
    await mockApi(page, () => { })
    await page.setViewportSize({ width: 320, height: 568 })

    const expectNoOverflow = async (label: string) => {
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, `${label} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0)
    }

    await page.goto('/?submit=1')
    await expect(page.getByRole('heading', { name: 'Suggest an event' })).toBeVisible()
    await expectNoOverflow('step 1')

    // Each recurrence mode is a page pushed on top of the mode list; Back pops
    // one level rather than dismissing the whole flow.
    const subPage = (title: string) => page.getByRole('dialog', { name: title })
    await page.getByRole('button', { name: /^Repeat / }).click()
    for (const mode of ['Weekly', 'Monthly', 'Yearly', 'Choose dates']) {
        await subPage('Repeat').getByRole('button', { name: new RegExp(`^${mode}$`) }).click()
        await expectNoOverflow(`repeat · ${mode}`)
        await subPage(mode).getByRole('button', { name: 'Back' }).click()
    }
    await subPage('Repeat').getByRole('button', { name: 'Close' }).click()

    await page.getByLabel('Event name').fill('A very long event name that should wrap instead of widening the page')
    await page.getByRole('button', { name: /^Location/ }).click()
    await page.getByLabel('Search for a place or address').fill('Berlin')
    await expectNoOverflow('location page')
    await page.getByText('Berlin Center').click()
    await page.getByLabel('Start', { exact: true }).fill('2026-07-01T20:00')
    await page.getByLabel('End', { exact: true }).fill('2026-07-01T23:00')
    await page.getByRole('button', { name: /^Next$/ }).click()

    await expect(page.getByText('Step 2 of 3')).toBeVisible()
    await expectNoOverflow('step 2')
    await page.getByRole('button', { name: 'Salsa', exact: true }).click()
    await page.getByRole('button', { name: 'Local', exact: true }).click()
    await page.getByRole('button', { name: /^Next$/ }).click()

    await expect(page.getByText('Step 3 of 3')).toBeVisible()
    await expectNoOverflow('step 3')

    await page.getByRole('button', { name: /^Pricing / }).click()
    await expectNoOverflow('pricing page')
    await subPage('Pricing').getByRole('button', { name: 'Close' }).click()

    await page.getByRole('button', { name: /^Promo code / }).click()
    await expectNoOverflow('promo code editor')
})
