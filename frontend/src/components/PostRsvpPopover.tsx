import { useEffect, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { SquareArrowOutUpRight, UserPlus } from 'lucide-react';
import RsvpVisibilitySheet from './RsvpVisibilitySheet';
import RsvpPeopleSection from './RsvpPeopleSection';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import { useAuth } from '../context/AuthContext';
import { useSignIn } from '../context/SignInSheetContext';
import { fetchMyReferral, type ShareAudience } from '../api';
import { buildEventShareUrl } from '../utils/postRsvp';
import { trackLink, trackShareAction } from '../utils/tracking';

export type PostRsvpVariant = 'anon' | 'signed-in-default-share' | 'signed-in';

let inviteCodePromise: Promise<string | null> | null = null;
let inviteCodeOwner: string | null = null;

function loadInviteCode(userId: string): Promise<string | null> {
    if (!inviteCodePromise || inviteCodeOwner !== userId) {
        inviteCodeOwner = userId;
        inviteCodePromise = fetchMyReferral().then((r) => r.code).catch(() => {
            inviteCodePromise = null;
            return null;
        });
    }
    return inviteCodePromise;
}

/** Friend-invite share: the link credits the sharer and offers mutual friendship. */
export function BringSomeoneAlong({ eventId, eventTitle }: { eventId: string; eventTitle?: string }) {
    const { user } = useAuth();
    const [inviteCode, setInviteCode] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'shared' | 'copied' | 'error'>('idle');
    const userId = user?.user_id;

    useEffect(() => {
        if (!userId) return;
        let alive = true;
        loadInviteCode(userId).then((code) => { if (alive) setInviteCode(code); });
        return () => { alive = false; };
    }, [userId]);

    const share = async () => {
        const url = buildEventShareUrl(window.location.origin, eventId, user?.share_code, inviteCode);
        trackLink(eventId, url);
        trackShareAction(eventId);
        const text = eventTitle ? `I'm going to ${eventTitle} — come with me?` : "I'm going — come with me?";
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
            try {
                await navigator.share({ title: eventTitle ?? 'Join me!', text, url });
                setStatus('shared');
            } catch {
                /* user cancelled */
            }
            return;
        }
        try {
            await navigator.clipboard.writeText(url);
            setStatus('copied');
        } catch {
            setStatus('error');
        }
    };

    const label = status === 'shared'
        ? 'Shared · Share again'
        : status === 'copied'
            ? 'Link copied · Copy again'
            : 'Bring someone along';

    return (
        <div className="mb-1" data-testid="bring-someone-along">
            <button
                type="button"
                onClick={share}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-field bg-action px-4 text-sm font-semibold text-white hover:opacity-90"
            >
                <UserPlus aria-hidden className="h-4 w-4" strokeWidth={1.9} />
                {label}
            </button>
            <p className="mt-1.5 text-xs leading-5 text-ink-soft" role={status === 'error' ? 'alert' : undefined}>
                {status === 'error'
                    ? 'Couldn’t copy the link — try again.'
                    : inviteCode
                        ? 'Share it with who you’d like there — you’ll be connected as friends.'
                        : 'Share it with who you’d like there.'}
            </p>
        </div>
    );
}

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
    /** Enables the "Add ticket" / "Add memories" shortcuts for signed-in users. */
    eventId?: string;
    ticketLikely?: boolean;
}

/** People going + friend-invite share; shared by the post-RSVP and edit sheets. */
export function PostRsvpSocial({ eventId, eventTitle, isPast = false, onNavigate }: {
    eventId: string;
    eventTitle?: string;
    isPast?: boolean;
    onNavigate: () => void;
}) {
    return (
        <>
            <RsvpPeopleSection
                eventId={eventId}
                isPast={isPast}
                emptyHint={isPast ? undefined : 'You’re the first of your crew — bring someone along.'}
                onNavigate={onNavigate}
            />
            {!isPast && <BringSomeoneAlong eventId={eventId} eventTitle={eventTitle} />}
        </>
    );
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
    eventId,
    ticketLikely = false,
}: Props) {
    const openSignIn = useSignIn();
    const { eventTicketsEnabled, eventMemoriesEnabled, rsvpPeopleSheetEnabled } = useOptionalFeatureFlags();

    const isAnon = variant === 'anon';
    const showPicker = !!audience && !!onAudienceChange && !isAnon;
    const social = rsvpPeopleSheetEnabled && !isAnon && !!eventId;
    const assetHref = (hash: string) => `/event/${encodeURIComponent(eventId ?? '')}#${hash}`;
    const assetLink = !isAnon && eventId
        ? isPast
            ? eventMemoriesEnabled ? { to: assetHref('memories'), label: '📸 Add memories' } : null
            : eventTicketsEnabled && ticketLikely ? { to: assetHref('ticket'), label: '🎟 Got your ticket? Keep it handy here' } : null
        : null;

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
            secondaryAction={social ? undefined : {
                label: 'Share',
                onClick: onShare,
                icon: <SquareArrowOutUpRight aria-hidden className="h-4 w-4" strokeWidth={1.8} />,
            }}
            primaryAction={isAnon ? { label: 'Sign in', onClick: () => { onClose(); openSignIn('going'); } } : undefined}
            footerLink={social && !isPast ? { label: 'See it in My Events', to: '/my-events' } : undefined}
            primaryTone={social && !isPast ? 'neutral' : 'primary'}
            onClose={onClose}
        >
            {isAnon && (
                <p className="text-sm leading-5 text-ink-soft">
                    Saved on this device only. Sign in to let friends see you’re going and keep your plans on every device.
                </p>
            )}
            {assetLink && (
                <Link
                    to={assetLink.to}
                    onClick={onClose}
                    className="mb-2 block text-sm font-semibold text-action hover:underline"
                >
                    {assetLink.label}
                </Link>
            )}
            {social && eventId && (
                <PostRsvpSocial eventId={eventId} eventTitle={eventTitle} isPast={isPast} onNavigate={onClose} />
            )}
        </RsvpVisibilitySheet>
    );
}
