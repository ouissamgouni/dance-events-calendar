import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useAuth } from '../context/AuthContext';
import { updateUserPreferences } from '../api';
import { trackShareConversion } from '../utils/tracking';
import { getActiveReferral } from '../hooks/useReferralAttribution';
import PostRsvpPopover, { type PostRsvpVariant } from './PostRsvpPopover';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    /**
     * When true, the not-going pill renders as the page's primary CTA
     * (larger, brand-colored). Already-going state keeps the existing
     * "Going" segmented control to avoid noisy re-emphasis.
     */
    prominent?: boolean;
    stopPropagation?: boolean;
    className?: string;
}

/** Heroicons hand-raised — outline when not going, solid when going */
function RaisedHandIcon({ solid, className }: { solid: boolean; className: string }) {
    if (solid) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
                <path d="M10.5 1.875C10.5 1.25368 11.0037 0.75 11.625 0.75C12.2463 0.75 12.75 1.25368 12.75 1.875V10.0938C13.2674 10.2561 13.7708 10.4757 14.25 10.7527V3.375C14.25 2.75368 14.7537 2.25 15.375 2.25C15.9963 2.25 16.5 2.75368 16.5 3.375V14.3122C15.0821 14.5501 13.8891 15.451 13.2506 16.6852C14.4554 16.0866 15.8134 15.75 17.25 15.75C17.6642 15.75 18 15.4142 18 15V12.75L18 12.7336C18.0042 11.8771 18.3339 11.0181 18.9885 10.3635C19.4278 9.92417 20.1402 9.92417 20.5795 10.3635C21.0188 10.8028 21.0188 11.5152 20.5795 11.9545C20.361 12.173 20.2514 12.4567 20.25 12.7445L20.25 12.75L20.25 15.75H20.2454C20.1863 17.2558 19.5623 18.6877 18.4926 19.7574L16.7574 21.4926C15.6321 22.6179 14.106 23.25 12.5147 23.25H10.5C6.35786 23.25 3 19.8921 3 15.75V6.375C3 5.75368 3.50368 5.25 4.125 5.25C4.74632 5.25 5.25 5.75368 5.25 6.375V11.8939C5.71078 11.4421 6.2154 11.0617 6.75 10.7527V3.375C6.75 2.75368 7.25368 2.25 7.875 2.25C8.49632 2.25 9 2.75368 9 3.375V9.90069C9.49455 9.80023 9.99728 9.75 10.5 9.75V1.875Z" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className={className}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m0 0a4.49 4.49 0 0 1 .437-1.997" />
        </svg>
    );
}

/** Heroicons eye / eye-slash — visibility indicator next to "Going ✓". */
function VisibilityIcon({ shared, className }: { shared: boolean; className: string }) {
    if (shared) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
        </svg>
    );
}

interface PopoverPos { top: number; left: number; }

/**
 * Compute fixed-position coordinates for a popover anchored under a trigger
 * element. Clamps horizontally to the viewport so cards near the right edge
 * don't push the popover off-screen.
 */
function computePopoverPos(trigger: HTMLElement, popoverWidth: number): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - popoverWidth / 2;
    const maxLeft = window.innerWidth - popoverWidth - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    return { top: r.bottom + 6, left };
}

const POPOVER_WIDTH = 272; // Tailwind w-68 equiv (matches className below).

export default function GoingButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    prominent = false,
    stopPropagation = false,
    className = '',
}: Props) {
    const { isAttending, isSharingPublicly, toggleAttending, setSharePublicly } = useAttendingEvents();
    const { user, refreshUser } = useAuth();
    const going = isAttending(eventId);
    const sharing = isSharingPublicly(eventId);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    // 'confirm' = off→going prompt, 'edit' = already going, edit visibility.
    const [popoverKind, setPopoverKind] = useState<'confirm' | 'edit' | null>(null);
    const [pendingShare, setPendingShare] = useState<boolean>(false);
    const [rememberDefault, setRememberDefault] = useState<boolean>(false);
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
    // Unified post-RSVP popover (replaces the old inline toast + separate
    // share-nudge stack). Only one is ever visible at a time.
    const [postRsvpVariant, setPostRsvpVariant] = useState<PostRsvpVariant | null>(null);

    // Position the popover under the trigger and keep it positioned on
    // scroll/resize while open.
    useEffect(() => {
        if (!popoverKind || !triggerRef.current) return;
        const update = () => {
            if (triggerRef.current) {
                setPopoverPos(computePopoverPos(triggerRef.current, POPOVER_WIDTH));
            }
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [popoverKind]);

    // Close popover on outside click / Escape.
    useEffect(() => {
        if (!popoverKind) return;
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
            setPopoverKind(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverKind(null); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [popoverKind]);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) e.stopPropagation();
        if (going) {
            // Toggling off: dismiss any lingering popover so we never show
            // a "You're going!" message on a "not going" click.
            setPostRsvpVariant(null);
            toggleAttending(eventId);
            return;
        }
        if (user) {
            // If the user has already opted in to sharing by default, skip the
            // confirmation popover and mark going publicly immediately, then
            // surface the unified post-RSVP popover with name/visibility info.
            if (user.share_attendance_default === true) {
                toggleAttending(eventId, true);
                maybeFireShareConversion();
                showPostRsvp('signed-in-default-share');
                return;
            }
            setPendingShare(user.share_attendance_default ?? false);
            setRememberDefault(false);
            setPopoverKind('confirm');
        } else {
            toggleAttending(eventId);
            // Anonymous users always get the unified popover (Sign-in CTA +
            // Share). Showing both options every time is consistent with the
            // signed-in flow and ensures the share funnel is never skipped.
            maybeFireShareConversion();
            showPostRsvp('anon');
        }
    };

    const persistRememberIfNeeded = useCallback((value: boolean) => {
        if (!rememberDefault) return;
        if ((user?.share_attendance_default ?? false) === value) return;
        // Refresh AuthContext after success so subsequent RSVPs read the
        // new default without requiring a page reload.
        updateUserPreferences({ share_attendance_default: value })
            .then(() => refreshUser())
            .catch(() => { /* ignore */ });
    }, [rememberDefault, user?.share_attendance_default, refreshUser]);

    const confirmGoing = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        toggleAttending(eventId, pendingShare);
        persistRememberIfNeeded(pendingShare);
        setPopoverKind(null);
        maybeFireShareConversion();
        showPostRsvp(pendingShare ? 'signed-in-default-share' : 'signed-in');
    };

    const openEditShare = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        setPendingShare(sharing);
        setRememberDefault(false);
        setPopoverKind('edit');
    };

    const applyEditShare = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        setSharePublicly(eventId, pendingShare);
        persistRememberIfNeeded(pendingShare);
        setPopoverKind(null);
    };

    const iconSizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
    const tooltip = going ? 'Not going' : "I'm going";

    /**
     * Surface the unified post-RSVP popover. Fires every time the user
     * transitions off→going so they always have a chance to share.
     */
    const showPostRsvp = useCallback((variant: PostRsvpVariant) => {
        setPostRsvpVariant(variant);
    }, []);

    /**
     * If the visitor arrived via a `?ref=share&src=` link captured by
     * useReferralAttribution and is now RSVPing for the same event,
     * record the conversion against the originating share_code.
     * Best-effort and analytics-only: failures and missing referrals
     * are silent.
     */
    const maybeFireShareConversion = useCallback(() => {
        const ref = getActiveReferral();
        if (!ref) return;
        if (ref.eventId !== eventId) return;
        trackShareConversion(eventId, ref.src);
    }, [eventId]);

    const dismissPostRsvp = useCallback(() => {
        setPostRsvpVariant(null);
    }, []);

    const shareEventNow = useCallback(async () => {
        const url = `${window.location.origin}/event/${eventId}`;
        const canNativeShare =
            typeof navigator !== 'undefined' && typeof navigator.share === 'function';
        if (canNativeShare) {
            try {
                await navigator.share({ title: 'Join me!', text: 'Join me at this event', url });
            } catch {
                /* user cancelled */
            }
        } else {
            try {
                await navigator.clipboard.writeText(url);
            } catch {
                /* ignore */
            }
        }
        setPostRsvpVariant(null);
    }, [eventId]);

    const openHideName = useCallback(() => {
        // Reuse the existing visibility-edit popover so the user can flip
        // off the public-attendance default for this event.
        setPostRsvpVariant(null);
        setPendingShare(false);
        setRememberDefault(false);
        setPopoverKind('edit');
    }, []);

    const postRsvpNode = postRsvpVariant ? (
        <PostRsvpPopover
            anchorRef={triggerRef}
            variant={postRsvpVariant}
            userName={user?.name ?? null}
            onClose={dismissPostRsvp}
            onShare={shareEventNow}
            onHideName={openHideName}
        />
    ) : null;

    const popover = popoverKind && popoverPos && createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Attendance visibility"
            style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left, width: POPOVER_WIDTH }}
            className="z-[1000] rounded-lg border border-slate-200 bg-white p-3 shadow-xl text-left"
        >
            <p className="text-xs font-medium text-slate-800 mb-2">
                {popoverKind === 'confirm' ? "You're going!" : 'Edit visibility'}
            </p>
            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                    type="checkbox"
                    checked={pendingShare}
                    onChange={(e) => setPendingShare(e.target.checked)}
                    className="mt-0.5"
                />
                <span>
                    Show my name to other signed-in users going to this event.
                    <span className="block text-[11px] text-slate-500 mt-0.5">
                        {pendingShare
                            ? 'You will appear in the attendee list.'
                            : 'You will be counted but not named.'}
                    </span>
                </span>
            </label>
            {/* Only offer to save a new default when the user is editing
                 visibility on an existing attendance; in the initial confirm
                 flow the preference is managed from /account. */}
            {popoverKind === 'edit' && (
                <label className="mt-2 flex items-start gap-2 text-[11px] text-slate-600 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={rememberDefault}
                        onChange={(e) => setRememberDefault(e.target.checked)}
                        className="mt-0.5"
                    />
                    <span>Make this my default for future events</span>
                </label>
            )}
            <div className="mt-3 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPopoverKind(null); }}
                    className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={popoverKind === 'confirm' ? confirmGoing : applyEditShare}
                    className="text-xs px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                >
                    {popoverKind === 'confirm' ? "I'm going" : 'Save'}
                </button>
            </div>
        </div>,
        document.body,
    );

    if (appearance === 'pill') {
        // When the user is going AND signed-in, render the pill as a unified
        // segmented control: left half = toggle going, right half = visibility
        // icon (replaces the redundant ✓). Anonymous "going" keeps the simple
        // pill (no visibility concept).
        if (going && user) {
            return (
                <div
                    className={`relative inline-flex items-stretch rounded-full overflow-hidden bg-emerald-100 text-emerald-800 ${className}`.trim()}
                >
                    <button
                        ref={triggerRef}
                        type="button"
                        onClick={handleClick}
                        title={tooltip}
                        aria-label={tooltip}
                        className="text-xs px-3 py-1 transition flex items-center gap-1.5 hover:bg-emerald-200"
                    >
                        <RaisedHandIcon solid className="w-3.5 h-3.5" />
                        Going
                    </button>
                    <button
                        type="button"
                        onClick={openEditShare}
                        title={sharing ? 'Sharing your name — click to edit visibility' : 'Hidden — click to edit visibility'}
                        aria-label={sharing ? 'Visibility: public — edit' : 'Visibility: private — edit'}
                        className={`px-2 transition flex items-center hover:bg-emerald-200 border-l border-emerald-200 ${sharing ? 'text-emerald-700' : 'text-slate-500'}`}
                    >
                        <VisibilityIcon shared={sharing} className="w-3.5 h-3.5" />
                    </button>
                    {popover}
                    {postRsvpNode}
                </div>
            );
        }
        return (
            <div className="relative inline-flex items-center">
                <button
                    ref={triggerRef}
                    onClick={handleClick}
                    title={tooltip}
                    aria-label={tooltip}
                    className={
                        prominent && !going
                            ? `rounded-full px-5 py-2 text-sm font-semibold shadow-sm transition flex items-center gap-2 bg-rose-600 text-white hover:bg-rose-700 ${className}`.trim()
                            : `text-xs rounded-full px-3 py-1 transition flex items-center gap-1.5 ${going ? 'text-emerald-800 bg-emerald-100 hover:bg-emerald-200' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} ${className}`.trim()
                    }
                >
                    <RaisedHandIcon
                        solid={going}
                        className={prominent && !going ? 'w-4 h-4' : 'w-3.5 h-3.5'}
                    />
                    {going ? 'Going' : "I'm going"}
                </button>
                {popover}
                {postRsvpNode}
            </div>
        );
    }

    return (
        <div className="relative inline-flex items-center justify-center">
            <button
                ref={triggerRef}
                onClick={handleClick}
                aria-label={tooltip}
                title={tooltip}
                className={`relative rounded-full transition-colors ${size === 'sm' ? 'p-0.5' : 'p-1.5'} ${going ? 'text-emerald-500 hover:text-emerald-700' : 'text-slate-400 hover:text-slate-600'} ${className}`.trim()}
            >
                <RaisedHandIcon solid={going} className={iconSizeClass} />
            </button>

            {popover}
            {postRsvpNode}
        </div>
    );
}
