import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { computeToastPos, useAnchoredToast } from './AnchoredToast'

const viewport = { width: 400, height: 800 }
const size = { width: 200, height: 40 }

describe('computeToastPos', () => {
    it('places below the anchor, extending right from its left edge', () => {
        const pos = computeToastPos({ top: 100, bottom: 132, left: 20, right: 52 }, size, viewport)
        expect(pos).toEqual({ top: 138, left: 20 })
    })

    it('extends left from the right edge when there is no room on the right', () => {
        const pos = computeToastPos({ top: 100, bottom: 132, left: 340, right: 372 }, size, viewport)
        expect(pos.left).toBe(172)
    })

    it('flips above the anchor when there is no room below', () => {
        const pos = computeToastPos({ top: 760, bottom: 792, left: 20, right: 52 }, size, viewport)
        expect(pos.top).toBe(760 - 6 - 40)
    })
})

function Harness({ name, onAction }: { name: string; onAction?: () => void }) {
    const ref = useRef<HTMLButtonElement | null>(null)
    const toast = useAnchoredToast(ref)
    return (
        <>
            <button
                ref={ref}
                onClick={() => toast.show(`${name} toast`, 5000, onAction ? { action: { label: 'Public', icon: null, onClick: onAction } } : {})}
            >
                {name}
            </button>
            {toast.node}
        </>
    )
}

describe('useAnchoredToast', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('auto-hides after 5s, pauses on hover, and runs the action', () => {
        const onAction = vi.fn()
        render(<Harness name="A" onAction={onAction} />)
        fireEvent.click(screen.getByRole('button', { name: 'A' }))
        const toast = screen.getByRole('status')

        fireEvent.mouseEnter(toast)
        act(() => { vi.advanceTimersByTime(10000) })
        expect(screen.getByText('A toast')).toBeInTheDocument()

        fireEvent.mouseLeave(toast)
        act(() => { vi.advanceTimersByTime(5000) })
        expect(screen.queryByText('A toast')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'A' }))
        fireEvent.click(screen.getByRole('button', { name: 'Public' }))
        expect(onAction).toHaveBeenCalledOnce()
        expect(screen.queryByText('A toast')).not.toBeInTheDocument()
    })

    it('keeps a single toast visible and dismisses on Escape', () => {
        render(<><Harness name="A" /><Harness name="B" /></>)
        fireEvent.click(screen.getByRole('button', { name: 'A' }))
        fireEvent.click(screen.getByRole('button', { name: 'B' }))
        expect(screen.queryByText('A toast')).not.toBeInTheDocument()
        expect(screen.getByText('B toast')).toBeInTheDocument()

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByText('B toast')).not.toBeInTheDocument()
    })
})
