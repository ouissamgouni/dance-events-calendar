import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import DiscoverPeoplePage from './DiscoverPeoplePage'
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
    }
}

describe('DiscoverPeoplePage', () => {
    it('pages through suggestions and drops a followed person', async () => {
        const followed = new Set<string>()
        const pool = () => Array.from({ length: 25 }, (_, i) => item(`p${i + 1}`)).filter((it) => !followed.has(it.handle))
        server.use(
            http.get('*/api/social/me/suggestions', ({ request }) => {
                const sp = new URL(request.url).searchParams
                const limit = Number(sp.get('limit') ?? '12')
                const offset = Number(sp.get('offset') ?? '0')
                return HttpResponse.json({ items: pool().slice(offset, offset + limit), total: pool().length })
            }),
            http.post('*/api/social/users/:handle/follow', ({ params }) => {
                followed.add(String(params.handle))
                return HttpResponse.json({ status: 'following' })
            }),
        )
        const { user } = renderWithProviders(<DiscoverPeoplePage />)

        expect(await screen.findByText('P20')).toBeInTheDocument()
        expect(screen.queryByText('P21')).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Load more' }))
        expect(await screen.findByText('P25')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Follow p1' }))
        await waitFor(() => expect(screen.queryByText('P1')).not.toBeInTheDocument())
        expect(screen.getByText('P25')).toBeInTheDocument()
    })
})
