import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import AudiencePicker from './AudiencePicker';
import type { ShareAudience } from '../api';

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 232;
const AUTO_DISMISS_MS = 5000;

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
    /** Current visibility for this RSVP. When provided (signed-in), the
     *  popover renders an inline AudiencePicker so the user can change it
     *  without re-opening a separate dialog. */
    audience?: ShareAudience;
    onAudienceChange?: (next: ShareAudience) => void;
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
    audience,
    onAudienceChange,
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

    // Single-line headline. For signed-in users we inline "as <name>" so
    // the toast stays one row tall on mobile.
    const headline =
        variant === 'anon' || !userName
            ? "You're going!"
            : `Going as ${userName}`;

    const showPicker = !!audience && !!onAudienceChange && variant !== 'anon';

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="You're going"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[1100] border border-slate-200 bg-white p-2 shadow-xl text-left"
        >
            <div className="flex items-center gap-1.5 pr-4">
                <span aria-hidden className="text-sm leading-none">🎉</span>
                <p className="text-xs font-semibold text-slate-800 truncate flex-1">
                    {headline}
                </p>
            </div>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                aria-label="Dismiss"
                className="absolute top-0.5 right-1 text-slate-400 hover:text-slate-700 text-base leading-none p-1"
            >
                ×
            </button>
            {variant === 'anon' && (
                <p className="mt-1 text-[11px] text-slate-600 leading-snug">
                    Sign in to keep this across devices.
                </p>
            )}
            <div className="mt-2 flex items-center gap-1.5">
                {showPicker && (
                    <AudiencePicker
                        value={audience!}
                        onChange={onAudienceChange!}
                        size="compact"
                        ariaLabel="Attendance visibility"
                    />
                )}
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onShare(); }}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-2 py-1.5 transition whitespace-nowrap"
                >
                    Share
                </button>
                {variant === 'anon' && (
                    <Link
                        to={`/login?next=${next}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs px-2 py-1.5 bg-blue-500 text-white hover:bg-blue-600 font-semibold whitespace-nowrap"
                    >
                        Sign in
                    </Link>
                )}
            </div>
        </div>,
        document.body,
    );
}
