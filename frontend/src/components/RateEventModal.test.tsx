import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import RateEventModal from './RateEventModal'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'

function ratingResponse(body: Record<string, unknown>) {
    return {
        rating: {
            id: 'rating-1',
            event_id: 'evt-1',
            overall_sentiment: body.overall_sentiment ?? null,
            aspect_scores: body.aspect_scores ?? {},
            aspect_tag_ids: body.aspect_tag_ids ?? [],
            audience_tag_ids: body.audience_tag_ids ?? [],
            comment: body.comment ?? null,
            comment_status: body.comment ? 'pending' : 'none',
            is_anonymous: body.is_anonymous ?? false,
            status: 'approved',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
        },
    }
}

describe('RateEventModal', () => {
    it('submits with only an overall sentiment', async () => {
        // Empty aspect/audience/event tag groups → sentiment is the only required step.
        server.use(http.get('*/api/tags', () => HttpResponse.json([])))
        let submittedBody: Record<string, unknown> | null = null
        server.use(
            http.post('*/api/events/:eventId/feedback', async ({ request }) => {
                submittedBody = (await request.json()) as Record<string, unknown>
                return HttpResponse.json(ratingResponse(submittedBody), { status: 201 })
            }),
        )

        const { user } = renderWithProviders(
            <RateEventModal
                eventId="evt-1"
                initialRating={null}
                onClose={() => { }}
                onSubmitted={() => { }}
            />,
        )

        await user.click(screen.getByRole('radio', { name: /Amazing/i }))
        // Wizard: intro → comment → identity, then submit.
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Submit/i }))

        expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument()
        expect(submittedBody).toMatchObject({ overall_sentiment: 'amazing' })
    })

    it('requires a sentiment before continuing', async () => {
        server.use(http.get('*/api/tags', () => HttpResponse.json([])))
        const { user } = renderWithProviders(
            <RateEventModal
                eventId="evt-1"
                initialRating={null}
                onClose={() => { }}
                onSubmitted={() => { }}
            />,
        )

        // Continue is disabled until a sentiment is chosen.
        expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled()

        await user.click(screen.getByRole('radio', { name: /Bad/i }))
        expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled()
    })

    it('resets aspect selections when the headline mood changes', async () => {
        const aspectGroup = {
            id: 1,
            slug: 'music',
            label: 'Music',
            ordinal: 0,
            enabled: true,
            scope: 'aspect',
            allow_multiple: true,
            color: '#f59e0b',
            condition_tag_slugs: [],
            tags: [
                { id: 10, group_id: 1, slug: 'great-dj', label: 'Great DJ', ordinal: 0, polarity: 'positive' },
            ],
        }
        server.use(
            http.get('*/api/tags', ({ request }) => {
                const scope = new URL(request.url).searchParams.get('scope')
                if (scope === 'aspect') return HttpResponse.json([aspectGroup])
                return HttpResponse.json([])
            }),
        )

        const { user } = renderWithProviders(
            <RateEventModal
                eventId="evt-1"
                initialRating={null}
                onClose={() => { }}
                onSubmitted={() => { }}
            />,
        )

        await user.click(screen.getByRole('radio', { name: /Amazing/i }))
        // Select the Music aspect → chip shows a checkmark.
        await user.click(await screen.findByRole('button', { name: 'Music' }))
        expect(screen.getByRole('button', { name: '✓ Music' })).toBeInTheDocument()

        // Changing the headline mood clears the selection (fresh review).
        await user.click(screen.getByRole('radio', { name: /Okay/i }))
        expect(screen.queryByRole('button', { name: '✓ Music' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Music' })).toBeInTheDocument()
    })

    it('maps aspect mood buttons to a 1–5 score (Great → 4)', async () => {
        const aspectGroup = {
            id: 1,
            slug: 'music',
            label: 'Music',
            ordinal: 0,
            enabled: true,
            scope: 'aspect',
            allow_multiple: true,
            color: '#f59e0b',
            condition_tag_slugs: [],
            tags: [
                { id: 10, group_id: 1, slug: 'great-dj', label: 'Great DJ', ordinal: 0, polarity: 'positive' },
            ],
        }
        let submittedBody: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/tags', ({ request }) => {
                const scope = new URL(request.url).searchParams.get('scope')
                if (scope === 'aspect') return HttpResponse.json([aspectGroup])
                return HttpResponse.json([])
            }),
            http.post('*/api/events/:eventId/feedback', async ({ request }) => {
                submittedBody = (await request.json()) as Record<string, unknown>
                return HttpResponse.json(ratingResponse(submittedBody), { status: 201 })
            }),
        )

        const { user } = renderWithProviders(
            <RateEventModal
                eventId="evt-1"
                initialRating={null}
                onClose={() => { }}
                onSubmitted={() => { }}
            />,
        )

        await user.click(screen.getByRole('radio', { name: /Amazing/i }))
        await user.click(await screen.findByRole('button', { name: 'Music' }))
        // Continue onto the Music aspect page and rate it "Great" (→ 4).
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('radio', { name: /Great/i }))
        // Continue through comment and identity, then submit.
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Submit/i }))

        expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument()
        expect(submittedBody).toMatchObject({ aspect_scores: { music: 4 } })
    })

    it('collects one event-size tag without treating size as a rated aspect', async () => {
        const eventSizeGroup = {
            id: 2,
            slug: 'event-size',
            label: 'Event size',
            ordinal: 108,
            enabled: true,
            scope: 'aspect',
            allow_multiple: false,
            color: '#f59e0b',
            condition_tag_slugs: [],
            tags: [
                { id: 20, group_id: 2, slug: 'small', label: 'Small (50-200)', ordinal: 0, polarity: 'neutral', enabled: true },
                { id: 21, group_id: 2, slug: 'large', label: 'Large (500-2,000)', ordinal: 1, polarity: 'neutral', enabled: true },
            ],
        }
        let submittedBody: Record<string, unknown> | null = null
        server.use(
            http.get('*/api/tags', ({ request }) => {
                const scope = new URL(request.url).searchParams.get('scope')
                return HttpResponse.json(scope === 'aspect' ? [eventSizeGroup] : [])
            }),
            http.post('*/api/events/:eventId/feedback', async ({ request }) => {
                submittedBody = (await request.json()) as Record<string, unknown>
                return HttpResponse.json(ratingResponse(submittedBody), { status: 201 })
            }),
        )

        const { user } = renderWithProviders(
            <RateEventModal eventId="evt-1" initialRating={null} onClose={() => { }} onSubmitted={() => { }} />,
        )

        await user.click(screen.getByRole('radio', { name: /Amazing/i }))
        expect(screen.queryByRole('button', { name: 'Event size' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        expect(await screen.findByRole('heading', { name: 'About how many people attended?' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Not sure / Skip' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('radio', { name: 'Large (500-2,000)' }))
        expect(screen.getByRole('radio', { name: /Large \(500-2,000\)/ })).toHaveAttribute('aria-checked', 'true')
        await user.click(screen.getByRole('radio', { name: /Large \(500-2,000\)/ }))
        expect(screen.getByRole('radio', { name: /Large \(500-2,000\)/ })).toHaveAttribute('aria-checked', 'false')
        await user.click(screen.getByRole('radio', { name: 'Large (500-2,000)' }))
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        await user.click(screen.getByRole('button', { name: /Submit/i }))

        expect(await screen.findByText('Thanks for your feedback!')).toBeInTheDocument()
        expect(submittedBody).toMatchObject({ aspect_scores: {}, aspect_tag_ids: [21] })
    })

    it('omits the event-size step when the review size flag is disabled', async () => {
        const eventSizeGroup = {
            id: 2,
            slug: 'event-size',
            label: 'Event size',
            ordinal: 108,
            enabled: true,
            scope: 'aspect',
            allow_multiple: false,
            color: '#f59e0b',
            condition_tag_slugs: [],
            tags: [
                { id: 20, group_id: 2, slug: 'small', label: 'Small (50-200)', ordinal: 0, polarity: 'neutral', enabled: true },
            ],
        }
        let settingsRequested = false
        server.use(
            http.get('*/api/settings', () => {
                settingsRequested = true
                return HttpResponse.json({ event_review_size_step_enabled: false })
            }),
            http.get('*/api/tags', ({ request }) => {
                const scope = new URL(request.url).searchParams.get('scope')
                return HttpResponse.json(scope === 'aspect' ? [eventSizeGroup] : [])
            }),
        )

        const { user } = renderWithProviders(
            <FeatureFlagsProvider>
                <RateEventModal eventId="evt-1" initialRating={null} onClose={() => { }} onSubmitted={() => { }} />
            </FeatureFlagsProvider>,
        )
        await waitFor(() => expect(settingsRequested).toBe(true))
        await waitFor(() => expect(screen.queryByText('About how many people attended?')).not.toBeInTheDocument())

        await user.click(screen.getByRole('radio', { name: /Amazing/i }))
        await user.click(screen.getByRole('button', { name: /Continue/i }))
        expect(await screen.findByRole('heading', { name: 'You wanna say something?' })).toBeInTheDocument()
    })
})
