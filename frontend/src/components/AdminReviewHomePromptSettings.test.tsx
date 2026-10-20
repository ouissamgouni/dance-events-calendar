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
})
