import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import AppPrompts from './AppPrompts'
import BottomSheet from './BottomSheet'
import { makeUser } from '../test/handlers'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { clearHomeOverlays } from '../hooks/useHomeOverlays'
import { clearPeoplePromptSession } from '../hooks/usePeoplePrompt'

function track() {
    const calls = { review: 0, people: 0 }
    const pop1 = { handle: 'pop1', display_name: 'POP1', avatar_url: null, is_verified_organizer: false, is_admin_managed: false, mutual_friend_count: 0, mutual_friends_preview: [], followers_count: 0 }
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/social/me/suggestions', () =>
            HttpResponse.json({ items: [pop1], total: 1, friend_count: 0, trail_position: 'top' }),
        ),
        http.get('*/api/users/me/review-prompt', () => {
            calls.review += 1
            return HttpResponse.json({ prompt: null, forced: false, similar_count: 0, pending_total: 0 })
        }),
        http.get('*/api/social/me/people-prompt', () => {
            calls.people += 1
            return HttpResponse.json({
                show: true,
                forced: false,
                friend_count: 0,
                overlays_per_session: 1,
                items: [pop1],
                total: 1,
            })
        }),
    )
    return calls
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
    window.sessionStorage.clear()
    clearHomeOverlays()
    clearPeoplePromptSession()
})

describe('AppPrompts', () => {
    it('opens the people sheet on a browse route after the review check settles', async () => {
        const calls = track()
        renderWithProviders(<AppPrompts />, { routerEntries: ['/'] })
        expect(await screen.findByRole('dialog', { name: 'Build your tribe' }, { timeout: 4000 })).toBeInTheDocument()
        expect(calls.review).toBe(1)
        expect(calls.people).toBe(1)
    })

    it('never checks on excluded routes', async () => {
        const calls = track()
        renderWithProviders(<AppPrompts />, { routerEntries: ['/admin'] })
        await wait(2500)
        expect(calls.review).toBe(0)
        expect(calls.people).toBe(0)
    })

    it('waits on a deep-link landing', async () => {
        const calls = track()
        renderWithProviders(<AppPrompts />, { routerEntries: ['/u/someone'] })
        await wait(2500)
        expect(calls.review).toBe(0)
    })

    it('waits while another overlay is open', async () => {
        const calls = track()
        renderWithProviders(
            <>
                <BottomSheet title="Other" onClose={() => { }}>busy</BottomSheet>
                <AppPrompts />
            </>,
            { routerEntries: ['/'] },
        )
        await wait(2500)
        expect(calls.review).toBe(0)
        await waitFor(() => expect(screen.getByRole('dialog', { name: 'Other' })).toBeInTheDocument())
    })
})
