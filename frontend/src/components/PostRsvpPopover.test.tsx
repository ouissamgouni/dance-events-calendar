import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import PostRsvpPopover from './PostRsvpPopover'
import { FeatureFlagsContext, defaultFlags } from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { makeUser } from '../test/handlers'

function setMobileViewport(matches: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 639px)' ? matches : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }))
}

afterEach(() => vi.useRealTimers())

describe('PostRsvpPopover', () => {
    it('renders a mobile sheet without auto-dismiss, with Share + Done', () => {
        vi.useFakeTimers()
        setMobileViewport(true)
        const onClose = vi.fn()
        const onShare = vi.fn()

        renderWithProviders(
            <PostRsvpPopover
                anchorRef={{ current: document.createElement('button') }}
                variant="signed-in"
                eventTitle="Summer Salsa Social"
                onClose={onClose}
                onShare={onShare}
                audience="friends"
                onAudienceChange={vi.fn()}
            />,
        )

        expect(screen.getByRole('dialog', { name: "You're going!" })).toHaveAttribute('aria-modal', 'true')
        expect(screen.getByText('Summer Salsa Social')).toHaveClass('truncate', 'text-sm')
        expect(screen.getByRole('radiogroup', { name: 'Who can see you in the attendee list?' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')[0]).toHaveClass('min-h-10', 'text-sm')
        expect(screen.queryByText('Only your mutual followers will see your name in the attendee list.')).not.toBeInTheDocument()

        act(() => vi.advanceTimersByTime(5000))
        expect(onClose).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Share' }))
        expect(onShare).toHaveBeenCalledOnce()
        fireEvent.click(screen.getByRole('button', { name: 'Done' }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('keeps the anchored presentation on desktop when the people sheet is off', () => {
        vi.useFakeTimers()
        setMobileViewport(false)
        const anchor = document.createElement('button')
        document.body.appendChild(anchor)
        const onClose = vi.fn()
        const flags = { ...defaultFlags, rsvpPeopleSheetEnabled: false }

        renderWithProviders(
            <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                <PostRsvpPopover
                    anchorRef={{ current: anchor }}
                    variant="signed-in"
                    onClose={onClose}
                    onShare={vi.fn()}
                    audience="friends"
                    onAudienceChange={vi.fn()}
                />
            </FeatureFlagsContext.Provider>,
        )

        const popover = screen.getByRole('dialog', { name: "You're going!" })
        expect(popover).not.toHaveAttribute('aria-modal')
        expect(popover).toHaveStyle({ position: 'fixed' })

        act(() => vi.advanceTimersByTime(5000))
        expect(onClose).not.toHaveBeenCalled()
        fireEvent.pointerDown(popover)
        expect(onClose).not.toHaveBeenCalled()
        fireEvent.pointerDown(document.body)
        expect(onClose).toHaveBeenCalledOnce()
    })

    it.each([
        [false, true, 'Got your ticket? Keep it handy here', '/event/evt-1#ticket'],
        [true, false, 'Add memories', '/event/evt-1#memories'],
    ])('offers the asset shortcut (isPast=%s, ticketLikely=%s)', (isPast, ticketLikely, label, href) => {
        setMobileViewport(true)
        const flags = { ...defaultFlags, eventTicketsEnabled: true, eventMemoriesEnabled: true }
        renderWithProviders(
            <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                <PostRsvpPopover
                    anchorRef={{ current: document.createElement('button') }}
                    variant="signed-in"
                    eventId="evt-1"
                    isPast={isPast}
                    ticketLikely={ticketLikely}
                    onClose={vi.fn()}
                    onShare={vi.fn()}
                />
            </FeatureFlagsContext.Provider>,
        )

        expect(screen.getByRole('link', { name: new RegExp(label.replace('?', '\\?')) })).toHaveAttribute('href', href)
    })

    it('skips the ticket shortcut for events that rarely need one', () => {
        setMobileViewport(true)
        const flags = { ...defaultFlags, eventTicketsEnabled: true, eventMemoriesEnabled: true }
        renderWithProviders(
            <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                <PostRsvpPopover
                    anchorRef={{ current: document.createElement('button') }}
                    variant="signed-in"
                    eventId="evt-1"
                    onClose={vi.fn()}
                    onShare={vi.fn()}
                />
            </FeatureFlagsContext.Provider>,
        )

        expect(screen.queryByRole('link', { name: /ticket/i })).not.toBeInTheDocument()
    })

    describe('people sheet', () => {
        const attendees = [
            { user_id: 'user-1', display_name: 'Me', avatar_url: null, handle: 'testdancer', attendance_status: 'going' },
            { user_id: 'ana', display_name: 'Ana', avatar_url: null, handle: 'ana', is_friend: true, viewer_follow_status: 'approved' },
            { user_id: 'leo', display_name: 'Leo', avatar_url: null, handle: 'leo', viewer_follow_status: 'approved' },
            { user_id: 'tom', display_name: 'Tom', avatar_url: null, handle: 'tom', mutual_friend_count: 0 },
            { user_id: 'mia', display_name: 'Mia', avatar_url: null, handle: 'mia', mutual_friend_count: 2 },
        ]

        function renderPeopleSheet(isPast = false) {
            setMobileViewport(false)
            server.use(
                http.get('*/api/auth/me', () => HttpResponse.json(makeUser({ share_code: 'abc123de' }))),
                http.get('*/api/events/:eventId/attendees', () => HttpResponse.json(attendees)),
                http.get('*/api/social/me/referral', () => HttpResponse.json({ code: 'INV123', url: '/r/INV123', used_count: 0 })),
            )
            const onShare = vi.fn()
            const flags = { ...defaultFlags, rsvpPeopleSheetEnabled: true }
            renderWithProviders(
                <FeatureFlagsContext.Provider value={{ flags, updateFlag: vi.fn() }}>
                    <PostRsvpPopover
                        anchorRef={{ current: document.createElement('button') }}
                        variant="signed-in"
                        eventId="evt-1"
                        eventTitle="Summer Salsa Social"
                        isPast={isPast}
                        onClose={vi.fn()}
                        onShare={onShare}
                        audience="friends"
                        onAudienceChange={vi.fn()}
                    />
                </FeatureFlagsContext.Provider>,
            )
            return { onShare }
        }

        it('shows a modal with people, friend-invite share and the My Events next step', async () => {
            renderPeopleSheet()
            // After render: userEvent.setup() installs its own clipboard stub.
            const writeText = vi.fn().mockResolvedValue(undefined)
            Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

            expect(screen.getByRole('dialog', { name: "You're going!" })).toHaveAttribute('aria-modal', 'true')
            expect(await screen.findByTestId('rsvp-visibility-summary')).toHaveTextContent('Visible to: Friends')
            expect(screen.queryByRole('checkbox', { name: 'Remember my choice' })).not.toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
            expect(screen.getByRole('link', { name: 'See it in My Events' })).toHaveAttribute('href', '/my-events')

            expect(await screen.findByText('Your people going')).toBeInTheDocument()
            expect(screen.getByText('Ana, Leo')).toBeInTheDocument()
            const also = screen.getByText('Also going').closest('section')!
            expect(within(also).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
                expect.stringContaining('Mia2 mutual friendsFollow'),
                expect.stringContaining('TomFollow'),
            ])

            await screen.findByText('Share it with who you’d like there — you’ll be connected as friends.')
            fireEvent.click(screen.getByRole('button', { name: 'Bring someone along' }))
            await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
            const url = new URL(writeText.mock.calls[0][0])
            expect(url.pathname).toBe('/event/evt-1')
            expect(Object.fromEntries(url.searchParams)).toEqual({ ref: 'share', src: 'abc123de', inv: 'INV123' })
            expect(await screen.findByRole('button', { name: 'Link copied · Copy again' })).toBeInTheDocument()
        })

        it('uses past-tense sections and drops the invite share for past events', async () => {
            renderPeopleSheet(true)

            expect(await screen.findByText('Also there')).toBeInTheDocument()
            expect(screen.getByText('Your people there')).toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'Bring someone along' })).not.toBeInTheDocument()
            expect(screen.queryByRole('link', { name: 'See it in My Events' })).not.toBeInTheDocument()
        })
    })
})
