import { useCallback, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlagsReady, useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import { useAnchoredToast, SIGN_IN_TOAST_MESSAGE } from './AnchoredToast';
import SignInNudge, { useSignInNudge } from './SignInNudge';
import RsvpVisibilitySheet from './RsvpVisibilitySheet';
import { trackSave } from '../utils/tracking';
import { defaultRsvpAudienceFor, setLastUsedAudience } from '../utils/audiencePreference';
import type { ShareAudience } from '../api';

interface Props {
    eventId: string;
    eventTitle?: string;
    appearance?: 'icon' | 'pill';
    size?: 'sm' | 'md';
    stopPropagation?: boolean;
    className?: string;
    labelClassName?: string;
}

const SAVED_AUDIENCE_DESCRIPTIONS: Record<ShareAudience, string> = {
    public: 'Anyone who can view your profile will see this in your saved list.',
    friends: 'Only your mutual followers will see this in your saved list.',
    private: 'Only you can see this in your saved list.',
};

export default function SaveEventButton({
    eventId,
    eventTitle,
    appearance = 'icon',
    stopPropagation = false,
    className = '',
    labelClassName = '',
}: Props) {
    const { isSaved, toggleSave, setSavedAudience } = useSavedEvents();
    const { user } = useAuth();
    const { appAuthGateEnabled } = useOptionalFeatureFlags();
    const featureFlagsReady = useFeatureFlagsReady();
    const location = useLocation();
    const navigate = useNavigate();
    const saved = isSaved(eventId);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const toast = useAnchoredToast(buttonRef);
    const nudge = useSignInNudge('save');
    const [showNudge, setShowNudge] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [pendingAudience, setPendingAudience] = useState<ShareAudience>('private');

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) event.stopPropagation();
        toast.hide();
        if (!user && !featureFlagsReady) return;
        if (!user && appAuthGateEnabled) {
            const next = encodeURIComponent(
                `${location.pathname}${location.search}${location.hash}`,
            );
            navigate(`/login?next=${next}`);
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
            // account-level default audience, optimistically flip local state,
            // then open the visibility popover so the user can adjust on the
            // fly — parity with the post-RSVP popover that GoingButton shows.
            const defaultAudience = defaultRsvpAudienceFor(user);
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
            if (!ok) {
                toast.show("Couldn't update visibility \u2014 try again", 3200);
                return;
            }
            if (user?.user_id) setLastUsedAudience(user.user_id, next);
        });
    };

    const unsave = () => {
        toast.hide();
        setPopoverOpen(false);
        toggleSave(eventId).then((ok) => {
            if (!ok) toast.show("Couldn't unsave \u2014 try again", 3200);
        });
    };

    const closePopover = useCallback(() => setPopoverOpen(false), []);

    const popover = popoverOpen ? (
        <RsvpVisibilitySheet
            anchorRef={buttonRef}
            emoji="🔖"
            title="Saved!"
            subtitle={eventTitle}
            question="Who can see you saved this event?"
            audience={pendingAudience}
            onAudienceChange={handlePopoverAudienceChange}
            pickerAriaLabel="Saved event visibility"
            description={SAVED_AUDIENCE_DESCRIPTIONS[pendingAudience]}
            secondaryAction={{ label: 'Unsave', onClick: unsave, tone: 'danger' }}
            onClose={closePopover}
        />
    ) : null;

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
                    className={`flex h-10 items-center gap-2 rounded-xl bg-action-tile px-3 text-sm transition-colors focus-visible:outline-none ${className} ${saved ? 'text-saved' : 'text-ink-soft hover:text-ink'}`.trim()}
                    aria-label={saved ? 'Unsave event' : 'Save event'}
                >
                    <span className="flex h-[22px] w-[22px] items-center justify-center" aria-hidden="true">
                        <svg
                            data-icon-family="bookmark"
                            data-icon-state={saved ? 'saved' : 'default'}
                            viewBox="0 0 24 24"
                            fill={saved ? 'currentColor' : 'none'}
                            stroke="currentColor"
                            strokeWidth={1.7}
                            className="h-[17px] w-[17px]"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4V5z"
                            />
                        </svg>
                    </span>
                    <span className={labelClassName}>{saved ? 'Saved' : 'Save'}</span>
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
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-action-tile transition-colors focus-visible:outline-none ${className} ${saved ? 'text-saved' : 'text-ink-soft hover:text-ink'}`.trim()}
                aria-label={saved ? 'Unsave event' : 'Save event'}
            >
                <span className="flex h-[22px] w-[22px] items-center justify-center" aria-hidden="true">
                    <svg
                        data-icon-family="bookmark"
                        data-icon-state={saved ? 'saved' : 'default'}
                        viewBox="0 0 24 24"
                        fill={saved ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeWidth={1.7}
                        className="h-[17px] w-[17px]"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4V5z"
                        />
                    </svg>
                </span>
            </button>
            {toast.node}
            {popover}
            {nudgeNode}
        </span>
    );
}
