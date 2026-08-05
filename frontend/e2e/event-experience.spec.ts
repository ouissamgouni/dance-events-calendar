import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Event Quality Layer e2e smoke (Phase 1: capture, Phase 2: aggregate display).
// Fully route-mocked (no real backend needed), mirroring suggest-event.spec.ts.

const EVENT: Record<string, unknown> = {
    event_id: 'evt-experience-e2e',
    calendar_id: 'cal-1',
    title: 'Salsa Social — Share Your Experience',
    description: 'Test event for the Event Quality Layer.',
    location: 'Test Venue, Paris, France',
    latitude: 48.8566,
    longitude: 2.3522,
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

async function mockCommonRoutes(
    page: Page,
    opts: {
        ratingAggregate: Record<string, unknown>
        reviews?: Record<string, unknown>[]
        series?: Record<string, unknown> | null
        seriesReviews?: Record<string, unknown>[]
        event?: Record<string, unknown>
        onFeedback?: (body: Record<string, unknown>) => Record<string, unknown>
    },
) {
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

        if (path.endsWith(`/api/events/${EVENT.event_id}`)) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.event ?? EVENT) })
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
                body: JSON.stringify(opts.ratingAggregate),
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
                body: JSON.stringify({ items: opts.reviews ?? [], total: (opts.reviews ?? []).length }),
            })
            return
        }

        if (path.includes('/api/series/') && path.endsWith('/reviews')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    items: opts.seriesReviews ?? [],
                    total: (opts.seriesReviews ?? []).length,
                }),
            })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}/series`)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(opts.series ?? null),
            })
            return
        }

        if (path.endsWith(`/api/events/${EVENT.event_id}/feedback`) && req.method() === 'POST') {
            const body = req.postDataJSON() as Record<string, unknown>
            const rating = opts.onFeedback?.(body) ?? {
                id: 'rating-e2e-1',
                event_id: EVENT.event_id,
                overall_sentiment: body.overall_sentiment ?? 'great',
                aspect_scores: body.aspect_scores ?? {},
                aspect_tag_ids: body.aspect_tag_ids ?? [],
                audience_tag_ids: body.audience_tag_ids ?? [],
                comment: body.comment ?? null,
                comment_status: body.comment ? 'pending' : 'none',
                is_anonymous: false,
                status: 'approved',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
            }
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ rating }),
            })
            return
        }

        if (
            path.endsWith('/api/config/info') ||
            path.endsWith('/api/auth/attending-events') ||
            path.endsWith('/api/auth/saved-events') ||
            path.endsWith('/api/notifications/unread-count') ||
            path.startsWith('/api/notifications') ||
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

test('submits an adaptive experience (sentiment + comment)', async ({ page }) => {
    let feedbackBody: Record<string, unknown> | null = null
    await mockCommonRoutes(page, {
        ratingAggregate: { event_id: EVENT.event_id, count: 0, sentiment_distribution: {} },
        onFeedback: (body) => {
            feedbackBody = body
            return {
                id: 'rating-e2e-1',
                event_id: EVENT.event_id,
                overall_sentiment: body.overall_sentiment ?? 'great',
                aspect_scores: body.aspect_scores ?? {},
                aspect_tag_ids: body.aspect_tag_ids ?? [],
                audience_tag_ids: body.audience_tag_ids ?? [],
                comment: body.comment ?? null,
                comment_status: body.comment ? 'pending' : 'none',
                is_anonymous: false,
                status: 'approved',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
            }
        },
    })

    await page.goto(`/event/${EVENT.event_id}`)
    await expect(page.getByRole('heading', { name: EVENT.title as string })).toBeVisible()

    await page.getByRole('button', { name: /Be the first to review/i }).first().click()
    await page.getByRole('radio', { name: /Great/i }).click()

    // The review flow is a small wizard (sentiment → … → comment → identity),
    // advanced with "Continue"; the final step swaps in "Submit".
    const commentBox = page.getByPlaceholder(/Tell others about the event/i)
    for (let i = 0; i < 6 && !(await commentBox.isVisible()); i++) {
        await page.getByRole('button', { name: /^Continue$/ }).click()
    }
    await commentBox.fill('A solid night out with good music and a friendly crowd overall.')

    const submitBtn = page.getByRole('button', { name: /^Submit$/ })
    for (let i = 0; i < 6 && !(await submitBtn.isVisible()); i++) {
        await page.getByRole('button', { name: /^Continue$/ }).click()
    }
    await submitBtn.click()

    await expect(page.getByText('Thanks for your feedback!')).toBeVisible()
    expect(feedbackBody).toMatchObject({ overall_sentiment: 'great' })
})

test('shows the per-occurrence experience breakdown (Phase 2)', async ({ page }) => {
    await mockCommonRoutes(page, {
        ratingAggregate: {
            event_id: EVENT.event_id,
            count: 2,
            sentiment_distribution: { amazing: 1, great: 1, okay: 0, disappointing: 0, bad: 0 },
            aspects: [
                { aspect_slug: 'music', average: 4.5, count: 2 },
                { aspect_slug: 'crowd', average: 4, count: 1 },
            ],
            top_positive_tags: [{ tag_id: 1, slug: 'great-music', label: 'Great music', count: 2, aspect_slug: 'music' }],
            top_negative_tags: [],
            top_audience_tags: [],
        },
        reviews: [
            {
                id: 'rev-1',
                event_id: EVENT.event_id,
                event_title: EVENT.title,
                event_start: EVENT.start,
                overall_sentiment: 'amazing',
                comment: 'Amazing night!',
                aspect_tags: [],
                audience_tags: [],
                reviewer_label: 'Alice',
                created_at: '2026-01-01T00:00:00Z',
            },
        ],
    })

    await page.goto(`/event/${EVENT.event_id}`)
    await expect(page.getByRole('heading', { name: EVENT.title as string })).toBeVisible()

    await expect(page.getByText(/Amazing/).first()).toBeVisible()
    await expect(page.getByText(/Music/).first()).toBeVisible()
    await expect(page.getByText('People appreciated')).toBeVisible()
    await expect(page.getByText('Great music (2)')).toBeVisible()
})

test('shows the typical experience card for an edition in a series (Phase 4)', async ({ page }) => {
    await mockCommonRoutes(page, {
        ratingAggregate: { event_id: EVENT.event_id, count: 0, sentiment_distribution: {} },
        series: {
            series_id: 7,
            canonical_title: 'Salsa Social',
            edition_count: 10,
            reviewed_edition_count: 10,
            total_review_count: 146,
            average_mood: 3.6,
            positive_percentage: 75,
            mood_label: 'Well received',
            display_state: 'full',
            sentiment_distribution: {},
            aspects: [],
            top_positive_tags: [],
            top_negative_tags: [],
            top_audience_tags: [],
            editions: [],
        },
    })

    await page.goto(`/event/${EVENT.event_id}`)
    await expect(page.getByRole('heading', { name: EVENT.title as string })).toBeVisible()

    await expect(page.getByText('Typical experience')).toBeVisible()
    await expect(page.getByText(/Usually well received/)).toBeVisible()
    await expect(page.getByText('See other editions →')).toBeVisible()
})

test('upcoming edition with series history shows the full cross-edition experience (Phase 5)', async ({ page }) => {
    await mockCommonRoutes(page, {
        // Same event id, but the edition is in the future → not yet reviewable.
        event: { ...EVENT, start: '2026-12-01T20:00:00Z', end: '2026-12-01T23:00:00Z' },
        ratingAggregate: { event_id: EVENT.event_id, count: 0, sentiment_distribution: {} },
        series: {
            series_id: 7,
            canonical_title: 'Salsa Social',
            edition_count: 10,
            reviewed_edition_count: 9,
            total_review_count: 146,
            average_mood: 3.6,
            positive_percentage: 75,
            mood_label: 'Well received',
            display_state: 'full',
            sentiment_distribution: { amazing: 80, great: 30, okay: 20, disappointing: 10, bad: 6 },
            aspects: [{ aspect_slug: 'music', average: 4.2, count: 120 }],
            top_positive_tags: [{ tag_id: 1, slug: 'great-music', label: 'Great music', count: 90, aspect_slug: 'music' }],
            top_negative_tags: [],
            top_audience_tags: [],
            editions: [],
        },
        seriesReviews: [
            {
                id: 'sr-1',
                event_id: 'evt-prev-week-9',
                event_title: 'Salsa Social — Week 9',
                event_start: '2026-06-01T20:00:00Z',
                overall_sentiment: 'amazing',
                comment: 'Great as always, the DJ was on fire.',
                aspect_tags: [],
                audience_tags: [],
                reviewer_label: 'Alice',
                created_at: '2026-06-02T00:00:00Z',
            },
        ],
    })

    await page.goto(`/event/${EVENT.event_id}`)
    await expect(page.getByRole('heading', { name: EVENT.title as string })).toBeVisible()

    // Full cross-edition breakdown (pooled series roll-up), not just a summary.
    await expect(page.getByText(/hasn't taken place yet/)).toBeVisible()
    // The overall mood is presented as the series' "Typical experience" box,
    // not as this (unreviewable) edition's own headline.
    await expect(page.getByText('Typical experience')).toBeVisible()
    await expect(page.getByText(/Usually well received/)).toBeVisible()
    await expect(page.getByText('People appreciated')).toBeVisible()
    await expect(page.getByText('Great music (90)')).toBeVisible()
    // Each review links back to its own edition.
    await expect(page.getByText('From Salsa Social — Week 9 →')).toBeVisible()
})
