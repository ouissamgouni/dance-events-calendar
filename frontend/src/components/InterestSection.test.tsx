import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import InterestSection from './InterestSection'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

// InterestSection headers claim "N going" but can only render attendees the
// viewer is allowed to see (public + friends/FoF). The regression these tests
// guard is the gap: when only 1 of N going is visible, the section must (a)
// drop "Also" from the public bucket when no friend buckets sit above it, and
// (b) explain the hidden remainder ("N more going privately").

function mockEndpoints(opts: {
    totalGoing: number
    attendees: { user_id: string; display_name: string; handle: string }[]
    publicGoingCount: number
}) {
    server.use(
        http.get('*/api/auth/me', () => HttpResponse.json(makeUser())),
        http.get('*/api/events/:id/attendance-summary', () =>
            HttpResponse.json({
                event_id: 'evt-1',
                total_going: opts.totalGoing,
                total_saved: 0,
                public_going: opts.publicGoingCount,
                anonymous_going: 0,
                can_view_attendees: true,
                viewer_is_sharing: false,
                preview_attendees: [],
            }),
        ),
        http.get('*/api/events/:id/going-wedge', () =>
            HttpResponse.json({
                event_id: 'evt-1',
                friends_going: [],
                fof_going: [],
                public_going_count: opts.publicGoingCount,
            }),
        ),
        http.get('*/api/events/:id/attendees', () =>
            HttpResponse.json(
                opts.attendees.map((a) => ({ ...a, avatar_url: null })),
            ),
        ),
    )
}

describe('InterestSection hidden-attendee accounting', () => {
    it('drops "Also" and explains the hidden remainder when no friends are shown', async () => {
        mockEndpoints({
            totalGoing: 6,
            publicGoingCount: 1,
            attendees: [
                { user_id: 'user-2', display_name: 'Pat Public', handle: 'patpublic' },
            ],
        })

        renderWithProviders(<InterestSection eventId="evt-1" eventTitle="Salsa Night" />)

        const others = await screen.findByTestId('interest-others')
        expect(others).toHaveTextContent('· Going')
        expect(others).not.toHaveTextContent('Also going')

        await waitFor(() =>
            expect(screen.getByTestId('interest-hidden')).toHaveTextContent(
                '5 more going privately',
            ),
        )
    })
})
