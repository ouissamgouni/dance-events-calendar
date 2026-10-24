import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PeopleSuggestionsTrail from './PeopleSuggestionsTrail'
import HomePeoplePrompt from './HomePeoplePrompt'
import { usePeopleSuggestions } from '../hooks/usePeopleSuggestions'
import { clearHomeOverlays, markHomeOverlayShown } from '../hooks/useHomeOverlays'
import { clearPeoplePromptSession } from '../hooks/usePeoplePrompt'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

function item(handle: string) {
    return {
        handle,
        display_name: handle.toUpperCase(),
        avatar_url: null,
        is_verified_organizer: false,
        is_admin_managed: false,
        mutual_friend_count: 0,
        mutual_friends_preview: [],
        followers_count: 0,
    }
}

const TRAIL_SIZE = 5

// Server-side pool: dismissed handles drop out, so a refetch backfills.
function poolHandlers(size: number) {
    const dismissed = new Set<string>()
    const pool = () => Array.from({ length: size }, (_, i) => item(`pop${i + 1}`)).filter((it) => !dismissed.has(it.handle))
    return [
        http.get('*/api/social/me/suggestions', ({ request }) => {
            const sp = new URL(request.url).searchParams
            const limit = sp.get('trail') === 'true' ? TRAIL_SIZE : Number(sp.get('limit') ?? '12')
            const offset = Number(sp.get('offset') ?? '0')
            return HttpResponse.json({
                items: pool().slice(offset, offset + limit),
                total: pool().length,
                friend_count: 0,
                trail_position: 'top',
                trail_size: TRAIL_SIZE,
            })
        }),
        http.post('*/api/social/me/suggestions/:handle/dismiss', ({ params }) => {
            dismissed.add(String(params.handle))
            return new HttpResponse(null, { status: 204 })
        }),
    ]
}

function Trail() {
    const people = usePeopleSuggestions(true)
    if (!people.items) return null
    return (
        <PeopleSuggestionsTrail
            items={people.items}
            total={people.total}
            pending={people.pending}
            onFollow={(h) => void people.follow(h)}
            onDismiss={(h) => void people.dismiss(h)}
            onRefresh={people.refresh && (() => void people.refresh?.())}
            refreshing={people.refreshing}
        />
    )
}

function Sheet() {
    return <HomePeoplePrompt userId="u1" enabled />
}

afterEach(() => {
    clearHomeOverlays()
    clearPeoplePromptSession()
})

describe('PeopleSuggestionsTrail', () => {
    it('caps to the trail size with See more, and backfills after Not interested', async () => {
        server.use(...poolHandlers(8))
        const { user } = renderWithProviders(<Trail />)

        expect(await screen.findByText('POP5')).toBeInTheDocument()
        expect(screen.queryByText('POP6')).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/people/discover')
        expect(screen.getByRole('link', { name: /See more/ })).toHaveAttribute('href', '/people/discover')

        await user.click(screen.getByRole('button', { name: 'Not interested in pop1' }))
        await waitFor(() => expect(screen.getByText('POP6')).toBeInTheDocument())
        expect(screen.queryByText('POP1')).not.toBeInTheDocument()
    })

    it('refresh rotates to the next batch', async () => {
        server.use(...poolHandlers(7))
        const { user } = renderWithProviders(<Trail />)

        expect(await screen.findByText('POP1')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Refresh suggestions' }))
        await waitFor(() => expect(screen.getByText('POP6')).toBeInTheDocument())
        expect(screen.queryByText('POP1')).not.toBeInTheDocument()
    })

    it('hides See more and refresh when the pool fits in one batch', async () => {
        server.use(...poolHandlers(3))
        renderWithProviders(<Trail />)

        expect(await screen.findByText('POP3')).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /See more/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Refresh suggestions' })).not.toBeInTheDocument()
    })
})

describe('HomePeoplePrompt', () => {
    const promptHandler = http.get('*/api/social/me/people-prompt', () =>
        HttpResponse.json({ show: true, forced: false, friend_count: 0, overlays_per_session: 1, items: [item('pop1')], total: 3 }),
    )

    it('opens the sheet when the server says so', async () => {
        server.use(...poolHandlers(3), promptHandler)
        renderWithProviders(<Sheet />)
        expect(await screen.findByRole('dialog', { name: 'Build your tribe' })).toBeInTheDocument()
    })

    it('stays closed when another Home sheet already used the session budget', async () => {
        markHomeOverlayShown('u1')
        server.use(...poolHandlers(3), promptHandler)
        renderWithProviders(<Sheet />)
        await screen.findByText('POP1').catch(() => null)
        await new Promise((r) => setTimeout(r, 1000))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
