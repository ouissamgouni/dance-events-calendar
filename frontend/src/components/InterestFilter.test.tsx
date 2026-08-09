import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { InterestFilterChips, type InterestFilterChange } from './InterestFilter'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

// The shared people-filter used by both the explorer and the calendar filter
// sheet: a "+" search button + collapsed pill rail (first-name only, no
// checkbox), a combo-box overlay whose CTAs are a single "Apply" for one
// person or Anyone / Everyone for 2+, and an Any|All operator that appears
// once 2+ people are selected.

function follow(handle: string, displayName: string, isFriend = false) {
    return {
        handle,
        display_name: displayName,
        avatar_url: null,
        is_verified_organizer: false,
        is_friend: isFriend,
    }
}

function summary(handle: string, going: number, saved: number) {
    return { handle, upcoming_going_visible: going, upcoming_saved_visible: saved }
}

/** Seven followees so the rail has to cap at five and rank by count. */
function peopleHandlers() {
    const following = [
        follow('alice', 'Alice Smith', true),
        follow('bob', 'Bob Jones', true),
        follow('carol', 'Carol Diaz'),
        follow('dave', 'Dave Lee'),
        follow('eve', 'Eve Ng'),
        follow('frank', 'Frank Ito'),
        follow('grace', 'Grace Kim'),
    ]
    const summaries = [
        summary('alice', 5, 1),
        summary('bob', 4, 0),
        summary('carol', 3, 2),
        summary('dave', 2, 0),
        summary('eve', 1, 1),
        summary('frank', 0, 0),
        summary('grace', 0, 0),
    ]
    return [
        http.get('*/api/social/me/following', () =>
            HttpResponse.json({ items: following, total: following.length }),
        ),
        http.get('*/api/social/users/interest-summary', () =>
            HttpResponse.json({ items: summaries }),
        ),
    ]
}

/** Controlled harness mirroring how Home/MyCalendar lift the filter state. */
function Harness({ onApply }: { onApply?: (c: InterestFilterChange) => void }) {
    const [source, setSource] = useState<'follows' | 'friends' | null>(null)
    const [kind, setKind] = useState<'any' | 'going' | 'saved'>('any')
    const [handles, setHandles] = useState<string[]>([])
    const [match, setMatch] = useState<'any' | 'all'>('any')
    return (
        <InterestFilterChips
            signedIn
            followingCount={7}
            interestSource={source}
            interestKind={kind}
            interestUserHandles={handles}
            interestMatch={match}
            onChange={(next) => {
                onApply?.(next)
                if (Object.prototype.hasOwnProperty.call(next, 'source')) {
                    setSource(next.source ?? null)
                    if (next.source === null) setHandles([])
                }
                if (Object.prototype.hasOwnProperty.call(next, 'kind')) setKind(next.kind!)
                if (Object.prototype.hasOwnProperty.call(next, 'match')) setMatch(next.match!)
                if (Object.prototype.hasOwnProperty.call(next, 'userHandles')) {
                    const nh = next.userHandles ?? []
                    setHandles(nh)
                    if (nh.length > 0 && source === null) setSource('follows')
                }
            }}
        />
    )
}

describe('InterestFilterChips', () => {
    it('renders the collapsed rail as first-name pills capped at five', async () => {
        server.use(...peopleHandlers())
        renderWithProviders(<Harness />)

        const rail = await screen.findByTestId('following-person-rail')
        const pills = within(rail).getAllByRole('button')
        expect(pills).toHaveLength(5)
        // First names only (before the first space), ranked by count.
        expect(within(rail).getByText('Alice')).toBeInTheDocument()
        expect(within(rail).getByText('Carol')).toBeInTheDocument()
        // Zero-count people are omitted from the rail.
        expect(within(rail).queryByText('Frank')).not.toBeInTheDocument()
    })

    it('quick-picks a rail pill and applies the filter immediately', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        const rail = await screen.findByTestId('following-person-rail')
        await user.click(within(rail).getByText('Alice'))

        expect(applied.at(-1)).toEqual({ userHandles: ['alice'] })
        // A single selection does not surface the Any|All operator.
        expect(screen.queryByTestId('interest-match-selector')).not.toBeInTheDocument()

        // Selecting a second person surfaces the operator.
        await user.click(within(rail).getByText('Carol'))
        expect(await screen.findByTestId('interest-match-selector')).toBeInTheDocument()
    })

    it('toggles the applied match operator between any and all', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        const rail = await screen.findByTestId('following-person-rail')
        await user.click(within(rail).getByText('Alice'))
        await user.click(within(rail).getByText('Carol'))

        const selector = await screen.findByTestId('interest-match-selector')
        await user.click(within(selector).getByRole('button', { name: 'All' }))
        expect(applied.at(-1)).toEqual({ match: 'all' })

        await user.click(within(selector).getByRole('button', { name: 'Any' }))
        expect(applied.at(-1)).toEqual({ match: 'any' })
    })

    it('opens the overlay and Close discards without applying', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        await user.click(await screen.findByTestId('following-search-open'))
        const overlay = await screen.findByTestId('following-person-overlay')

        // Pick someone in the draft list, then Close.
        await user.click(await within(overlay).findByText('Bob Jones'))
        await user.click(within(overlay).getByRole('button', { name: 'Close' }))

        await waitFor(() =>
            expect(screen.queryByTestId('following-person-overlay')).not.toBeInTheDocument(),
        )
        // Nothing committed — Close discards the draft.
        expect(applied).toHaveLength(0)
    })

    it('commits the overlay selection with Everyone as match=all', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        await user.click(await screen.findByTestId('following-search-open'))
        const overlay = await screen.findByTestId('following-person-overlay')
        await user.click(await within(overlay).findByText('Bob Jones'))
        await user.click(await within(overlay).findByText('Carol Diaz'))
        await user.click(within(overlay).getByTestId('following-apply-everyone'))

        const last = applied.at(-1)!
        expect(last.match).toBe('all')
        expect(last.userHandles).toEqual(['bob', 'carol'])
        await waitFor(() =>
            expect(screen.queryByTestId('following-person-overlay')).not.toBeInTheDocument(),
        )
    })

    it('commits the overlay selection with Anyone as match=any', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        await user.click(await screen.findByTestId('following-search-open'))
        const overlay = await screen.findByTestId('following-person-overlay')
        await user.click(await within(overlay).findByText('Bob Jones'))
        await user.click(await within(overlay).findByText('Carol Diaz'))
        await user.click(within(overlay).getByTestId('following-apply-anyone'))

        const last = applied.at(-1)!
        expect(last.match).toBe('any')
        expect(last.userHandles).toEqual(['bob', 'carol'])
    })

    it('commits a single overlay selection with Apply', async () => {
        server.use(...peopleHandlers())
        const applied: InterestFilterChange[] = []
        const { user } = renderWithProviders(<Harness onApply={(c) => applied.push(c)} />)

        await user.click(await screen.findByTestId('following-search-open'))
        const overlay = await screen.findByTestId('following-person-overlay')
        await user.click(await within(overlay).findByText('Bob Jones'))
        await user.click(within(overlay).getByTestId('following-apply'))

        const last = applied.at(-1)!
        expect(last.userHandles).toEqual(['bob'])
        expect(last.match).toBe('any')
    })
})
