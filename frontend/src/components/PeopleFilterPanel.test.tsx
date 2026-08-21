import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import PeopleFilterPanel from './PeopleFilterPanel'
import type { InterestFilterChange } from './InterestFilter'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// The redesigned People filter: persistent Tribe row, single-select WHO
// (Following / Friends / Specific people), multi-select STATUS (Going /
// Interested, at least one on), an in-sheet Specific-people picker, and an
// empty-network "Build your tribe" acquisition state that transitions to the
// populated filter (Following auto-selected) after the first follow.

function follow(handle: string, displayName: string, isFriend = false) {
    return { handle, display_name: displayName, avatar_url: null, is_verified_organizer: false, is_friend: isFriend }
}

function followingHandlers(total = 7) {
    return [
        http.get('*/api/social/me/following', () =>
            HttpResponse.json({
                items: [follow('alice', 'Alice Smith', true), follow('bob', 'Bob Jones'), follow('carol', 'Carol Diaz')],
                total,
            }),
        ),
        http.get('*/api/social/users/interest-summary', () => HttpResponse.json({ items: [] })),
    ]
}

function suggestionHandlers(items: unknown[]) {
    return [
        http.get('*/api/social/me/suggestions', () => HttpResponse.json({ items, total: items.length })),
    ]
}

function followActionHandler() {
    return http.post('*/api/social/users/:handle/follow', ({ params }) =>
        HttpResponse.json({
            handle: params.handle,
            is_following: true,
            is_friend: false,
            followers_count: 1,
            is_subscribed: true,
            notify_new_events: false,
        }),
    )
}

/** Controlled harness mirroring how Home lifts the filter state. */
function Harness({ followingCount, onChange }: { followingCount: number; onChange?: (c: InterestFilterChange) => void }) {
    const [source, setSource] = useState<'follows' | 'friends' | null>(followingCount > 0 ? 'follows' : null)
    const [kind, setKind] = useState<'any' | 'going' | 'saved'>('going')
    const [handles, setHandles] = useState<string[]>([])
    const [match, setMatch] = useState<'any' | 'all'>('any')
    return (
        <PeopleFilterPanel
            signedIn
            followingCount={followingCount}
            interestSource={source}
            interestKind={kind}
            interestUserHandles={handles}
            interestMatch={match}
            onChange={(next) => {
                onChange?.(next)
                if (Object.prototype.hasOwnProperty.call(next, 'source')) setSource(next.source ?? null)
                if (Object.prototype.hasOwnProperty.call(next, 'kind')) setKind(next.kind!)
                if (Object.prototype.hasOwnProperty.call(next, 'match')) setMatch(next.match!)
                if (Object.prototype.hasOwnProperty.call(next, 'userHandles')) setHandles(next.userHandles ?? [])
            }}
        />
    )
}

describe('PeopleFilterPanel', () => {
    it('defaults STATUS to Going and enforces single-select WHO', async () => {
        server.use(...followingHandlers())
        const onChange = vi.fn()
        const { user } = renderWithProviders(<Harness followingCount={7} onChange={onChange} />)

        expect(screen.getByTestId('who-following')).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByTestId('status-going')).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByTestId('status-interested')).toHaveAttribute('aria-pressed', 'false')

        await user.click(screen.getByTestId('who-friends'))
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'friends', userHandles: [] }))
        await waitFor(() => expect(screen.getByTestId('who-friends')).toHaveAttribute('aria-pressed', 'true'))
        expect(screen.getByTestId('who-following')).toHaveAttribute('aria-pressed', 'false')
    })

    it('keeps at least one STATUS selected', async () => {
        server.use(...followingHandlers())
        const onChange = vi.fn()
        const { user } = renderWithProviders(<Harness followingCount={7} onChange={onChange} />)

        // Going is the only active status → clicking it is a no-op.
        await user.click(screen.getByTestId('status-going'))
        expect(onChange).not.toHaveBeenCalled()

        // Enabling Interested → both on ('any').
        await user.click(screen.getByTestId('status-interested'))
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: 'any' }))
    })

    it('clears the People filter via Anyone and hides STATUS', async () => {
        server.use(...followingHandlers())
        const onChange = vi.fn()
        const { user } = renderWithProviders(<Harness followingCount={7} onChange={onChange} />)

        // Default is Following → STATUS is visible.
        expect(screen.getByTestId('status-going')).toBeInTheDocument()

        await user.click(screen.getByTestId('who-anyone'))
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ source: null, userHandles: [] }))

        await waitFor(() => expect(screen.getByTestId('who-anyone')).toHaveAttribute('aria-pressed', 'true'))
        // Clearing hides the STATUS section entirely.
        expect(screen.queryByTestId('status-going')).not.toBeInTheDocument()
        expect(screen.queryByTestId('status-interested')).not.toBeInTheDocument()
    })

    it('opens the Specific-people picker and commits a selection', async () => {
        server.use(...followingHandlers())
        const onChange = vi.fn()
        const { user } = renderWithProviders(<Harness followingCount={7} onChange={onChange} />)

        await user.click(screen.getByTestId('who-specific'))
        expect(await screen.findByTestId('specific-people-picker')).toBeInTheDocument()

        await user.click(await screen.findByText('Alice Smith'))
        await user.click(screen.getByTestId('specific-people-done'))
        expect(onChange).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'follows', userHandles: ['alice'], match: 'any' }),
        )
    })

    it('shows Build your tribe when the viewer has no network and follows inline', async () => {
        server.use(
            ...followingHandlers(0),
            ...suggestionHandlers([
                { handle: 'dan', display_name: 'Dan Poe', avatar_url: null, is_verified_organizer: false, mutual_friend_count: 2, mutual_friends_preview: ['alice'] },
            ]),
            followActionHandler(),
        )
        const onChange = vi.fn()
        const { user } = renderWithProviders(<Harness followingCount={0} onChange={onChange} />)

        expect(await screen.findByTestId('build-your-tribe')).toBeInTheDocument()
        const followBtn = await screen.findByRole('button', { name: /Follow dan/i })
        await user.click(followBtn)

        // First follow from empty state auto-selects Following + Going.
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'follows', kind: 'going' }))
    })
})
