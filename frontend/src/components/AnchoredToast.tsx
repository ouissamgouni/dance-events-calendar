import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface ToastPos { top: number; left: number; }

export interface ToastAction {
    /** Accessible name; the chip itself renders only `icon`. */
    label: string;
    icon: ReactNode;
    onClick: () => void;
}

interface ShowOptions {
    action?: ToastAction;
    leading?: ReactNode;
}

type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
type Size = { width: number; height: number };

const MAX_WIDTH = 280;
const MARGIN = 8;
const GAP = 6;
const FADE_MS = 250;

/**
 * Place the toast under the anchor (flip above when it doesn't fit), starting
 * at the anchor's left edge and extending right, or ending at its right edge
 * and extending left when there isn't room on the right.
 */
export function computeToastPos(anchor: Rect, size: Size, viewport: Size): ToastPos {
    let left: number;
    if (anchor.left + size.width <= viewport.width - MARGIN) {
        left = anchor.left;
    } else if (anchor.right - size.width >= MARGIN) {
        left = anchor.right - size.width;
    } else {
        left = viewport.width - size.width - MARGIN;
    }
    left = Math.max(MARGIN, left);

    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - size.height;
    const fitsBelow = below + size.height <= viewport.height - MARGIN;
    const top = fitsBelow || above < MARGIN ? below : above;
    return { top, left };
}

// Only one anchored toast is visible app-wide.
let activeToast: { owner: object; hide: () => void } | null = null;

/**
 * Shared, portal-rendered toast anchored under a button. Used by
 * SaveEventButton and GoingButton so feedback is consistent across the
 * event card, leaflet popup, event modal, and event detail page — and so
 * the toast is never clipped by an `overflow:hidden` ancestor.
 */
export function useAnchoredToast(anchorRef: RefObject<HTMLElement | null>) {
    const [visible, setVisible] = useState(false);
    const [fading, setFading] = useState(false);
    const [message, setMessage] = useState<string>('');
    const [action, setAction] = useState<ToastAction | null>(null);
    const [leading, setLeading] = useState<ReactNode>(null);
    const [pos, setPos] = useState<ToastPos | null>(null);
    const toastRef = useRef<HTMLDivElement | null>(null);
    const timersRef = useRef<{ fade?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> }>({});
    const deadlineRef = useRef(0);
    const remainingRef = useRef<number | null>(null);
    const ownerRef = useRef({});

    const clearTimers = useCallback(() => {
        if (timersRef.current.fade) clearTimeout(timersRef.current.fade);
        if (timersRef.current.hide) clearTimeout(timersRef.current.hide);
        timersRef.current = {};
    }, []);

    const hide = useCallback(() => {
        clearTimers();
        remainingRef.current = null;
        setVisible(false);
        setFading(false);
        if (activeToast?.owner === ownerRef.current) activeToast = null;
    }, [clearTimers]);

    const startTimers = useCallback((durationMs: number) => {
        clearTimers();
        deadlineRef.current = Date.now() + durationMs;
        timersRef.current.fade = setTimeout(() => setFading(true), Math.max(durationMs - FADE_MS, 200));
        timersRef.current.hide = setTimeout(hide, durationMs);
    }, [clearTimers, hide]);

    const reposition = useCallback(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const el = toastRef.current;
        const size = el ? { width: el.offsetWidth, height: el.offsetHeight } : { width: MAX_WIDTH, height: 32 };
        setPos(computeToastPos(
            anchor.getBoundingClientRect(),
            size,
            { width: window.innerWidth, height: window.innerHeight },
        ));
    }, [anchorRef]);

    const show = useCallback((msg: string, durationMs: number = 2200, opts: ShowOptions = {}) => {
        if (!anchorRef.current) return;
        if (activeToast && activeToast.owner !== ownerRef.current) activeToast.hide();
        activeToast = { owner: ownerRef.current, hide };
        remainingRef.current = null;
        setMessage(msg);
        setAction(opts.action ?? null);
        setLeading(opts.leading ?? null);
        reposition();
        setVisible(true);
        setFading(false);
        startTimers(durationMs);
    }, [anchorRef, hide, reposition, startTimers]);

    const pause = useCallback(() => {
        if (!timersRef.current.hide) return;
        remainingRef.current = Math.max(deadlineRef.current - Date.now(), 0);
        clearTimers();
        setFading(false);
    }, [clearTimers]);

    const resume = useCallback(() => {
        if (remainingRef.current === null) return;
        const remaining = Math.max(remainingRef.current, 1500);
        remainingRef.current = null;
        startTimers(remaining);
    }, [startTimers]);

    // Re-measure once the real toast is in the DOM.
    useLayoutEffect(() => {
        if (visible) reposition();
    }, [visible, message, action, reposition]);

    useEffect(() => {
        if (!visible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') hide();
        };
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            window.removeEventListener('keydown', onKey);
        };
    }, [visible, reposition, hide]);

    // Cleanup on unmount.
    useEffect(() => {
        const owner = ownerRef.current;
        return () => {
            clearTimers();
            if (activeToast?.owner === owner) activeToast = null;
        };
    }, [clearTimers]);

    // z-index layering scale (keep transient overlays above modals so a
    // toast/popover triggered from inside a modal is never hidden behind it):
    //   base / map          0–8000
    //   modals & dialogs    9000–11000 (EventModal 9999, AppDialog 11000)
    //   toasts + anchored transient overlays  12000+
    const node = visible && pos ? createPortal(
        <div
            ref={toastRef}
            role="status"
            aria-live="polite"
            style={{ position: 'fixed', top: pos.top, left: pos.left, maxWidth: MAX_WIDTH }}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={action ? pause : undefined}
            onMouseLeave={action ? resume : undefined}
            onFocus={action ? pause : undefined}
            onBlur={action ? resume : undefined}
            className={`z-[12000] w-max animate-fade-in transition-opacity duration-200 motion-reduce:animate-none ${action
                ? 'pointer-events-auto flex items-center gap-1.5 rounded-field bg-surface py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-ink shadow-lg ring-1 ring-line'
                : 'pointer-events-none text-center text-xs font-medium leading-snug text-ink bg-surface/75 backdrop-blur-sm px-2.5 py-1 shadow-md ring-1 ring-slate-200/70'
                } ${fading ? 'opacity-0' : 'opacity-100'}`}
        >
            {action ? (
                <>
                    {leading && <span aria-hidden="true" className="flex text-sm leading-none">{leading}</span>}
                    <span>{message}</span>
                    <button
                        type="button"
                        aria-label={action.label}
                        title={action.label}
                        onClick={() => {
                            hide();
                            action.onClick();
                        }}
                        className="inline-flex min-h-6 items-center gap-1 rounded-field bg-action/10 px-1.5 text-action transition-colors hover:bg-action/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action pointer-coarse:min-h-8"
                    >
                        {action.icon}
                    </button>
                </>
            ) : message}
        </div>,
        document.body,
    ) : null;

    return { show, hide, node };
}

export const SIGN_IN_TOAST_MESSAGE = 'Sign in to keep this across devices.';
export const SIGN_IN_GOING_TOAST_MESSAGE = 'Sign in to keep this across devices & see who else is going.';
