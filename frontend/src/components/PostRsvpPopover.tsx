import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import AudiencePicker from './AudiencePicker';
import BottomSheet from './BottomSheet';
import useMediaQuery from '../hooks/useMediaQuery';
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
    eventTitle?: string;
    /** User display name; only used when variant === 'signed-in-default-share'. */
    userName?: string | null;
    /** When true, the event has already ended — headline uses past tense. */
    isPast?: boolean;
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
    eventTitle,
    userName,
    isPast = false,
    onClose,
    onShare,
    audience,
    onAudienceChange,
}: Props) {
    const location = useLocation();
    const isMobile = useMediaQuery('(max-width: 639px)');
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<PopoverPos | null>(null);

    // Position under the anchor and reposition on scroll/resize.
    useEffect(() => {
        if (isMobile) return;
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
    }, [anchorRef, isMobile]);

    // Outside click + Escape close.
    useEffect(() => {
        if (isMobile) return;
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
    }, [anchorRef, isMobile, onClose]);

    // Auto-dismiss if the user neither acts nor explicitly closes.
    useEffect(() => {
        const t = setTimeout(onClose, AUTO_DISMISS_MS);
        return () => clearTimeout(t);
    }, [onClose]);

    const next = encodeURIComponent(location.pathname + location.search);

    // Single-line headline. For signed-in users we inline "as <name>" so
    // the toast stays one row tall on mobile.
    const headline =
        variant === 'anon' || !userName
            ? (isPast ? 'You attended!' : "You're going!")
            : `${isPast ? 'Attended' : 'Going'} as ${userName}`;

    const showPicker = !!audience && !!onAudienceChange && variant !== 'anon';

    if (isMobile) {
        const sheetTitle = isPast ? 'You attended!' : "You're going!";
        return createPortal(
            <BottomSheet
                title={sheetTitle}
                subtitle={eventTitle}
                titleSize="large"
                onClose={onClose}
                layer="transient"
                headerLeading={<span aria-hidden className="text-base leading-none">🎉</span>}
                footer={(
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={onShare}
                            className="min-h-11 flex-1 rounded-field bg-action px-4 py-2 text-sm font-semibold text-white"
                        >
                            Share
                        </button>
                        {variant === 'anon' && (
                            <Link
                                to={`/login?next=${next}`}
                                className="flex min-h-11 flex-1 items-center justify-center rounded-field bg-action px-4 py-2 text-sm font-semibold text-white"
                            >
                                Sign in
                            </Link>
                        )}
                    </div>
                )}
            >
                {variant === 'anon' && (
                    <p className="text-base leading-6 text-ink-soft">
                        Sign in to keep this across devices.
                    </p>
                )}
                {showPicker && (
                    <div>
                        <p className="mb-3 text-base leading-6 text-ink-soft">Who can see you in the attendee list?</p>
                        <AudiencePicker
                            value={audience!}
                            onChange={onAudienceChange!}
                            size="sheet"
                            ariaLabel="Attendance visibility"
                        />
                    </div>
                )}
            </BottomSheet>,
            document.body,
        );
    }

    if (!pos) return null;

    return createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="You're going"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            className="z-[12000] border border-line bg-surface p-2 shadow-xl text-left"
        >
            <div className="flex items-center gap-1.5 pr-4">
                <span aria-hidden className="text-sm leading-none">🎉</span>
                <p className="text-xs font-semibold text-ink truncate flex-1">
                    {headline}
                </p>
            </div>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                aria-label="Dismiss"
                className="absolute top-0.5 right-1 text-muted hover:text-ink text-base leading-none p-1"
            >
                ×
            </button>
            {variant === 'anon' && (
                <p className="mt-1 text-[11px] text-ink-soft leading-snug">
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
                    className="flex-1 bg-action hover:bg-action text-white text-xs font-semibold px-2 py-1.5 transition whitespace-nowrap"
                >
                    Share
                </button>
                {variant === 'anon' && (
                    <Link
                        to={`/login?next=${next}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs px-2 py-1.5 bg-action text-white hover:bg-action font-semibold whitespace-nowrap"
                    >
                        Sign in
                    </Link>
                )}
            </div>
        </div>,
        document.body,
    );
}
