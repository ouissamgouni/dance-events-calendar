import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAuth } from '../context/AuthContext';
import { useAnchoredToast, SIGN_IN_TOAST_MESSAGE } from './AnchoredToast';
import SignInNudge, { useSignInNudge } from './SignInNudge';
import AudiencePicker from './AudiencePicker';
import { trackSave } from '../utils/tracking';
import type { ShareAudience } from '../api';

interface Props {
    eventId: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
}

interface PopoverPos { top: number; left: number; }

const POPOVER_WIDTH = 272;

/**
 * Compute fixed-position coordinates for the audience popover. Clamps
 * horizontally and — when there isn't enough room below the trigger
 * for ``popoverHeight`` — flips ABOVE the trigger so the popover isn't
 * clipped at the bottom of the viewport (a recurring problem on event
 * cards near the page footer).
 */
function computePopoverPos(
    trigger: HTMLElement,
    popoverWidth: number,
    popoverHeight: number = 220,
): PopoverPos {
    const r = trigger.getBoundingClientRect();
    const margin = 8;
    const desiredLeft = r.left + r.width / 2 - popoverWidth / 2;
    const maxLeft = window.innerWidth - popoverWidth - margin;
    const left = Math.max(margin, Math.min(desiredLeft, maxLeft));
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const top =
        spaceBelow >= popoverHeight || spaceBelow >= spaceAbove
            ? r.bottom + 6
            : Math.max(margin, r.top - popoverHeight - 6);
    return { top, left };
}

export default function SaveEventButton({
    eventId,
    appearance = 'icon',
    size = 'md',
    stopPropagation = false,
    className = '',
}: Props) {
    const { isSaved, toggleSave, getSavedAudience, setSavedAudience } = useSavedEvents();
    const { user } = useAuth();
    const saved = isSaved(eventId);
    const iconSizeClass = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const toast = useAnchoredToast(buttonRef);
    const nudge = useSignInNudge('save');
    const [showNudge, setShowNudge] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [pendingAudience, setPendingAudience] = useState<ShareAudience>('private');
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);

    useEffect(() => {
        if (!popoverOpen || !buttonRef.current) return;
        const update = () => {
            if (buttonRef.current) {
                setPopoverPos(computePopoverPos(buttonRef.current, POPOVER_WIDTH));
            }
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [popoverOpen]);

    useEffect(() => {
        if (!popoverOpen) return;
        const onDocClick = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popoverRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
            setPopoverOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverOpen(false); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [popoverOpen]);

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) event.stopPropagation();
        toast.hide();
        if (saved && user) {
            // Already saved + signed-in: open popover with audience picker
            // + "Unsave" instead of toggling off blindly. Mirrors GoingButton.
            setPendingAudience(getSavedAudience(eventId));
            setPopoverOpen(true);
            return;
        }
        const wasSaved = saved;
        let nudgeShown = false;
        if (!wasSaved && !user && nudge.shouldShow) {
            nudge.markShown();
            setShowNudge(true);
            nudgeShown = true;
        }
        if (!wasSaved && user) {
            // Signed-in first-time save: emit the save with the user's
            // account-level default audience (privacy-by-default: friends),
            // optimistically flip local state, then open the visibility
            // popover so the user can adjust on the fly — parity with the
            // post-RSVP popover that GoingButton shows.
            const defaultAudience: ShareAudience =
                user.share_attendance_default_audience
                ?? (user.share_attendance_default === false ? 'private' : 'friends');
            toggleSave(eventId).then((ok) => {
                if (!ok) {
                    toast.show("Couldn't save \u2014 try again", 3200);
                    return;
                }
                // Persist the chosen default on the row so the local
                // audience map and the subscribers' fan-out tier agree.
                trackSave(eventId, 'save', defaultAudience)
                    .then(() => setSavedAudience(eventId, defaultAudience))
                    .catch(() => { /* row exists with default; non-fatal */ });
                setPendingAudience(defaultAudience);
                setPopoverOpen(true);
            });
            return;
        }
        toggleSave(eventId).then((ok) => {
            if (ok) {
                if (wasSaved) return;
                if (nudgeShown) return;
                toast.show(user ? 'Saved' : SIGN_IN_TOAST_MESSAGE, user ? 1400 : 2800);
            } else {
                toast.show(wasSaved ? "Couldn't unsave \u2014 try again" : "Couldn't save \u2014 try again", 3200);
            }
        });
    };

    // Live-apply: audience clicks in the popover write through to the
    // server immediately, no explicit Save button needed.
    const handlePopoverAudienceChange = (next: ShareAudience) => {
        setPendingAudience(next);
        setSavedAudience(eventId, next).then((ok) => {
            if (!ok) toast.show("Couldn't update visibility \u2014 try again", 3200);
        });
    };

    const unsave = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        toast.hide();
        setPopoverOpen(false);
        toggleSave(eventId).then((ok) => {
            if (!ok) toast.show("Couldn't unsave \u2014 try again", 3200);
        });
    };

    const popover = popoverOpen && popoverPos && createPortal(
        <div
            ref={popoverRef}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Saved event visibility"
            style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left, width: POPOVER_WIDTH }}
            className="z-[9000] border border-slate-200 bg-white p-3 shadow-xl text-left"
        >
            <p className="text-xs font-medium text-slate-800 mb-2">Edit visibility</p>
            <p className="text-[11px] text-slate-600 mb-2">
                Who can see you saved this event?
            </p>
            <AudiencePicker
                value={pendingAudience}
                onChange={handlePopoverAudienceChange}
                size="full"
                ariaLabel="Saved event visibility"
            />
            <p className="text-[11px] text-slate-500 mt-1.5">
                {pendingAudience === 'public'
                    ? 'Anyone who can view your profile will see this in your saved list.'
                    : pendingAudience === 'friends'
                        ? 'Only your mutual followers will see this in your saved list.'
                        : 'Only you can see this in your saved list.'}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={unsave}
                    className="text-xs px-2 py-1 text-rose-600 hover:bg-rose-50"
                >
                    Unsave
                </button>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPopoverOpen(false); }}
                    className="text-xs px-2 py-1 text-slate-600 hover:bg-slate-100"
                >
                    Close
                </button>
            </div>
        </div>,
        document.body,
    );

    const nudgeNode = showNudge && !user ? (
        <SignInNudge
            anchorRef={buttonRef}
            trigger="save"
            onClose={() => { nudge.dismiss(); setShowNudge(false); }}
        />
    ) : null;

    if (appearance === 'pill') {
        return (
            <span className="relative inline-flex">
                <button
                    ref={buttonRef}
                    onClick={handleClick}
                    className={`text-xs rounded-full px-3 py-1 transition flex items-center gap-1 ${saved ? 'text-slate-800 bg-slate-200 hover:bg-slate-300' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} ${className}`.trim()}
                    aria-label={saved ? 'Edit saved visibility' : 'Save event'}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                    </svg>
                    {saved ? 'Saved' : 'Save'}
                </button>
                {toast.node}
                {popover}
                {nudgeNode}
            </span>
        );
    }

    return (
        <span className="relative inline-flex">
            <button
                ref={buttonRef}
                onClick={handleClick}
                className={`rounded-full transition ${size === 'sm' ? 'p-0.5' : 'p-1.5'} ${saved ? 'text-slate-700 hover:text-slate-900' : 'text-slate-300 hover:text-slate-500'} ${className}`.trim()}
                aria-label={saved ? 'Edit saved visibility' : 'Save event'}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={iconSizeClass}>
                    <path d="M5 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14l-5-2.5L5 18V4Z" />
                </svg>
            </button>
            {toast.node}
            {popover}
            {nudgeNode}
        </span>
    );
}
