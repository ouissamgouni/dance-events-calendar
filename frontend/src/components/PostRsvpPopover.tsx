import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 280;
const AUTO_DISMISS_MS = 6000;

function computePopoverPos(trigger: HTMLElement): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - POPOVER_WIDTH / 2;
    const maxLeft = window.innerWidth - POPOVER_WIDTH - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    return { top: r.bottom + 6, left };
}

export type PostRsvpVariant = 'anon' | 'signed-in-default-share' | 'signed-in';

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    variant: PostRsvpVariant;
    /** User display name; only used when variant === 'signed-in-default-share'. */
    userName?: string | null;
    onClose: () => void;
    onShare: () => void;
    /** Only meaningful for variant === 'signed-in-default-share' — opens visibility editor. */
    onHideName?: () => void;
}

/**
 * Unified popover shown after a successful "I'm going" RSVP. Replaces the
 * previous mix of inline toast + share-nudge stack so users only see one
 * piece of feedback per click. Content adapts to sign-in state:
 *
 *   - 'anon'                       → sign-in CTA + share CTA
 *   - 'signed-in-default-share'    → "going as {name}" + hide-name + share
 *   - 'signed-in'                  → confirmation + share
 *
 * The first-ever anonymous RSVP uses the richer ``SignInNudge`` instead;
 * this popover handles every subsequent successful RSVP.
 */
export default function PostRsvpPopover({
    anchorRef,
    variant,
    userName,
    onClose,
    onShare,
    onHideName,
}: Props) {
    const location = useLocation();
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<PopoverPos | null>(null);

    // Position under the anchor and reposition on scroll/resize.
    useEffect(() => {
        const el = anchorRef.current;
        if (!el) return;
        const update = () => {
            if (anchorRef.current) {
                setPos(computePopoverPos(anchorRef.current));
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

    // Auto-dismiss if the user neither acts nor explicitly closes.
    useEffect(() => {
        const t = setTimeout(onClose, AUTO_DISMISS_MS);
        return () => clearTimeout(t);
    }, [onClose]);

    if (!pos) return null;

    const next = encodeURIComponent(location.pathname + location.search);

    // Headline copy is constant; sub-line varies by variant.
    let subline: React.ReactNode = null;
    if (variant === 'anon') {
        subline = (
            <span>
                Sign in to keep this across devices &amp; see who else is going.
            </span>
        );
    } else if (variant === 'signed-in-default-share') {
        subline = (
            <span>
                Going as <span className="font-medium">{userName}</span>.
                Other attendees can see your name.
            </span>
        );
    }

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="You're going"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[1100] border border-slate-200 bg-white p-3 shadow-xl text-left"
        >
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                aria-label="Dismiss"
                className="absolute top-1 right-1.5 text-slate-400 hover:text-slate-700 text-base leading-none p-1"
            >
                ×
            </button>
            <p className="text-xs font-semibold text-slate-800 pr-5">
                <span aria-hidden>🎉</span> You&rsquo;re going!
            </p>
            {subline && (
                <p className="mt-1 text-[11px] text-slate-600 leading-snug">{subline}</p>
            )}
            <div className="mt-3 flex items-center gap-2">
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onShare(); }}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 transition"
                >
                    Share with friends
                </button>
                {variant === 'anon' && (
                    <Link
                        to={`/login?next=${next}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs px-2.5 py-1.5 bg-blue-500 text-white hover:bg-blue-600 font-semibold whitespace-nowrap"
                    >
                        Sign in
                    </Link>
                )}
                {variant === 'signed-in-default-share' && onHideName && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onHideName(); }}
                        className="text-[11px] text-slate-600 hover:text-slate-800 hover:underline px-1 whitespace-nowrap"
                    >
                        Hide my name
                    </button>
                )}
                {variant === 'signed-in' && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onClose(); }}
                        className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5"
                    >
                        Close
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
}
