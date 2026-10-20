import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import HomeReviewPrompt from './HomeReviewPrompt'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { FeatureFlagsProvider } from '../context/FeatureFlagsContext'
import { REVIEW_PROMPT_SESSION_KEY } from '../hooks/useHomeReviewPrompt'

const prompt = {
    prompt: {
        event_id: 'evt-1',
        event_title: 'Rooftop Salsa',
        event_start: '2026-10-10T20:00:00Z',
        event_end: '2026-10-11T01:00:00Z',
        friend_proof: null,
    },
    forced: false,
    similar_count: 0,
    pending_total: 1,
}

function renderPrompt(userId = 'user-a') {
    return renderWithProviders(
        <FeatureFlagsProvider>
            <HomeReviewPrompt userId={userId} blocked={false} onReviewed={() => { }} />
        </FeatureFlagsProvider>,
    )
}

describe('HomeReviewPrompt', () => {
    afterEach(() => window.sessionStorage.clear())

    it('checks again when a different user signs in on the same tab', async () => {
        let promptRequests = 0
        server.use(
            http.get('*/api/users/me/review-prompt', () => {
                promptRequests += 1
                return HttpResponse.json({ ...prompt, prompt: null })
            }),
        )

        const first = renderPrompt('user-a')
        await waitFor(() => expect(promptRequests).toBe(1), { timeout: 3000 })
        expect(window.sessionStorage.getItem(REVIEW_PROMPT_SESSION_KEY)).toBe('user-a')
        first.unmount()

        renderPrompt('user-b')
        await waitFor(() => expect(promptRequests).toBe(2), { timeout: 3000 })
        expect(window.sessionStorage.getItem(REVIEW_PROMPT_SESSION_KEY)).toBe('user-b')
    })

    it('opens the wizard once per session and records shown + dismissed', async () => {
        const outcomes: string[] = []
        let promptRequests = 0
        server.use(
            http.get('*/api/tags', () => HttpResponse.json([])),
            http.get('*/api/events/:eventId', () => HttpResponse.json({
                event_id: 'evt-1', title: 'Rooftop Salsa', start: '2026-10-10T20:00:00Z', city: 'Lyon', location: null, tags: [],
            })),
            http.get('*/api/users/me/review-prompt', () => {
                promptRequests += 1
                return HttpResponse.json(prompt)
            }),
            http.post('*/api/users/me/review-prompt/:eventId/impression', async ({ request }) => {
                outcomes.push(((await request.json()) as { outcome: string }).outcome)
                return new HttpResponse(null, { status: 204 })
            }),
        )

        const { user, unmount } = renderPrompt()
        expect(await screen.findByRole('button', { name: 'Not now' }, { timeout: 3000 })).toBeInTheDocument()
        expect(window.sessionStorage.getItem(REVIEW_PROMPT_SESSION_KEY)).toBe('user-a')

        await user.click(screen.getByRole('button', { name: 'Not now' }))
        await waitFor(() => expect(outcomes).toEqual(['shown', 'dismissed']))
        expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
        unmount()

        renderPrompt()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(promptRequests).toBe(1)
    })
})
