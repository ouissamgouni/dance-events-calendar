import { type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { SquareArrowOutUpRight } from 'lucide-react';
import RsvpVisibilitySheet from './RsvpVisibilitySheet';
import type { ShareAudience } from '../api';

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

    const next = encodeURIComponent(location.pathname + location.search);
    const isAnon = variant === 'anon';
    const showPicker = !!audience && !!onAudienceChange && !isAnon;

    return (
        <RsvpVisibilitySheet
            anchorRef={anchorRef}
            kind="going"
            emoji="🎉"
            title={isPast ? 'You attended!' : "You're going!"}
            subtitle={eventTitle}
            audience={showPicker ? audience : undefined}
            onAudienceChange={showPicker ? onAudienceChange : undefined}
            pickerAriaLabel="Who can see you in the attendee list?"
            secondaryAction={{
                label: 'Share event',
                onClick: onShare,
                icon: <SquareArrowOutUpRight aria-hidden className="h-4 w-4" strokeWidth={1.8} />,
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
