import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import EventCardPlaceholder from './EventCardPlaceholder'

describe('EventCardPlaceholder', () => {
    it('renders no letter in gradient style', () => {
        render(<EventCardPlaceholder seed="evt-1" title="Salsa Social" style="gradient" />)

        const el = screen.getByTestId('event-card-placeholder')
        expect(el).toHaveAttribute('data-placeholder-style', 'gradient')
        expect(el.textContent).toBe('')
    })

    it('renders the uppercased first letter in initial style', () => {
        render(<EventCardPlaceholder seed="evt-1" title="salsa social" style="initial" />)

        expect(screen.getByTestId('event-card-placeholder')).toHaveTextContent('S')
    })

    it('is deterministic for the same seed and varies across seeds', () => {
        const { container: a } = render(
            <EventCardPlaceholder seed="evt-1" title="A" style="gradient" />,
        )
        const { container: b } = render(
            <EventCardPlaceholder seed="evt-1" title="B" style="gradient" />,
        )
        const { container: c } = render(
            <EventCardPlaceholder seed="evt-99" title="C" style="gradient" />,
        )

        const cls = (root: HTMLElement) =>
            root.querySelector('[data-testid="event-card-placeholder"]')!.className

        expect(cls(a)).toBe(cls(b))
        expect(cls(a)).not.toBe(cls(c))
    })

    it('uses literal gradient classes so Tailwind can generate them', () => {
        render(<EventCardPlaceholder seed="evt-1" title="A" style="gradient" />)

        const className = screen.getByTestId('event-card-placeholder').className
        expect(className).toMatch(/bg-gradient-to-br from-\w+-200 to-\w+-200/)
    })
})
