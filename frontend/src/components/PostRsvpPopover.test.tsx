import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PostRsvpPopover from './PostRsvpPopover'
import { FeatureFlagsContext, defaultFlags } from '../context/FeatureFlagsContext'
import { renderWithProviders } from '../test/render'

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

    it('keeps the anchored presentation on desktop without auto-dismiss', () => {
        vi.useFakeTimers()
        setMobileViewport(false)
        const anchor = document.createElement('button')
        document.body.appendChild(anchor)
        const onClose = vi.fn()

        renderWithProviders(
            <PostRsvpPopover
                anchorRef={{ current: anchor }}
                variant="signed-in"
                onClose={onClose}
                onShare={vi.fn()}
                audience="friends"
                onAudienceChange={vi.fn()}
            />,
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
})
