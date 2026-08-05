import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PeopleYouMayKnowCard from './PeopleYouMayKnowCard'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// The list variant fetches /social/me/suggestions in pages of 6 and appends
// each page behind a "Show more" button until the loaded count reaches the
// reported total.

function item(handle: string) {
    return {
        handle,
        display_name: handle.toUpperCase(),
        avatar_url: null,
        is_verified_organizer: false,
        is_admin_managed: false,
        mutual_friend_count: 1,
        mutual_friends_preview: ['alice'],
        followers_count: 0,
    }
}

function pagedSuggestions() {
    const all = Array.from({ length: 15 }, (_, i) => item(`pop${String(i + 1).padStart(2, '0')}`))
    return http.get('*/api/social/me/suggestions', ({ request }) => {
        const url = new URL(request.url)
        const limit = Number(url.searchParams.get('limit') ?? '6')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        return HttpResponse.json({
            items: all.slice(offset, offset + limit),
            total: all.length,
        })
    })
}

describe('PeopleYouMayKnowCard show more', () => {
    it('paginates in pages of 6 until the pool is exhausted', async () => {
        server.use(pagedSuggestions())

        const { user } = renderWithProviders(<PeopleYouMayKnowCard />)

        // First page.
        expect(await screen.findByText('POP01')).toBeInTheDocument()
        expect(screen.getByText('POP06')).toBeInTheDocument()
        expect(screen.queryByText('POP07')).not.toBeInTheDocument()

        // Load the second page.
        await user.click(screen.getByRole('button', { name: 'Show more' }))
        await waitFor(() => expect(screen.getByText('POP12')).toBeInTheDocument())
        expect(screen.getByText('POP01')).toBeInTheDocument() // earlier rows kept

        // Load the final page; the button disappears once all 15 are loaded.
        await user.click(screen.getByRole('button', { name: 'Show more' }))
        await waitFor(() => expect(screen.getByText('POP15')).toBeInTheDocument())
        expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    })

    it('does not render a Show more button when the pool fits one page', async () => {
        server.use(
            http.get('*/api/social/me/suggestions', () =>
                HttpResponse.json({ items: [item('pop01'), item('pop02')], total: 2 }),
            ),
        )

        renderWithProviders(<PeopleYouMayKnowCard />)

        expect(await screen.findByText('POP01')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    })
})
