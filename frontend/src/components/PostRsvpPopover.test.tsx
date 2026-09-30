import { act, screen } from '@testing-library/react'
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
    it('renders a mobile sheet with horizontal visibility pills and keeps the timeout', () => {
        vi.useFakeTimers()
        setMobileViewport(true)
        const onClose = vi.fn()

        renderWithProviders(
            <PostRsvpPopover
                anchorRef={{ current: document.createElement('button') }}
                variant="signed-in"
                eventTitle="Summer Salsa Social"
                userName="Test Dancer"
                onClose={onClose}
                onShare={vi.fn()}
                audience="friends"
                onAudienceChange={vi.fn()}
            />,
        )

        expect(screen.getByRole('dialog', { name: "You're going!" })).toHaveAttribute('aria-modal', 'true')
        expect(screen.getByText('Summer Salsa Social')).toHaveClass('line-clamp-2', 'text-sm')
        expect(screen.getByRole('radiogroup', { name: 'Attendance visibility' })).toHaveClass('flex', 'w-full')
        expect(screen.getAllByRole('radio')[0]).toHaveClass('min-h-11', 'text-sm')

        act(() => vi.advanceTimersByTime(5000))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('keeps the anchored presentation on desktop', () => {
        setMobileViewport(false)
        const anchor = document.createElement('button')
        document.body.appendChild(anchor)

        renderWithProviders(
            <PostRsvpPopover
                anchorRef={{ current: anchor }}
                variant="signed-in"
                onClose={vi.fn()}
                onShare={vi.fn()}
                audience="friends"
                onAudienceChange={vi.fn()}
            />,
        )

        const popover = screen.getByRole('dialog', { name: "You're going" })
        expect(popover).not.toHaveAttribute('aria-modal')
        expect(popover).toHaveStyle({ position: 'fixed' })
    })
})
