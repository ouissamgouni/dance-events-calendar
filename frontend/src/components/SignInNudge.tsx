import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

type Trigger = 'going' | 'save';

// Per-trigger session-scoped tracking. Shown / dismissed = won't auto-show
// again for that trigger until the page reloads.
const shownThisSession = new Set<Trigger>();

/**
 * Hook gating whether a sign-in nudge should appear for a given trigger.
 * Returns no-op state when the user is signed in.
 */
export function useSignInNudge(trigger: Trigger) {
    const { user } = useAuth();
    const [, force] = useState(0);
    const shouldShow = !user && !shownThisSession.has(trigger);
    const markShown = useCallback(() => {
        shownThisSession.add(trigger);
        force((n) => n + 1);
    }, [trigger]);
    const dismiss = useCallback(() => {
        shownThisSession.add(trigger);
        force((n) => n + 1);
    }, [trigger]);
    return { shouldShow, markShown, dismiss };
}

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 280;

function computePopoverPos(trigger: HTMLElement, popoverWidth: number): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - popoverWidth / 2;
    const maxLeft = window.innerWidth - popoverWidth - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    return { top: r.bottom + 6, left };
}

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    trigger: Trigger;
    onClose: () => void;
}

const HEADLINE: Record<Trigger, string> = {
    going: 'Sign in to get more from this',
    save: 'Sign in to keep this saved',
};

/**
 * Portal-rendered popover that anchors below the trigger element. Closes on
 * outside click or Escape.
 */
export default function SignInNudge({ anchorRef, trigger, onClose }: Props) {
    const location = useLocation();
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<PopoverPos | null>(null);

    // Position under the anchor and keep it positioned on scroll/resize.
    useEffect(() => {
        const el = anchorRef.current;
        if (!el) return;
        const update = () => {
            if (anchorRef.current) {
                setPos(computePopoverPos(anchorRef.current, POPOVER_WIDTH));
            }
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [anchorRef]);

    // Outside click + Escape close.
    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popoverRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [anchorRef, onClose]);

    if (!pos) return null;

    const next = encodeURIComponent(location.pathname + location.search);

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Sign in suggestion"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[1000] rounded-lg border border-slate-200 bg-white p-3 shadow-xl text-left"
        >
            <p className="text-xs font-semibold text-slate-800">{HEADLINE[trigger]}</p>
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-600 list-disc pl-4">
                <li>See who else is going</li>
                <li>Save events to your calendar</li>
                <li>Rate events and read reviews</li>
                <li>Share your calendar with others</li>
            </ul>
            <div className="mt-3 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="text-xs px-2 py-1 text-slate-600 hover:bg-slate-100"
                >
                    Not now
                </button>
                <Link
                    to={`/login?next=${next}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs px-3 py-1 bg-blue-500 text-white hover:bg-blue-600"
                >
                    Sign in
                </Link>
            </div>
        </div>,
        document.body,
    );
}
