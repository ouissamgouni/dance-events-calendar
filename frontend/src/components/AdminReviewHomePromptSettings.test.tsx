import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import AdminReviewHomePromptSettings from './AdminReviewHomePromptSettings'

describe('AdminReviewHomePromptSettings', () => {
    it('shows the 30-day funnel and saves an edited cap', async () => {
        const saved: Record<string, unknown>[] = []
        server.use(
            http.get('*/api/admin/review-prompt/stats', () => HttpResponse.json({
                days: 30, shown: 10, dismissed: 4, reviewed: 5, forced_shown: 2, forced_reviewed: 1,
                reviews_by_entry_point: [{ key: 'home-prompt', count: 5 }],
            })),
            http.put('*/api/settings', async ({ request }) => {
                saved.push((await request.json()) as Record<string, unknown>)
                return HttpResponse.json({})
            }),
        )
        const onMessage = vi.fn()
        render(<AdminReviewHomePromptSettings onMessage={onMessage} />)

        expect(await screen.findByText(/Shown 10 · dismissed 4 · reviewed 5 \(50%\)/)).toBeInTheDocument()
        expect(screen.getByText('Home prompt')).toBeInTheDocument()

        const cooldown = screen.getByLabelText('Cooldown (hours)')
        await userEvent.clear(cooldown)
        await userEvent.type(cooldown, '48{Enter}')
        await waitFor(() => expect(saved).toContainEqual({ review_home_prompt_cooldown_hours: 48 }))
    })

    it('shows both flags on by default and toggles similar events off', async () => {
        const saved: Record<string, unknown>[] = []
        server.use(
            http.get('*/api/admin/review-prompt/stats', () => HttpResponse.json({
                days: 30, shown: 0, dismissed: 0, reviewed: 0, forced_shown: 0, forced_reviewed: 0, reviews_by_entry_point: [],
            })),
            http.put('*/api/settings', async ({ request }) => {
                saved.push((await request.json()) as Record<string, unknown>)
                return HttpResponse.json({})
            }),
        )
        const onOpenFeatureFlags = vi.fn()
        render(<AdminReviewHomePromptSettings onMessage={vi.fn()} ratingsEnabled={false} onOpenFeatureFlags={onOpenFeatureFlags} />)

        const prompt = screen.getByRole('button', { name: 'Toggle Home review prompt' })
        const similar = screen.getByRole('button', { name: 'Toggle Similar events after review' })
        expect(prompt).toHaveAttribute('aria-pressed', 'true')
        expect(similar).toHaveAttribute('aria-pressed', 'true')

        await userEvent.click(similar)
        await waitFor(() => expect(saved).toContainEqual({ similar_events_enabled: false }))
        expect(similar).toHaveAttribute('aria-pressed', 'false')

        await userEvent.click(screen.getByRole('button', { name: 'Open feature flags' }))
        expect(onOpenFeatureFlags).toHaveBeenCalled()
    })
})
