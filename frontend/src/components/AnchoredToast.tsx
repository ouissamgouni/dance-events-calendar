import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface ToastPos { top: number; left: number; }

const MAX_WIDTH = 240;

function computeToastPos(anchor: HTMLElement, width: number): ToastPos {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - width / 2;
    const maxLeft = window.innerWidth - width - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    return { top: r.bottom + 6, left };
}

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
    const [pos, setPos] = useState<ToastPos | null>(null);
    const timersRef = useRef<{ fade?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> }>({});

    const clearTimers = useCallback(() => {
        if (timersRef.current.fade) clearTimeout(timersRef.current.fade);
        if (timersRef.current.hide) clearTimeout(timersRef.current.hide);
        timersRef.current = {};
    }, []);

    const hide = useCallback(() => {
        clearTimers();
        setVisible(false);
        setFading(false);
    }, [clearTimers]);

    const show = useCallback((msg: string, durationMs: number = 2200) => {
        const el = anchorRef.current;
        if (!el) return;
        clearTimers();
        setMessage(msg);
        setPos(computeToastPos(el, MAX_WIDTH));
        setVisible(true);
        setFading(false);
        const fadeAt = Math.max(durationMs - 250, 200);
        timersRef.current.fade = setTimeout(() => setFading(true), fadeAt);
        timersRef.current.hide = setTimeout(() => {
            setVisible(false);
            setFading(false);
        }, durationMs);
    }, [anchorRef, clearTimers]);

    // Reposition on scroll/resize while visible.
    useEffect(() => {
        if (!visible) return;
        const update = () => {
            if (anchorRef.current) {
                setPos(computeToastPos(anchorRef.current, MAX_WIDTH));
            }
        };
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [visible, anchorRef]);

    // Cleanup on unmount.
    useEffect(() => () => clearTimers(), [clearTimers]);

    const node = visible && pos ? createPortal(
        <div
            role="status"
            aria-live="polite"
            style={{ position: 'fixed', top: pos.top, left: pos.left, maxWidth: MAX_WIDTH }}
            className={`pointer-events-none z-[9000] text-center text-[11px] font-medium leading-snug text-slate-700 bg-white/75 backdrop-blur-sm px-2.5 py-1 shadow-md ring-1 ring-slate-200/70 transition-opacity duration-200 ${fading ? 'opacity-0' : 'opacity-100'}`}
        >
            {message}
        </div>,
        document.body,
    ) : null;

    return { show, hide, node };
}

export const SIGN_IN_TOAST_MESSAGE = 'Sign in to keep this across devices.';
export const SIGN_IN_GOING_TOAST_MESSAGE = 'Sign in to keep this across devices & see who else is going.';
