import { useState, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, UserRoundCheck, UserRoundPlus } from 'lucide-react';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlagsReady, useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import type { ShareAudience } from '../api';
import { trackShareConversion } from '../utils/tracking';
import { getActiveReferral } from '../hooks/useReferralAttribution';
import PostRsvpPopover, { type PostRsvpVariant } from './PostRsvpPopover';
import RsvpVisibilitySheet from './RsvpVisibilitySheet';
import { useAnchoredToast } from './AnchoredToast';
import AudienceTierIcon from './AudienceTierIcon';
import {
    AUDIENCE_TIER_LABELS,
    defaultRsvpAudienceFor,
    getRememberAudience,
    setLastUsedAudience,
} from '../utils/audiencePreference';

interface Props {
    eventId: string;
    eventTitle?: string;
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
    labelClassName?: string;
    /** When true, the event has already ended — labels use past tense ("Attended"). */
    isPast?: boolean;
    iconVariant?: 'hand' | 'person';
}

function RaisedHandIcon({ solid, className }: { solid: boolean; className: string }) {
    return (
        <span className={`flex h-[22px] w-[22px] items-center justify-center ${className}`.trim()} aria-hidden="true">
            <svg
                data-icon-family="hand"
                data-icon-state={solid ? 'going' : 'default'}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.7}
                className="h-[17px] w-[17px]"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m0 0a4.49 4.49 0 0 1 .437-1.997"
                />
            </svg>
        </span>
    );
}

function PersonAttendanceIcon({ solid, className }: { solid: boolean; className: string }) {
    const PersonIcon = solid ? UserRoundCheck : UserRoundPlus;
    return (
        <span className={`flex h-[22px] w-[22px] items-center justify-center ${className}`.trim()} aria-hidden="true">
            <PersonIcon
                data-icon-family="person"
                data-icon-state={solid ? 'going' : 'default'}
                className="h-3.5 w-3.5"
                strokeWidth={1.9}
            />
        </span>
    );
}

function AttendanceIcon({
    variant,
    solid,
    className,
}: {
    variant: 'hand' | 'person';
    solid: boolean;
    className: string;
}) {
    return variant === 'person'
        ? <PersonAttendanceIcon solid={solid} className={className} />
        : <RaisedHandIcon solid={solid} className={className} />;
}

export default function GoingButton({
    eventId,
    eventTitle,
    appearance = 'icon',
    stopPropagation = false,
    className = '',
    labelClassName = '',
    isPast = false,
    iconVariant,
}: Props) {
    const { isAttending, toggleAttending, setAudience, getAudience } = useAttendingEvents();
    const { user } = useAuth();
    const { goingButtonIconVariant, appAuthGateEnabled, rsvpRememberVisibilityEnabled } = useOptionalFeatureFlags();
    const featureFlagsReady = useFeatureFlagsReady();
    const location = useLocation();
    const navigate = useNavigate();
    const resolvedIconVariant = iconVariant ?? goingButtonIconVariant;
    const going = isAttending(eventId);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const errorToast = useAnchoredToast(triggerRef);
    const [editOpen, setEditOpen] = useState(false);
    const [pendingAudience, setPendingAudience] = useState<ShareAudience>('private');
    // Unified post-RSVP popover (replaces the old inline toast + separate
    // share-nudge stack). Only one is ever visible at a time.
    const [postRsvpVariant, setPostRsvpVariant] = useState<PostRsvpVariant | null>(null);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (stopPropagation) e.stopPropagation();
        // Dismiss any lingering anchored error toast on every click.
        errorToast.hide();
        if (!user && !featureFlagsReady) return;
        if (!user && appAuthGateEnabled) {
            const next = encodeURIComponent(
                `${location.pathname}${location.search}${location.hash}`,
            );
            navigate(`/login?next=${next}`);
            return;
        }
        if (going) {
            // Already going. For signed-in users, open the audience popover
            // (with a "Not going" action) instead of toggling off blindly.
            // Anonymous users have no audience, so keep the simple toggle.
            if (user) {
                setPostRsvpVariant(null);
                setPendingAudience(getAudience(eventId));
                setEditOpen(true);
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
            //   1. ``user.share_attendance_default_audience`` (the
            //      account-level default; defaults to ``public`` so
            //      attendee lists populate by default — see User model).
            //      When the user explicitly set this in /account it MUST
            //      win over any stale ``audience.lastUsed`` localStorage
            //      hint from a previous one-off choice.
            //   2. ``audience.lastUsed.<user_id>`` localStorage hint
            //      (Phase C — last explicit per-event choice; only used
            //      when the account-level default is unset).
            //   3. Legacy boolean fallback for very old payloads.
            const defaultAudience = defaultRsvpAudienceFor(user);
            const skipSheet = rsvpRememberVisibilityEnabled && getRememberAudience(user.user_id) === true;
            // Always RSVP immediately with the default audience — no extra
            // confirmation click. The post-RSVP popover surfaces an inline
            // picker so the user can change visibility on the fly.
            toggleAttending(eventId, defaultAudience).then((ok) => {
                if (ok) {
                    maybeFireShareConversion();
                    if (skipSheet) {
                        errorToast.show(isPast ? 'You attended' : "You're going", 3000, {
                            leading: '🎉',
                            action: {
                                icon: (
                                    <>
                                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                                        <AudienceTierIcon audience={defaultAudience} className="h-3.5 w-3.5" />
                                    </>
                                ),
                                label: `Visibility: ${AUDIENCE_TIER_LABELS[defaultAudience]} \u2014 edit`,
                                onClick: () => {
                                    setPendingAudience(defaultAudience);
                                    setEditOpen(true);
                                },
                            },
                        });
                    }
                } else {
                    setPostRsvpVariant(null);
                    errorToast.show("Couldn't mark you as going \u2014 try again", 3200);
                }
            });
            if (skipSheet) return;
            showPostRsvp(
                defaultAudience !== 'private'
                    ? 'signed-in-default-share'
                    : 'signed-in',
            );
            return;
        }
        toggleAttending(eventId).then((ok) => {
            if (ok) {
                maybeFireShareConversion();
            } else {
                setPostRsvpVariant(null);
                errorToast.show("Couldn't mark you as going \u2014 try again", 3200);
            }
        });
        // Anonymous users always get the unified popover (Sign-in CTA + Share).
        showPostRsvp('anon');
    };

    const openEditShare = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        setPendingAudience(getAudience(eventId));
        setEditOpen(true);
    };

    const goingLabel = isPast ? 'Attended' : 'Going';
    const markLabel = isPast ? 'I attended' : "I'm going";
    const unmarkLabel = isPast ? "Didn't attend" : 'Not going';
    const tooltip = going ? unmarkLabel : markLabel;

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
    const userId = user?.user_id;
    const handlePostRsvpAudienceChange = useCallback((next: ShareAudience) => {
        setAudience(eventId, next).then((ok) => {
            if (!ok) {
                errorToast.show("Couldn't update visibility \u2014 try again", 3200);
                return;
            }
            if (userId) setLastUsedAudience(userId, next);
        });
    }, [eventId, setAudience, errorToast, userId]);

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
            eventTitle={eventTitle}
            isPast={isPast}
            onClose={dismissPostRsvp}
            onShare={shareEventNow}
            audience={user ? getAudience(eventId) : undefined}
            onAudienceChange={user ? handlePostRsvpAudienceChange : undefined}
        />
    ) : null;

    // Live-apply: every audience click in the edit sheet writes through immediately.
    const handlePopoverAudienceChange = (next: ShareAudience) => {
        setPendingAudience(next);
        setAudience(eventId, next).then((ok) => {
            if (!ok) {
                errorToast.show("Couldn't update visibility \u2014 try again", 3200);
                return;
            }
            if (user?.user_id) setLastUsedAudience(user.user_id, next);
        });
    };

    const stopGoing = () => {
        errorToast.hide();
        setEditOpen(false);
        setPostRsvpVariant(null);
        toggleAttending(eventId).then((ok) => {
            if (!ok) errorToast.show("Couldn't update \u2014 try again", 3200);
        });
    };

    const closeEdit = useCallback(() => setEditOpen(false), []);

    const popover = editOpen ? (
        <RsvpVisibilitySheet
            anchorRef={triggerRef}
            kind="going"
            emoji="🎉"
            title={isPast ? 'You attended!' : "You're going!"}
            subtitle={eventTitle}
            audience={pendingAudience}
            onAudienceChange={handlePopoverAudienceChange}
            pickerAriaLabel="Who can see you in the attendee list?"
            secondaryAction={{ label: unmarkLabel, onClick: stopGoing, tone: 'danger' }}
            onClose={closeEdit}
        />
    ) : null;

    if (appearance === 'pill') {
        // When the user is going AND signed-in, render the pill as a unified
        // segmented control: left half = toggle going, right half = visibility
        // icon (replaces the redundant ✓). Anonymous "going" keeps the simple
        // pill (no visibility concept).
        if (going && user) {
            return (
                <div
                    className={`relative inline-flex h-10 items-stretch overflow-hidden rounded-xl bg-action/10 text-action ${className}`.trim()}
                >
                    <button
                        ref={triggerRef}
                        type="button"
                        onClick={handleClick}
                        title={tooltip}
                        aria-label={tooltip}
                        className="flex items-center gap-2 px-3 text-sm transition-colors hover:bg-action/10 focus-visible:outline-none"
                    >
                        <AttendanceIcon variant={resolvedIconVariant} solid className="shrink-0" />
                        <span className={labelClassName}>{goingLabel}</span>
                    </button>
                    <button
                        type="button"
                        onClick={openEditShare}
                        title={`Visibility: ${getAudience(eventId)} \u2014 click to edit`}
                        aria-label={`Visibility: ${getAudience(eventId)} \u2014 edit`}
                        className="flex items-center border-l border-action/20 px-2 text-action transition-colors hover:bg-action/10 focus-visible:outline-none"
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
                    className={`flex h-10 items-center gap-2 rounded-xl px-3 text-sm transition-colors focus-visible:outline-none ${className} ${going ? 'bg-action/10 text-action hover:bg-action/10' : 'bg-action-tile text-ink-soft hover:text-ink'}`.trim()}
                >
                    <AttendanceIcon
                        variant={resolvedIconVariant}
                        solid={going}
                        className="shrink-0"
                    />
                    <span className={labelClassName}>{going ? goingLabel : markLabel}</span>
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
                className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none ${className} ${going ? 'bg-action/10 text-action hover:bg-action/10' : 'bg-action-tile text-ink-soft hover:text-ink'}`.trim()}
            >
                <AttendanceIcon variant={resolvedIconVariant} solid={going} className="shrink-0" />
            </button>

            {popover}
            {postRsvpNode}
            {errorToast.node}
        </div>
    );
}
