import { useEffect, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { SquareArrowOutUpRight } from 'lucide-react';
import RsvpVisibilitySheet from './RsvpVisibilitySheet';
import useMediaQuery from '../hooks/useMediaQuery';
import { ATTENDANCE_AUDIENCE_DESCRIPTIONS } from '../utils/audiencePreference';
import type { ShareAudience } from '../api';

const AUTO_DISMISS_MS = 5000;

export type PostRsvpVariant = 'anon' | 'signed-in-default-share' | 'signed-in';

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    variant: PostRsvpVariant;
    eventTitle?: string;
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
 * Unified confirmation shown after a successful "I'm going" RSVP: visibility
 * picker + share for signed-in users, sign-in + share for anonymous users.
 * The first-ever anonymous RSVP uses the richer ``SignInNudge`` instead.
 */
export default function PostRsvpPopover({
    anchorRef,
    variant,
    eventTitle,
    isPast = false,
    onClose,
    onShare,
    audience,
    onAudienceChange,
}: Props) {
    const location = useLocation();
    const isMobile = useMediaQuery('(max-width: 639px)');

    // Mobile sheet has an explicit Done button, so only the desktop popover auto-dismisses.
    useEffect(() => {
        if (isMobile) return;
        const t = setTimeout(onClose, AUTO_DISMISS_MS);
        return () => clearTimeout(t);
    }, [isMobile, onClose]);

    const next = encodeURIComponent(location.pathname + location.search);
    const isAnon = variant === 'anon';
    const showPicker = !!audience && !!onAudienceChange && !isAnon;

    return (
        <RsvpVisibilitySheet
            anchorRef={anchorRef}
            emoji="🎉"
            title={isPast ? 'You attended!' : "You're going!"}
            subtitle={eventTitle}
            question="Who can see you in the attendee list?"
            audience={showPicker ? audience : undefined}
            onAudienceChange={showPicker ? onAudienceChange : undefined}
            pickerAriaLabel="Attendance visibility"
            description={audience ? ATTENDANCE_AUDIENCE_DESCRIPTIONS[audience] : undefined}
            secondaryAction={{
                label: 'Share event',
                onClick: onShare,
                icon: <SquareArrowOutUpRight aria-hidden className="h-5 w-5" strokeWidth={1.8} />,
            }}
            primaryAction={isAnon ? { label: 'Sign in', to: `/login?next=${next}` } : undefined}
            onClose={onClose}
        >
            {isAnon && (
                <p className="text-sm leading-5 text-ink-soft">
                    Sign in to keep this across devices.
                </p>
            )}
        </RsvpVisibilitySheet>
    );
}
