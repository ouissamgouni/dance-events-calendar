import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import SuggestEventModal from './SuggestEventModal'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

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
                for_you_rail_enabled: false,
                your_next_events_rail_enabled: true,
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

describe('SuggestEventModal', () => {
    it('requires a validated location and required tags before submission', async () => {
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventModal onClose={() => { }} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
        expect(dateInputs.length).toBeGreaterThanOrEqual(2)
        await user.type(dateInputs[0], '2026-07-01T20:00')
        await user.type(dateInputs[1], '2026-07-01T23:00')
        await user.type(screen.getByPlaceholderText('Type an address…'), 'Berlin')
        const locationSuggestion = await screen.findByText('Berlin Center')
        await user.click(locationSuggestion)
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Local' }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Submit/i }))

        expect(await screen.findByText('Thank you! Your suggestion is under review.')).toBeInTheDocument()
    })

    it('defaults Going on for signed-in users', async () => {
        setupSignedInUser()
        setupTagGroups()
        const { user } = renderWithProviders(<SuggestEventModal onClose={() => { }} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
        expect(dateInputs.length).toBeGreaterThanOrEqual(2)
        await user.type(dateInputs[0], '2026-07-01T20:00')
        await user.type(dateInputs[1], '2026-07-01T23:00')
        await user.type(screen.getByPlaceholderText('Type an address…'), 'Berlin')
        const locationSuggestion = await screen.findByText('Berlin Center')
        await user.click(locationSuggestion)
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Local' }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))

        expect(screen.getByLabelText(/Mark me going by default/i)).toBeChecked()
    })

    it('surfaces the server error message when submission fails', async () => {
        setupTagGroups()
        server.use(
            http.post('*/api/suggestions', () =>
                HttpResponse.json({ detail: 'Event already exists' }, { status: 409 }),
            ),
        )

        const { user } = renderWithProviders(<SuggestEventModal onClose={() => { }} />)

        await user.type(screen.getByPlaceholderText('Event name'), 'Salsa Social')
        const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')
        expect(dateInputs.length).toBeGreaterThanOrEqual(2)
        await user.type(dateInputs[0], '2026-07-01T20:00')
        await user.type(dateInputs[1], '2026-07-01T23:00')
        await user.type(screen.getByPlaceholderText('Type an address…'), 'Berlin')
        const locationSuggestion = await screen.findByText('Berlin Center')
        await user.click(locationSuggestion)
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: 'Salsa' }))
        await user.click(screen.getByRole('button', { name: 'Local' }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Next/i }))
        await user.click(screen.getByRole('button', { name: /Submit/i }))

        expect(await screen.findByText('Event already exists')).toBeInTheDocument()
        expect(screen.queryByText('Thank you! Your suggestion is under review.')).not.toBeInTheDocument()
    })
})
