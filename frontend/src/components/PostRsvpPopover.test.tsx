import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PostRsvpPopover from './PostRsvpPopover'
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
    it('renders a mobile sheet without auto-dismiss, with Share event + Done', () => {
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
        expect(screen.getByText('Summer Salsa Social')).toHaveClass('line-clamp-2', 'text-sm')
        expect(screen.getByRole('radiogroup', { name: 'Attendance visibility' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')[0]).toHaveClass('min-h-12', 'text-sm')
        expect(screen.getByText('Only your mutual followers will see your name in the attendee list.')).toBeInTheDocument()

        act(() => vi.advanceTimersByTime(5000))
        expect(onClose).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Share event' }))
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
        fireEvent.mouseDown(document.body)
        expect(onClose).not.toHaveBeenCalled()
    })
})
