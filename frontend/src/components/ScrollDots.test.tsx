import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ScrollDotsIndicator from './ScrollDots'

describe('ScrollDotsIndicator', () => {
    it('renders nothing when count is 1 or fewer', () => {
        const { container } = render(
            <ScrollDotsIndicator count={1} activeIndex={0} onSelect={vi.fn()} />,
        )
        expect(container).toBeEmptyDOMElement()
    })

    it('renders one dot per page and marks the active page selected', () => {
        render(<ScrollDotsIndicator count={3} activeIndex={1} onSelect={vi.fn()} />)
        const dots = screen.getAllByRole('tab')
        expect(dots).toHaveLength(3)
        expect(dots[1]).toHaveAttribute('aria-selected', 'true')
        expect(dots[0]).toHaveAttribute('aria-selected', 'false')
    })

    it('calls onSelect with the page index when a dot is clicked', () => {
        const onSelect = vi.fn()
        render(<ScrollDotsIndicator count={3} activeIndex={0} onSelect={onSelect} />)
        fireEvent.click(screen.getByLabelText('Go to page 3 of 3'))
        expect(onSelect).toHaveBeenCalledWith(2)
    })
})
