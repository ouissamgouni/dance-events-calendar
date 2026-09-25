import { expect, test } from '@playwright/test';

const EVENT_ID = 'movida-schedule-e2e';

test('supports live program filters, details and an all-days plan', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-16T12:30:00Z'));
    await page.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/api/auth/me')) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user_id: 'user-1', email: 'dancer@example.com', name: 'Maya Dancer', handle: 'maya', is_admin: false, is_new_user: false, needs_onboarding: false, onboarded_at: '2026-01-01T00:00:00Z' }) });
            return;
        }
        if (path.endsWith('/api/settings')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    show_prices: false,
                    show_popularity: false,
                    show_ratings: true,
                    popularity_threshold: 10,
                    event_schedule_enabled: true,
                }),
            });
            return;
        }
        if (path.endsWith(`/api/events/${EVENT_ID}/schedule`)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    event_id: EVENT_ID,
                    timezone: 'Europe/Prague',
                    day_start_hour: 6,
                    days: ['2026-10-15', '2026-10-16'],
                    venues: [{ id: 1, name: 'Slovanský dům', address: 'Prague', sort_order: 0 }],
                    rooms: [{ id: 1, venue_id: 1, name: 'Grand Hall', color: 'amber', sort_order: 0 }],
                    levels: [{ id: 1, label: 'Open Level', notation: '*', sort_order: 0 }, { id: 2, label: 'Advanced', notation: '**', sort_order: 1 }],
                    activity_types: [{ id: 1, name: 'Workshop', color: 'blue', sort_order: 0 }],
                    sessions: [
                        { id: '10000000-0000-4000-8000-000000000000', title: 'Thursday Foundations', instructors: 'Maya', start: '2026-10-15T12:00:00Z', end: '2026-10-15T13:00:00Z', room_id: 1, venue_id: 1, level_id: 1, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false },
                        { id: '10000000-0000-4000-8000-000000000001', title: 'Shines / Partnerwork', instructors: 'Jemís & Dyanna', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', room_id: 1, venue_id: 1, level_id: 2, activity_type_id: 1, attendee_note: 'Bring dance shoes.', allow_plan: true, is_cancelled: false },
                    ],
                    version: 1,
                    published_at: '2026-09-01T12:00:00Z',
                }),
            });
            return;
        }
        if (path.endsWith(`/api/events/${EVENT_ID}/my-plan`)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    entries: [
                        { session_id: '10000000-0000-4000-8000-000000000000', status: 'active', session: { id: '10000000-0000-4000-8000-000000000000', title: 'Thursday Foundations', instructors: 'Maya', start: '2026-10-15T12:00:00Z', end: '2026-10-15T13:00:00Z', room_id: 1, venue_id: 1, level_id: 1, activity_type_id: 1, attendee_note: null, allow_plan: true, is_cancelled: false } },
                        { session_id: '10000000-0000-4000-8000-000000000001', status: 'active', session: { id: '10000000-0000-4000-8000-000000000001', title: 'Shines / Partnerwork', instructors: 'Jemís & Dyanna', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z', room_id: 1, venue_id: 1, level_id: 2, activity_type_id: 1, attendee_note: 'Bring dance shoes.', allow_plan: true, is_cancelled: false } },
                    ]
                }),
            });
            return;
        }
        if (path.endsWith(`/api/events/${EVENT_ID}`)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ event_id: EVENT_ID, calendar_id: 'calendar-1', title: 'Movida Weekend', description: null, location: 'Prague', city: 'Prague', country: 'Czechia', latitude: null, longitude: null, start: '2026-10-16T08:00:00Z', end: '2026-10-18T04:00:00Z', all_day: false, color: null, view_count: 0, price_min: null, price_max: null, price_currency: null, price_is_free: null, links: null, tags: [], schedule_published: true }),
            });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto(`/event/${EVENT_ID}/program`);

    await expect(page.getByRole('button', { name: /Shines \/ Partnerwork.*Now/ })).toBeVisible();
    await expect(page.getByLabel(/Current time/)).toBeVisible();
    await expect(page.getByRole('button', { name: '14:00' })).toBeVisible();
    await page.getByRole('button', { name: /Shines \/ Partnerwork/ }).click();
    await expect(page.getByText('Bring dance shoes.')).toBeVisible();
    await expect(page.getByText('14:00–15:00')).toBeVisible();
    await page.getByRole('dialog', { name: 'Session details' }).getByRole('button', { name: 'Close' }).click();

    await page.getByLabel('Search instructors').fill('Maya');
    await expect(page.getByRole('button', { name: /Shines \/ Partnerwork/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^My Plan/ }).click();
    await expect(page.getByText('Thursday Foundations')).toBeVisible();
    await expect(page.getByText('Shines / Partnerwork')).toBeVisible();
    await expect(page.getByLabel('Search instructors')).toHaveCount(0);
});
