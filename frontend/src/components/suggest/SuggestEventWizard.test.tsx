import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SuggestEventWizard from './SuggestEventWizard'
import { renderWithProviders } from '../../test/render'
import { server } from '../../test/server'
import { makeUser } from '../../test/handlers'

function setupTagGroups() {
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
            }),
        ),
    )
}

function setupSignedInUser() {
    server.use(http.get('*/api/auth/me', () => HttpResponse.json(makeUser())))
}

/** Fills Step 1 and advances to Step 2. Location comes before the dates. */
async function completeStep1(user: ReturnType<typeof renderWithProviders>['user']) {
    await user.type(screen.getByLabelText('Event name'), 'Salsa Social')

    await user.click(screen.getByRole('button', { name: /^Location/ }))
    await user.type(screen.getByLabelText('Search for a place or address'), 'Berlin')
    await user.click(await screen.findByText('Berlin Center'))

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-07-01T20:00' } })
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-07-01T23:00' } })
    await user.click(screen.getByRole('button', { name: 'Next' }))
}

/** Picks the required tags on Step 2 and advances to Step 3. */
async function completeStep2(user: ReturnType<typeof renderWithProviders>['user']) {
    await user.click(await screen.findByRole('button', { name: 'Salsa' }))
    await user.click(screen.getByRole('button', { name: 'Local' }))
    await user.click(screen.getByRole('button', { name: 'Next' }))
}

describe('SuggestEventWizard', () => {
    it('walks the three steps and submits', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventWizard onClose={() => { }} />)

        expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument()
        await completeStep1(user)
        expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument()
        await completeStep2(user)
        expect(screen.getByText(/Step 3 of 3/)).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Submit Event' }))
        expect(await screen.findByText(/Your suggestion is under review/)).toBeInTheDocument()
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
        setupTagGroups()
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

        await screen.findByText(/Your suggestion is under review/)
        expect(payload).not.toBeNull()
        expect(payload!.recurrence_rule).toMatch(/^RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=/)
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

        expect(screen.getByText('Who can see it')).toBeInTheDocument()
        await user.click(screen.getByRole('switch', { name: "I'm going" }))
        expect(screen.queryByText('Who can see it')).not.toBeInTheDocument()
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
        expect(screen.queryByText(/Your suggestion is under review/)).not.toBeInTheDocument()
    })
})
