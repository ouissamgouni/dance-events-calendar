import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SuggestEventWizard from './SuggestEventWizard'
import { renderWithProviders } from '../../test/render'
import { server } from '../../test/server'
import { makeUser } from '../../test/handlers'

vi.mock('../EventModal', () => ({
    default: ({ event, onClose }: { event: { title: string }; onClose: () => void }) => (
        <div role="dialog" aria-label="Event preview">
            {event.title}
            <button type="button" onClick={onClose}>Close preview</button>
        </div>
    ),
}))

function setupTagGroups(settings: Record<string, unknown> = {}) {
    server.use(
        http.get('*/api/tags', () =>
            HttpResponse.json([
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
                {
                    id: 3,
                    slug: 'format',
                    label: 'Format',
                    color: '#6b7280',
                    ordinal: 3,
                    allow_multiple: true,
                    enabled: true,
                    onboarding_eligible: false,
                    scope: 'event',
                    tags: [
                        {
                            id: 301,
                            slug: 'social',
                            label: 'Social',
                            color: '#6b7280',
                            ordinal: 1,
                            group_slug: 'format',
                            group_label: 'Format',
                            group_color: '#6b7280',
                            enabled: true,
                            is_hero_filter: false,
                            hero_ordinal: null,
                        },
                    ],
                },
            ]),
        ),
        http.get('*/api/settings', () =>
            HttpResponse.json({
                since_date: '2025-01-01',
                sync_since_date: '2025-01-01',
                sync_interval_minutes: 60,
                auto_sync_enabled: true,
                auto_sync_mode: 'incremental',
                show_prices: false,
                show_popularity: true,
                show_ratings: false,
                popularity_threshold: 10,
                following_badge_enabled: false,
                unseen_state_enabled: false,
                trending_enabled: true,
                trending_banner_enabled: true,
                trending_window_days: 30,
                trending_floor_going: 3,
                trending_top_n: 3,
                trending_top_percent: 100,
                event_color_bar_color: '#64748b',
                tag_sort_mode: 'group',
                default_explorer_period: 'next_3_months',
                promo_codes_enabled: false,
                organizer_claims_enabled: false,
                suggest_event_required_dance_group_id: 1,
                suggest_event_required_reach_group_id: 2,
                tag_as_badge_enabled: false,
                event_reminders_enabled: true,
                activity_digest_email_enabled: true,
                interest_match_notifications_enabled: true,
                web_push_enabled: false,
                reminder_lead_hours: 24,
                activity_digest_schedule: 'tue,fri @ 09:00',
                interest_match_max_events_per_email: 10,
                ...settings,
            }),
        ),
    )
}

function setupSignedInUser() {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser())))
}

/** Fills Step 1 and advances to Step 2. Location comes before the dates. */
async function completeStep1(user: ReturnType<typeof renderWithProviders>['user'], day = '2026-07-01') {
    await user.type(screen.getByLabelText('Event name'), 'Salsa Social')

    await user.click(screen.getByRole('button', { name: /^Location/ }))
    await user.type(screen.getByLabelText('Search for a place or address'), 'Berlin')
    await user.click(await screen.findByText('Berlin Center'))

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: `${day}T20:00` } })
    fireEvent.change(screen.getByLabelText('End'), { target: { value: `${day}T23:00` } })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    // Step 1 checks for look-alike events before moving on.
    await screen.findByText(/Step 2 of 3|Is it one of these/)
}

/** Picks the required tags on Step 2 and advances to Step 3. */
async function completeStep2(user: ReturnType<typeof renderWithProviders>['user']) {
    await user.click(await screen.findByRole('button', { name: 'Salsa' }))
    await user.click(screen.getByRole('button', { name: 'Local' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
}

describe('SuggestEventWizard', () => {
    // Adding an event requires an account.
    beforeEach(() => setupSignedInUser())

    it('asks anonymous visitors to sign in first', async () => {
        server.use(http.get('*/api/auth/me', () => HttpResponse.json(null, { status: 401 })))
        const onClose = vi.fn()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={onClose} />)

        expect(await screen.findByRole('dialog', { name: 'Sign in to add an event' })).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fsuggest')
        await user.click(screen.getByRole('button', { name: 'Not now' }))
        expect(onClose).toHaveBeenCalled()
    })

    describe('suggesting a change', () => {
        const liveEvent = (overrides: Record<string, unknown> = {}) => ({
            event_id: 'ev-1',
            calendar_id: 'src',
            title: 'Salsa Friday',
            description: 'Weekly social',
            location: 'Studio A',
            latitude: 52.5,
            longitude: 13.4,
            start: '2099-07-03T18:00:00Z',
            end: '2099-07-03T21:00:00Z',
            all_day: false,
            timezone: 'Europe/Berlin',
            color: null,
            view_count: 0,
            price_min: null,
            price_max: null,
            price_currency: null,
            price_is_free: null,
            links: [],
            tags: [],
            ...overrides,
        })

        it('sends only the fields the user changed', async () => {
            setupTagGroups()
            let payload: Record<string, unknown> | null = null
            server.use(
                http.get('*/api/events/ev-1', () => HttpResponse.json(liveEvent())),
                http.post('*/api/events/ev-1/changes', async ({ request }) => {
                    payload = (await request.json()) as Record<string, unknown>
                    return HttpResponse.json({ id: 1, event_id: 'ev-1', source: 'user', status: 'pending', changes: {}, created_at: '', decided_at: null }, { status: 201 })
                }),
            )
            const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} changeEventId="ev-1" />)

            const title = await screen.findByLabelText('Event name')
            expect(title).toHaveValue('Salsa Friday')
            expect(screen.getByRole('heading', { name: 'Suggest a change' })).toBeInTheDocument()
            expect(screen.queryByRole('button', { name: /^Repeat/ })).not.toBeInTheDocument()
            await user.clear(title)
            await user.type(title, 'Salsa Friday Social')
            await user.click(screen.getByRole('button', { name: 'Next' }))
            await user.click(await screen.findByRole('button', { name: 'Next' }))
            expect(screen.queryByRole('switch', { name: 'Share publicly' })).not.toBeInTheDocument()
            await user.click(screen.getByRole('button', { name: 'Send suggestion' }))

            expect(await screen.findByText('Suggestion sent')).toBeInTheDocument()
            expect(payload).toEqual({ title: 'Salsa Friday Social' })
        })

        it('sends the organizer edit for review', async () => {
            setupTagGroups()
            server.use(
                http.get('*/api/events/ev-1', () =>
                    HttpResponse.json(liveEvent({ organizer: { user_id: 'user-1', handle: 'dev', display_name: 'Dev', avatar_url: null, is_verified_organizer: true } })),
                ),
                http.post('*/api/events/ev-1/changes', () =>
                    HttpResponse.json({ id: 1, event_id: 'ev-1', source: 'organizer', status: 'pending', changes: {}, created_at: '', decided_at: null }, { status: 201 }),
                ),
            )
            const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} changeEventId="ev-1" />)

            const title = await screen.findByLabelText('Event name')
            expect(screen.getByRole('heading', { name: 'Edit event' })).toBeInTheDocument()
            await user.type(title, '!')
            await user.click(screen.getByRole('button', { name: 'Next' }))
            await user.click(await screen.findByRole('button', { name: 'Next' }))
            await user.click(screen.getByRole('button', { name: 'Submit for review' }))

            expect(await screen.findByText('Changes sent for review')).toBeInTheDocument()
        })
    })

    it('Discard closes the wizard, not just the confirmation', async () => {
        setupTagGroups()
        const onClose = vi.fn()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={onClose} />)
        await user.type(screen.getByLabelText('Event name'), 'Salsa Social')

        await user.click(screen.getByRole('button', { name: 'Close' }))
        await user.click(await screen.findByRole('button', { name: 'Discard' }))

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
        expect(screen.queryByText('Discard this event?')).not.toBeInTheDocument()
    })

    it('offers matching events before adding a duplicate', async () => {
        setupTagGroups()
        server.use(
            http.get('*/api/suggestions/similar', () =>
                HttpResponse.json([
                    {
                        event_id: 'evt-existing',
                        title: 'Salsa Social Berlin',
                        start: '2026-07-01T18:00:00Z',
                        end: '2026-07-01T21:00:00Z',
                        all_day: false,
                        location: 'Club Havana',
                    },
                ]),
            ),
            http.get('*/api/events/evt-existing', () =>
                HttpResponse.json({ event_id: 'evt-existing', title: 'Salsa Social Berlin' }),
            ),
        )
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)

        expect(await screen.findByText('Is it one of these?')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Salsa Social Berlin/ }))
        const preview = await screen.findByRole('dialog', { name: 'Event preview' })
        await user.click(within(preview).getByRole('button', { name: 'Close preview' }))
        expect(screen.queryByRole('dialog', { name: 'Event preview' })).not.toBeInTheDocument()
        expect(screen.getByText('Is it one of these?')).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'None of these, continue' }))

        expect(await screen.findByRole('button', { name: 'Salsa' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Back' }))
        await user.click(await screen.findByRole('button', { name: 'Next' }))
        // Already checked for this title and date, so it goes straight on.
        expect(await screen.findByRole('button', { name: 'Salsa' })).toBeInTheDocument()
    })
    it('walks the three steps and submits', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument()
        await completeStep1(user)
        expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument()
        await completeStep2(user)
        expect(screen.getByText(/Step 3 of 3/)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Submit Event' }))
        expect(await screen.findByText(/Only you can see it/)).toBeInTheDocument()
    })

    it('blocks Step 2 until the required tags are picked and reports why', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await completeStep1(user)
        await user.click(await screen.findByRole('button', { name: 'Next' }))

        expect(await screen.findByText(/Pick at least one dance style/i)).toBeInTheDocument()
        expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument()
    })

    it('marks the blocking field invalid and focuses it instead of a footer message', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await user.click(screen.getByRole('button', { name: 'Next' }))

        const title = screen.getByLabelText('Event name')
        expect(await screen.findByText('Add an event name.')).toBeInTheDocument()
        expect(title).toHaveAttribute('aria-invalid', 'true')
        await waitFor(() => expect(title).toHaveFocus())
        expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument()
    })

    it('clears the field error as soon as the user edits it', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await user.click(screen.getByRole('button', { name: 'Next' }))
        expect(await screen.findByText('Add an event name.')).toBeInTheDocument()

        await user.type(screen.getByLabelText('Event name'), 'Salsa Social')

        expect(screen.queryByText('Add an event name.')).not.toBeInTheDocument()
        expect(screen.getByLabelText('Event name')).not.toHaveAttribute('aria-invalid')
    })

    it('keeps Step 1 input when navigating back from Step 2', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await completeStep1(user)
        await user.click(screen.getByRole('button', { name: 'Back' }))

        expect(screen.getByLabelText('Event name')).toHaveValue('Salsa Social')
        expect(screen.getByLabelText('Start')).toHaveValue('2026-07-01T20:00')
    })

    it('hides Submit Event while the promo page is open and Done does not submit', async () => {
        setupTagGroups({ promo_codes_enabled: true })
        let submitted = false
        server.use(
            http.post('*/api/suggestions', () => {
                submitted = true
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)
        await completeStep2(user)

        await user.click(screen.getByRole('button', { name: /^Promo code/ }))
        expect(screen.queryByRole('button', { name: 'Submit Event' })).not.toBeInTheDocument()

        await user.type(screen.getByRole('textbox', { name: 'Promo code' }), 'SALSA10')
        await user.click(screen.getByRole('button', { name: 'Done' }))

        expect(submitted).toBe(false)
        expect(screen.getByRole('button', { name: 'Submit Event' })).toBeInTheDocument()
        expect(screen.getByText('SALSA10')).toBeInTheDocument()
    })

    it('sends the weekly recurrence rule chosen on the Repeat page', async () => {
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)
        await user.click(screen.getByRole('button', { name: 'Back' }))

        await user.click(screen.getByRole('button', { name: /^Repeat/ }))
        await user.click(screen.getByRole('button', { name: 'Weekly' }))
        await user.click(screen.getByRole('button', { name: 'Done' }))

        await user.click(screen.getByRole('button', { name: 'Next' }))
        await completeStep2(user)
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/once a curator makes it public/)
        expect(payload).not.toBeNull()
        expect(payload!.share_publicly).toBe(true)
        expect(payload!.recurrence_rule).toMatch(/^RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=/)
    })

    it('sends an all-day event as dates with an exclusive end', async () => {
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)
        await user.click(screen.getByRole('button', { name: 'Back' }))
        await user.click(screen.getByRole('switch', { name: 'All day' }))
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-07-03' } })
        await user.click(screen.getByRole('button', { name: 'Next' }))
        await completeStep2(user)
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/Only you can see it/)
        expect(payload).toMatchObject({ start: '2026-07-01', end: '2026-07-04', all_day: true })
    })

    it('reads the typed times in the venue time zone', async () => {
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/suggestions/geocode', () =>
                HttpResponse.json([
                    { display_name: 'Lisbon Center', latitude: 38.72, longitude: -9.14, timezone: 'Europe/Lisbon' },
                ]),
            ),
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await user.type(screen.getByLabelText('Event name'), 'Salsa Social')
        await user.click(screen.getByRole('button', { name: /^Location/ }))
        await user.type(screen.getByLabelText('Search for a place or address'), 'Lisbon')
        await user.click(await screen.findByText('Lisbon Center'))
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-07-01T20:00' } })
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-07-01T23:00' } })
        expect(screen.getByText(/Times in Lisbon time/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Next' }))
        await completeStep2(user)
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/Only you can see it/)
        // 20:00 in Lisbon (WEST, UTC+1) whatever the browser's zone.
        expect(payload).toMatchObject({
            start: '2026-07-01T19:00:00.000Z',
            end: '2026-07-01T22:00:00.000Z',
            event_timezone: 'Europe/Lisbon',
        })
    })

    it('defaults Going on for signed-in users', async () => {
        setupSignedInUser()
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await completeStep1(user)
        await completeStep2(user)

        expect(screen.getByRole('switch', { name: "I'm going" })).toBeChecked()
    })

    it('hides the attendance audience while I am going is off', async () => {
        setupSignedInUser()
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await completeStep1(user)
        await completeStep2(user)

        expect(screen.getByText('Who can see it ?')).toBeInTheDocument()
        await user.click(screen.getByRole('switch', { name: "I'm going" }))
        expect(screen.queryByText('Who can see it ?')).not.toBeInTheDocument()
    })

    it('defaults pricing to No pricing and keeps Submit Event off the pricing page', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        await completeStep1(user)
        await completeStep2(user)

        expect(screen.getByText('No pricing')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /^Pricing/ }))
        expect(screen.queryByRole('button', { name: 'Submit Event' })).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Done' }))
        expect(screen.getByRole('button', { name: 'Submit Event' })).toBeInTheDocument()
    })

    it('surfaces the server error message when submission fails', async () => {
        setupTagGroups()
        server.use(
            http.post('*/api/suggestions', () =>
                HttpResponse.json({ detail: 'Event already exists' }, { status: 409 }),
            ),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)
        await completeStep2(user)
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        expect(await screen.findByText('Event already exists')).toBeInTheDocument()
        expect(screen.queryByText(/Only you can see it/)).not.toBeInTheDocument()
    })

    it('uploads a cover photo and submits its key', async () => {
        setupSignedInUser()
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions/images', () =>
                HttpResponse.json({
                    image_key: 'suggestions/u1/abc',
                    image_thumb_url: 'https://cdn.test/suggestions/u1/abc/thumb.webp',
                }),
            ),
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user)

        await user.click(await screen.findByRole('button', { name: /^Cover photo/ }))
        expect(screen.queryByRole('button', { name: 'Submit Event' })).not.toBeInTheDocument()
        await user.upload(
            screen.getByTestId('suggest-image-file'),
            new File(['img'], 'poster.png', { type: 'image/png' }),
        )
        expect(await screen.findByAltText('Cover photo preview')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Done' }))

        await completeStep2(user)
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/Only you can see it/)
        expect(payload!.image_key).toBe('suggestions/u1/abc')
        // A past one-off event can't go public.
        expect(payload!.share_publicly).toBe(false)
    })

    it('shares an upcoming event publicly by default', async () => {
        setupSignedInUser()
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user, '2099-07-01')
        await completeStep2(user)
        expect(screen.getByRole('switch', { name: 'Share publicly' })).toBeChecked()
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/once a curator makes it public/)
        expect(payload!.share_publicly).toBe(true)
    })

    it('keeps the event private when Share publicly is turned off', async () => {
        setupSignedInUser()
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'under review' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user, '2099-07-01')
        await completeStep2(user)
        await user.click(screen.getByRole('switch', { name: 'Share publicly' }))
        expect(screen.getByText('Only you will see this event.')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await screen.findByText(/Only you can see it/)
        expect(payload!.share_publicly).toBe(false)
    })

    it('keeps a past event private and hides the promo row when promo codes are off', async () => {
        setupSignedInUser()
        setupTagGroups()

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user, '2020-07-01')
        await completeStep2(user)

        expect(screen.getByRole('switch', { name: 'Share publicly' })).toBeDisabled()
        expect(screen.getByText('Past events stay private — only you will see it.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^Promo code/ })).not.toBeInTheDocument()
    })

    it('sends a tag that does not exist yet as a new-tag request', async () => {
        setupSignedInUser()
        setupTagGroups()
        let payload: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/suggestions', async ({ request }) => {
                payload = (await request.json()) as Record<string, unknown>
                return HttpResponse.json({ message: 'ok' }, { status: 201 })
            }),
        )

        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)
        await completeStep1(user, '2099-07-01')
        await user.click(await screen.findByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Local' }))
        await user.click(screen.getByRole('button', { name: 'Add more tags' }))
        await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'Rooftop')
        await user.click(within(screen.getByTestId('request-new-tag')).getByRole('button', { name: '+ Format' }))
        await user.click(screen.getByRole('button', { name: 'Done' }))
        await user.click(screen.getByRole('button', { name: 'Next' }))
        await user.click(screen.getByRole('button', { name: 'Submit Event' }))

        await waitFor(() => expect(payload).not.toBeNull())
        expect(payload!.suggested_new_tags).toEqual([{ free_text: 'Rooftop', group_slug: 'format' }])
    })

    describe('edit mode', () => {
        const ownSuggestion = {
            id: 'sug-1',
            status: 'pending',
            edit_locked: false,
            can_edit: true,
            title: 'Salsa Socail',
            description: null,
            location: 'Berlin Center',
            links: null,
            latitude: 52.52,
            longitude: 13.4,
            start: '2026-07-01T18:00:00Z',
            end: '2026-07-01T21:00:00Z',
            all_day: false,
            recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;COUNT=4',
            recurrence_dates: null,
            suggested_tag_ids: [101, 201],
            price_min: null,
            price_max: null,
            price_currency: null,
            price_is_free: true,
            image_key: null,
            image_thumb_url: null,
            created_event_id: 'suggestion-sug-1',
            created_at: '2026-06-01T10:00:00Z',
        }

        it('prefills the saved event and PATCHes the changes', async () => {
            setupSignedInUser()
            setupTagGroups()
            let payload: Record<string, unknown> | null = null
            server.use(
                http.get('*/api/me/suggestions/sug-1', () => HttpResponse.json(ownSuggestion)),
                http.patch('*/api/me/suggestions/sug-1', async ({ request }) => {
                    payload = (await request.json()) as Record<string, unknown>
                    return HttpResponse.json({ ...ownSuggestion, title: 'Salsa Social' })
                }),
            )

            const { user } = renderWithProviders(
                <SuggestEventWizard suggestionId="sug-1" onClose={() => { }} />,
            )

            const title = await screen.findByLabelText('Event name')
            expect(title).toHaveValue('Salsa Socail')
            expect(screen.getByRole('heading', { name: 'Edit event' })).toBeInTheDocument()
            await user.clear(title)
            await user.type(title, 'Salsa Social')
            await user.click(screen.getByRole('button', { name: 'Next' }))
            await user.click(await screen.findByRole('button', { name: 'Next' }))

            expect(screen.queryByRole('button', { name: /^Promo code/ })).not.toBeInTheDocument()
            await user.click(screen.getByRole('button', { name: 'Save changes' }))

            expect(await screen.findByText('Changes saved')).toBeInTheDocument()
            expect(payload!.title).toBe('Salsa Social')
            expect(payload!.recurrence_rule).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;COUNT=4')
            expect(payload!.suggested_tag_ids).toEqual([101, 201])
            expect(payload).not.toHaveProperty('going')
        })

        it('explains why a locked event cannot be edited', async () => {
            setupSignedInUser()
            setupTagGroups()
            server.use(
                http.get('*/api/me/suggestions/sug-1', () =>
                    HttpResponse.json({ ...ownSuggestion, edit_locked: true, can_edit: false }),
                ),
            )

            renderWithProviders(<SuggestEventWizard suggestionId="sug-1" onClose={() => { }} />)

            expect(await screen.findByText(/An admin has locked this event/)).toBeInTheDocument()
        })
    })
})
