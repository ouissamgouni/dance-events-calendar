import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

const DELAY_MS = 450;
const MOVE_TOLERANCE_PX = 10;

/**
 * Returns a binder producing pointer handlers for a row: holding the pointer
 * still for ~450ms fires ``onLongPress`` and swallows the click that follows,
 * so a long-press never also triggers the row's tap action.
 */
export default function useLongPress() {
    const timer = useRef<number | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const fired = useRef(false);

    const clear = useCallback(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        start.current = null;
    }, []);

    useEffect(() => clear, [clear]);

    return useCallback((onLongPress: () => void) => ({
        onPointerDown: (e: PointerEvent) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            fired.current = false;
            start.current = { x: e.clientX, y: e.clientY };
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
                timer.current = null;
                fired.current = true;
                onLongPress();
            }, DELAY_MS);
        },
        onPointerMove: (e: PointerEvent) => {
            if (!start.current) return;
            if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE_PX) clear();
        },
        onPointerUp: clear,
        onPointerLeave: clear,
        onPointerCancel: clear,
        onClickCapture: (e: MouseEvent) => {
            if (!fired.current) return;
            fired.current = false;
            e.preventDefault();
            e.stopPropagation();
        },
        onContextMenu: (e: MouseEvent) => {
            if (fired.current || timer.current !== null) e.preventDefault();
        },
    }), [clear]);
}
