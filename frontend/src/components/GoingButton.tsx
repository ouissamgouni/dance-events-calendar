import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useAuth } from '../context/AuthContext';
import { updateMyVisibility, type ShareAudience } from '../api';
import { trackShareConversion } from '../utils/tracking';
import { getActiveReferral } from '../hooks/useReferralAttribution';
import PostRsvpPopover, { type PostRsvpVariant } from './PostRsvpPopover';
import AudiencePicker from './AudiencePicker';
import { useAnchoredToast } from './AnchoredToast';
import {
    setLastUsedAudience,
    getLastUsedAudience,
} from '../utils/audiencePreference';

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

/** Heroicons globe / users / lock—current per-event audience tier on the
 *  Going pill. Mirrors the icons rendered by ``AudiencePicker``
 *  (🌐/👥/🔒) so the user can see at a glance who's seeing the RSVP. */
function AudienceTierIcon({ audience, className }: { audience: ShareAudience; className: string }) {
    if (audience === 'public') {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className={className}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0a8.949 8.949 0 0 0 4.951-1.488A3.987 3.987 0 0 0 13 16h-2a3.987 3.987 0 0 0-3.951 3.512A8.948 8.948 0 0 0 12 21Zm3-11.25a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18" />
            </svg>
        );
    }
    if (audience === 'friends') {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className={className}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
        );
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className={className}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
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
    const { isAttending, toggleAttending, setAudience, getAudience } = useAttendingEvents();
    const { user, refreshUser } = useAuth();
    const going = isAttending(eventId);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const errorToast = useAnchoredToast(triggerRef);
    // 'confirm' = off→going prompt, 'edit' = already going, edit visibility.
    const [popoverKind, setPopoverKind] = useState<'confirm' | 'edit' | null>(null);
    const [pendingAudience, setPendingAudience] = useState<ShareAudience>('private');
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
        // Dismiss any lingering anchored error toast on every click.
        errorToast.hide();
        if (going) {
            // Already going. For signed-in users, open the audience popover
            // (with a "Not going" action) instead of toggling off blindly.
            // Anonymous users have no audience, so keep the simple toggle.
            if (user) {
                setPostRsvpVariant(null);
                setPendingAudience(getAudience(eventId));
                setRememberDefault(false);
                setPopoverKind('edit');
                return;
            }
            setPostRsvpVariant(null);
            toggleAttending(eventId).then((ok) => {
                if (!ok) errorToast.show("Couldn't update \u2014 try again", 3200);
            });
            return;
        }
        if (user) {
            // Resolve default audience for this RSVP. Priority order:
            //   1. ``audience.lastUsed.<user_id>`` localStorage hint
            //      (Phase C — most recent explicit choice).
            //   2. ``user.share_attendance_default_audience`` (the
            //      account-level default; defaults to ``friends`` per
            //      privacy-by-default — see User model).
            //   3. Legacy boolean fallback for very old payloads.
            // Note: we use ``getLastUsedAudience`` (returns null when
            // unset) rather than ``defaultAudienceFor`` so the account
            // default actually wins when the user has no localStorage
            // hint yet.
            const defaultAudience: ShareAudience = getLastUsedAudience(user.user_id)
                ?? user.share_attendance_default_audience
                ?? (user.share_attendance_default === false ? 'private' : 'friends');
            // Always RSVP immediately with the default audience — no extra
            // confirmation click. The post-RSVP popover surfaces an inline
            // picker so the user can change visibility on the fly.
            toggleAttending(eventId, defaultAudience).then((ok) => {
                if (ok) {
                    maybeFireShareConversion();
                    showPostRsvp(
                        defaultAudience !== 'private'
                            ? 'signed-in-default-share'
                            : 'signed-in',
                    );
                } else {
                    errorToast.show("Couldn't mark you as going \u2014 try again", 3200);
                }
            });
            return;
        }
        toggleAttending(eventId).then((ok) => {
            if (ok) {
                // Anonymous users always get the unified popover (Sign-in
                // CTA + Share). Showing both options every time is
                // consistent with the signed-in flow and ensures the
                // share funnel is never skipped.
                maybeFireShareConversion();
                showPostRsvp('anon');
            } else {
                errorToast.show("Couldn't mark you as going \u2014 try again", 3200);
            }
        });
    };

    const persistRememberIfNeeded = useCallback((value: ShareAudience) => {
        if (!rememberDefault) return;
        const current = user?.share_attendance_default_audience
            ?? (user?.share_attendance_default ? 'public' : 'private');
        if (current === value) return;
        // Refresh AuthContext after success so subsequent RSVPs read the
        // new default without requiring a page reload.
        updateMyVisibility({ share_attendance_default_audience: value })
            .then(() => refreshUser())
            .catch(() => { /* ignore */ });
    }, [rememberDefault, user?.share_attendance_default, user?.share_attendance_default_audience, refreshUser]);

    const confirmGoing = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        errorToast.hide();
        const audience = pendingAudience;
        setPopoverKind(null);
        toggleAttending(eventId, audience).then((ok) => {
            if (ok) {
                persistRememberIfNeeded(audience);
                maybeFireShareConversion();
                showPostRsvp(audience !== 'private' ? 'signed-in-default-share' : 'signed-in');
            } else {
                errorToast.show("Couldn't mark you as going \u2014 try again", 3200);
            }
        });
    };

    const openEditShare = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        setPendingAudience(getAudience(eventId));
        setRememberDefault(false);
        setPopoverKind('edit');
    };

    const applyEditShare = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        errorToast.hide();
        const audience = pendingAudience;
        setPopoverKind(null);
        setAudience(eventId, audience).then((ok) => {
            if (ok) {
                if (user?.user_id) setLastUsedAudience(user.user_id, audience);
                persistRememberIfNeeded(audience);
            } else {
                errorToast.show("Couldn't update visibility \u2014 try again", 3200);
            }
        });
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

    /** Live audience change from the post-RSVP popover — applies
     *  immediately so the toast feels reactive. */
    const handlePostRsvpAudienceChange = useCallback((next: ShareAudience) => {
        setAudience(eventId, next).then((ok) => {
            if (!ok) errorToast.show("Couldn't update visibility \u2014 try again", 3200);
        });
    }, [eventId, setAudience, errorToast]);

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

    const postRsvpNode = postRsvpVariant ? (
        <PostRsvpPopover
            anchorRef={triggerRef}
            variant={postRsvpVariant}
            userName={user?.name ?? null}
            onClose={dismissPostRsvp}
            onShare={shareEventNow}
            audience={user ? getAudience(eventId) : undefined}
            onAudienceChange={user ? handlePostRsvpAudienceChange : undefined}
        />
    ) : null;

    const popover = popoverKind && popoverPos && createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Attendance visibility"
            style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left, width: POPOVER_WIDTH }}
            className="z-[1000] border border-slate-200 bg-white p-3 shadow-xl text-left"
        >
            <p className="text-xs font-medium text-slate-800 mb-2">
                {popoverKind === 'confirm' ? "You're going!" : 'Edit visibility'}
            </p>
            <p className="text-[11px] text-slate-600 mb-2">
                Who can see you in the attendee list?
            </p>
            <AudiencePicker
                value={pendingAudience}
                onChange={setPendingAudience}
                size="full"
                ariaLabel="Attendance visibility"
            />
            <p className="text-[11px] text-slate-500 mt-1.5">
                {pendingAudience === 'public'
                    ? 'You will appear in the attendee list to anyone who can view this event.'
                    : pendingAudience === 'friends'
                        ? 'Only your mutual followers will see your name in the attendee list.'
                        : 'You will be counted but not named.'}
            </p>
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
            <div className="mt-3 flex items-center justify-between gap-2">
                {popoverKind === 'edit' ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            errorToast.hide();
                            setPopoverKind(null);
                            setPostRsvpVariant(null);
                            toggleAttending(eventId).then((ok) => {
                                if (!ok) errorToast.show("Couldn't update \u2014 try again", 3200);
                            });
                        }}
                        className="text-xs px-2 py-1 text-rose-600 hover:bg-rose-50"
                    >
                        Not going
                    </button>
                ) : (
                    <span />
                )}
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPopoverKind(null); }}
                        className="text-xs px-2 py-1 text-slate-600 hover:bg-slate-100"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={popoverKind === 'confirm' ? confirmGoing : applyEditShare}
                        className="text-xs px-3 py-1 bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                        {popoverKind === 'confirm' ? "I'm going" : 'Save'}
                    </button>
                </div>
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
                        title={`Visibility: ${getAudience(eventId)} \u2014 click to edit`}
                        aria-label={`Visibility: ${getAudience(eventId)} \u2014 edit`}
                        className="px-2 transition flex items-center hover:bg-emerald-200 border-l border-emerald-200 text-emerald-700"
                    >
                        <AudienceTierIcon audience={getAudience(eventId)} className="w-3.5 h-3.5" />
                    </button>
                    {popover}
                    {postRsvpNode}
                    {errorToast.node}
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
                {errorToast.node}
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
            {errorToast.node}
        </div>
    );
}
