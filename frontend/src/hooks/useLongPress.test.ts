import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import useLongPress from './useLongPress'

const pointer = (x = 0, y = 0) => ({ pointerType: 'touch', button: 0, clientX: x, clientY: y }) as never
const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })

describe('useLongPress', () => {
    afterEach(() => vi.useRealTimers())

    it('fires after the hold delay and swallows the click that follows', () => {
        vi.useFakeTimers()
        const onLongPress = vi.fn()
        const { result } = renderHook(() => useLongPress())
        const handlers = result.current(onLongPress)

        handlers.onPointerDown(pointer())
        vi.advanceTimersByTime(500)
        expect(onLongPress).toHaveBeenCalledTimes(1)

        const e = click()
        handlers.onClickCapture(e as never)
        expect(e.stopPropagation).toHaveBeenCalled()
        expect(e.preventDefault).toHaveBeenCalled()
    })

    it('cancels when the pointer moves or lifts early and leaves the click alone', () => {
        vi.useFakeTimers()
        const onLongPress = vi.fn()
        const { result } = renderHook(() => useLongPress())
        const handlers = result.current(onLongPress)

        handlers.onPointerDown(pointer())
        handlers.onPointerMove(pointer(30, 0))
        vi.advanceTimersByTime(500)

        handlers.onPointerDown(pointer())
        handlers.onPointerUp()
        vi.advanceTimersByTime(500)
        expect(onLongPress).not.toHaveBeenCalled()

        const e = click()
        handlers.onClickCapture(e as never)
        expect(e.stopPropagation).not.toHaveBeenCalled()
    })
})
