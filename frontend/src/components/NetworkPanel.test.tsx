import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import NetworkPanel from './NetworkPanel'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

function followUser(handle: string, is_friend = false) {
    return {
        handle,
        display_name: handle.toUpperCase(),
        avatar_url: null,
        is_verified_organizer: false,
        is_friend,
    }
}

function rankRow(handle: string, rank: number, going_count: number) {
    return {
        rank,
        handle,
        display_name: handle.toUpperCase(),
        avatar_url: null,
        is_verified_organizer: false,
        going_count,
    }
}

/** Register empty/simple handlers for every endpoint the panel touches so
 * MSW's `onUnhandledRequest: 'error'` never trips. Individual tests refine
 * the handful they care about via `server.use(...)`. */
function baseHandlers(opts?: {
    following?: ReturnType<typeof followUser>[]
    mostActive?: (period: string) => ReturnType<typeof rankRow>[]
}) {
    const following = opts?.following ?? [followUser('alpha'), followUser('beta', true)]
    return [
        http.get('*/api/social/me/following', () =>
            HttpResponse.json({ items: following, total: following.length }),
        ),
        http.get('*/api/social/me/followers', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('*/api/social/me/friends', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('*/api/social/me/suggestions', () =>
            HttpResponse.json({ items: [], total: 0 }),
        ),
        http.get('*/api/social/me/follow-requests', () => HttpResponse.json({ items: [] })),
        http.get('*/api/social/me/following/most-active', ({ request }) => {
            const period = new URL(request.url).searchParams.get('period') ?? '365d'
            const items = opts?.mostActive
                ? opts.mostActive(period)
                : [rankRow('alpha', 1, 3), rankRow('beta', 2, 1)]
            return HttpResponse.json({ period, items })
        }),
        http.get('*/api/social/search/users', ({ request }) => {
            const q = new URL(request.url).searchParams.get('q') ?? ''
            return HttpResponse.json({
                items: [
                    {
                        handle: `found_${q}`,
                        display_name: `FOUND_${q.toUpperCase()}`,
                        avatar_url: null,
                        is_verified_organizer: false,
                        subscribers_count: 0,
                        is_subscribed: false,
                        is_followed_by_viewer: false,
                    },
                ],
            })
        }),
    ]
}

describe('NetworkPanel (People page)', () => {
    it('shows the discovery block and All following list by default', async () => {
        server.use(...baseHandlers())
        renderWithProviders(<NetworkPanel />)

        expect(await screen.findByRole('heading', { name: 'People' })).toBeInTheDocument()
        expect(screen.getByText('Discover people')).toBeInTheDocument()
        // All following is the default sub-view with an implicit count header.
        expect(await screen.findByText('2 people')).toBeInTheDocument()
        expect(screen.getByText('ALPHA')).toBeInTheDocument()
        // Relationship text: mutual follow → Friend, one-directional → Following.
        const list = screen.getByRole('list')
        expect(within(list).getByText('Following')).toBeInTheDocument()
        expect(within(list).getByText('Friend')).toBeInTheDocument()
    })

    it('switches to Most active with 1 year default and event counts', async () => {
        server.use(...baseHandlers())
        const { user } = renderWithProviders(<NetworkPanel />)

        await screen.findByText('2 people')
        await user.click(screen.getByRole('button', { name: 'Most active' }))

        // 1 year selected by default.
        expect(screen.getByRole('button', { name: '1 year' })).toHaveAttribute(
            'aria-pressed',
            'true',
        )
        expect(await screen.findByText('3 events')).toBeInTheDocument()
        expect(screen.getByText('1 event')).toBeInTheDocument()
    })

    it('changes the activity period in place', async () => {
        server.use(
            ...baseHandlers({
                mostActive: (period) =>
                    period === '180d' ? [rankRow('alpha', 1, 9)] : [rankRow('alpha', 1, 3)],
            }),
        )
        const { user } = renderWithProviders(<NetworkPanel />, {
            routerEntries: ['/?tab=following&sub=active'],
        })

        expect(await screen.findByText('3 events')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: '6 months' }))
        expect(await screen.findByText('9 events')).toBeInTheDocument()
    })

    it('restores tab/sub-view/period from the URL', async () => {
        server.use(...baseHandlers())
        renderWithProviders(<NetworkPanel />, {
            routerEntries: ['/?tab=following&sub=active&period=180d'],
        })

        expect(await screen.findByRole('button', { name: 'Most active' })).toHaveAttribute(
            'aria-pressed',
            'true',
        )
        expect(screen.getByRole('button', { name: '6 months' })).toHaveAttribute(
            'aria-pressed',
            'true',
        )
    })

    it('shows an empty state when the period has no activity', async () => {
        server.use(...baseHandlers({ mostActive: () => [] }))
        renderWithProviders(<NetworkPanel />, {
            routerEntries: ['/?tab=following&sub=active'],
        })

        expect(await screen.findByText('No activity in this period.')).toBeInTheDocument()
        // Period selector stays visible so the user can widen the window.
        expect(screen.getByRole('button', { name: '3 months' })).toBeInTheDocument()
    })

    it('replaces content with search results and restores on clear', async () => {
        server.use(...baseHandlers())
        const { user } = renderWithProviders(<NetworkPanel />)

        await screen.findByText('2 people')
        await user.type(
            screen.getByLabelText('Search by name or handle'),
            'nova',
        )
        expect(await screen.findByText('FOUND_NOVA')).toBeInTheDocument()
        // Following list is hidden while searching.
        expect(screen.queryByText('2 people')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Clear' }))
        expect(await screen.findByText('2 people')).toBeInTheDocument()
    })

    it('confirms before unfollowing from the row menu', async () => {
        server.use(...baseHandlers())
        const { user } = renderWithProviders(<NetworkPanel />)

        await screen.findByText('2 people')
        // Open the three-dot menu for the one-directional follow (alpha).
        await user.click(screen.getByRole('button', { name: 'Actions for ALPHA' }))
        await user.click(screen.getByRole('menuitem', { name: 'Unfollow' }))
        // Confirmation dialog appears.
        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByText(/Unfollow ALPHA/)).toBeInTheDocument()
    })
})
