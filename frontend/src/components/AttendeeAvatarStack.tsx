import { Link, useLocation } from 'react-router-dom';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';
import { useAttendingEvents } from '../context/AttendingEventsContext';
import { useAuth } from '../context/AuthContext';
import { useOptionalFeatureFlags } from '../context/FeatureFlagsContext';
import { firstNameOf } from '../utils/displayName';
import type { Attendee, FriendMini } from '../types';

export type AttendeeAvatarStackSize = 'sm' | 'md' | 'lg';

interface Props {
    eventId: string;
    /** Max avatars before collapsing into "+N". Defaults to 5. */
    max?: number;
    /**
     * Mutual-friends preview (friends-first track). When provided, friend
     * avatars are rendered first with a blue ring to distinguish them
     * from the rest of the going set; the rest of the slots are filled
     * with public attendees deduplicated against the friends.
     */
    friendsPreview?: FriendMini[];
    /** Visual density. `md` (default) matches the explorer list; `sm`
     * is the compact variant used by Home-page rails; `lg` is the large
     * face-first variant used by the Tribe event card. */
    size?: AttendeeAvatarStackSize;
    /** Hide social proof when the authenticated viewer is the sole attendee. */
    hideIfOnlyCurrentUser?: boolean;
    /**
     * Layout mode. `inline` (default) renders a single row: people icon +
     * faces + a trailing "N are going" phrase. `stacked` renders the faces
     * on their own row with a names line underneath ("Alice, Bob +5 are
     * going") — used by the Tribe event card. `faces` renders only the
     * overlapping avatar faces (no icon, no sentence) — the caller supplies
     * its own wording alongside.
     */
    layout?: 'inline' | 'stacked' | 'faces';
}

interface SizeStyles {
    avatar: string;
    initial: string;
    ring: string;
    icon: string;
    link: string;
    stack: string;
    /** "more" suffix appended after the count on sm+ screens only. */
    overflowMoreOnDesktop: boolean;
}

const SIZE_STYLES: Record<AttendeeAvatarStackSize, SizeStyles> = {
    md: {
        avatar: 'w-5 h-5',
        initial: 'text-[10px]',
        ring: 'ring-2',
        icon: 'w-5 h-5',
        link: 'inline-flex items-center gap-1.5 text-[11px] text-ink-soft hover:text-ink',
        stack: 'flex -space-x-1.5',
        // Mobile shows the compact "+N" form to save room inside the
        // event card; the "more" word appears on sm+ screens.
        overflowMoreOnDesktop: true,
    },
    sm: {
        avatar: 'w-3.5 h-3.5',
        initial: 'text-[8px]',
        ring: 'ring-1',
        icon: 'w-3.5 h-3.5',
        link: 'inline-flex items-center gap-1 text-[10px] text-ink-soft hover:text-ink',
        stack: 'flex -space-x-1',
        overflowMoreOnDesktop: false,
    },
    lg: {
        avatar: 'w-9 h-9',
        initial: 'text-sm',
        ring: 'ring-2',
        icon: 'w-9 h-9',
        link: 'inline-flex items-center gap-2 text-xs text-ink-soft hover:text-ink',
        stack: 'flex -space-x-2',
        overflowMoreOnDesktop: false,
    },
};

function MiniAvatar({
    person,
    z,
    isFriend,
    styles,
}: {
    person: { user_id: string; display_name: string | null; avatar_url: string | null };
    z: number;
    isFriend?: boolean;
    styles: SizeStyles;
}) {
    // Friend avatars get a blue ring (not a chip, not a label) — single
    // affordance that reads as "someone you follow / who follows you".
    const ring = `${styles.ring} ${isFriend ? 'ring-blue-300' : 'ring-white'}`;
    if (person.avatar_url) {
        return (
            <img
                src={person.avatar_url}
                alt={person.display_name ?? 'Attendee'}
                title={person.display_name ?? undefined}
                className={`${styles.avatar} rounded-full object-cover ${ring}`}
                style={{ zIndex: z }}
                referrerPolicy="no-referrer"
            />
        );
    }
    const initial = (person.display_name?.trim()[0] ?? '?').toUpperCase();
    const bg = isFriend ? 'bg-blue-50 text-action' : 'bg-slate-300 text-ink';
    return (
        <span
            title={person.display_name ?? undefined}
            className={`${styles.avatar} rounded-full ${bg} ${styles.initial} font-semibold flex items-center justify-center ${ring}`}
            style={{ zIndex: z }}
        >
            {initial}
        </span>
    );
}

/** Two-head "people" glyph shared by `PeopleIcon` (React) and the
 * Leaflet marker chips in EventMap.tsx, which render raw HTML strings
 * and can't mount a React component directly. */
export const PEOPLE_ICON_PATH =
    'M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 16.25c0-2.69 2.46-4.5 5.5-4.5s5.5 1.81 5.5 4.5v.5h-11v-.5Zm12.25.5v-.5c0-1.18-.42-2.2-1.14-3.01.36-.05.74-.07 1.14-.07 2.62 0 4.5 1.45 4.5 3.58v0Z';

/** Inline SVG "people" icon used to label the avatar track when it
 * contains at least one friend (or, in grey, to hint at anonymous
 * social proof). Two heads — clearly distinct from a single-user
 * silhouette so the reader parses it as "social signal". */
function PeopleIcon({ className, color = 'text-blue-400' }: { className: string; color?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`${className} ${color}`}
        >
            <path d={PEOPLE_ICON_PATH} />
        </svg>
    );
}

export function shouldHideSoloCurrentUser(totalGoing: number, attendeeIds: string[], userId?: string): boolean {
    return !!userId && totalGoing === 1 && attendeeIds.length === 1 && attendeeIds[0] === userId;
}

/** Trailing social-proof sentence shown after the avatar faces. When the
 * viewer is attending it leads with "You"; otherwise it states the count. */
export function goingSentence(viewerGoing: boolean, totalGoing: number): string {
    if (viewerGoing) {
        const others = Math.max(0, totalGoing - 1);
        return others > 0 ? `You +${others} are going` : 'You are going';
    }
    return totalGoing === 1 ? '1 is going' : `${totalGoing} are going`;
}

/** Names-first social-proof sentence for the Tribe card: up to three first
 * names, then "+N" for the remaining goers, then "are going". Falls back to
 * the plain count when no names are available. */
function namesGoingSentence(names: string[], totalGoing: number, viewerGoing: boolean): string {
    const shown = names.slice(0, 3).filter(Boolean);
    if (shown.length === 0) return goingSentence(viewerGoing, totalGoing);
    const remaining = Math.max(0, totalGoing - shown.length);
    const list = remaining > 0 ? `${shown.join(', ')} +${remaining}` : shown.join(', ');
    return `${list} are going`;
}

/**
 * Compact avatar preview for event-card rows. Shows *who* (faces +
 * overflow), not *how many* — the count lives next to the going CTA
 * icon to avoid duplication. When ``friendsPreview`` is supplied,
 * friends are rendered first with a blue ring; the rest of the slots
 * are filled with public attendees (deduplicated against friends).
 *
 * Anonymous viewers see only aggregate social proof, with identities
 * gated behind sign-in.
 */
export default function AttendeeAvatarStack({ eventId, max = 3, friendsPreview, size = 'md', hideIfOnlyCurrentUser = false, layout = 'inline' }: Props) {
    const { user } = useAuth();
    const { isAttending } = useAttendingEvents();
    const { eventCardShowPeopleIconEnabled } = useOptionalFeatureFlags();
    const location = useLocation();
    const summary = useAttendanceSummary(eventId);
    const styles = SIZE_STYLES[size];
    const viewerGoing = isAttending(eventId);

    const friends = friendsPreview ?? [];
    const friendIds = new Set(friends.map((f) => f.user_id));
    const previewAttendees: Attendee[] = summary?.preview_attendees ?? [];
    const others = previewAttendees.filter((a) => !friendIds.has(a.user_id));

    // Combined ordered list: friends first, then non-friend attendees,
    // capped at ``max``.
    const combined: Array<{ user_id: string; display_name: string | null; avatar_url: string | null; isFriend: boolean }> = [];
    for (const f of friends) combined.push({ ...f, isFriend: true });
    for (const a of others) combined.push({ user_id: a.user_id, display_name: a.display_name, avatar_url: a.avatar_url, isFriend: false });
    if (hideIfOnlyCurrentUser && shouldHideSoloCurrentUser(summary?.total_going ?? 0, combined.map((person) => person.user_id), user?.user_id)) {
        return null;
    }
    const shown = combined.slice(0, max);

    if (shown.length === 0) {
        // Faces-only mode carries no wording, so an empty face set renders
        // nothing — the caller's own sentence provides the social proof.
        if (layout === 'faces') return null;
        const totalGoing = summary?.total_going ?? 0;
        if (!user) {
            if (totalGoing === 0) return null;
            const next = encodeURIComponent(location.pathname + location.search);
            return (
                <Link
                    to={`/login?next=${next}`}
                    onClick={(e) => e.stopPropagation()}
                    className={styles.link}
                    title={totalGoing === 1 ? '1 person is going — sign in to see who' : `${totalGoing} people are going — sign in to see who`}
                    data-testid="anonymous-attendee-prompt"
                >
                    {eventCardShowPeopleIconEnabled && <PeopleIcon className={`${styles.icon} shrink-0`} color="text-blue-400" />}
                    <span>{goingSentence(false, totalGoing)}</span>
                </Link>
            );
        }
        // Logged-in viewer with no visible faces: still surface "You are
        // going" (or a bare count) so the avatar row never disappears when
        // the viewer attends a solo/private event.
        if (!viewerGoing && totalGoing === 0) return null;
        return (
            <Link
                to={`/event/${eventId}#attendees`}
                onClick={(e) => e.stopPropagation()}
                className={styles.link}
                title={goingSentence(viewerGoing, totalGoing)}
                data-testid="attendee-track"
            >
                {eventCardShowPeopleIconEnabled && <PeopleIcon className={styles.icon} color="text-blue-400" />}
                <span>{goingSentence(viewerGoing, totalGoing)}</span>
            </Link>
        );
    }

    const totalKnown = summary?.total_going ?? 0;
    const overflow = Math.max(0, totalKnown - shown.length);
    const hasFriend = friends.length > 0;
    const namesTitle = `${shown.map((p) => p.display_name ?? 'Attendee').join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`;

    if (layout === 'faces') {
        return (
            <Link
                to={`/event/${eventId}#attendees`}
                onClick={(e) => e.stopPropagation()}
                className={styles.stack}
                title={namesTitle}
                data-testid={hasFriend ? 'attendee-track-with-friends' : 'attendee-track'}
            >
                {shown.map((p, i) => (
                    <MiniAvatar key={p.user_id} person={p} z={shown.length - i} isFriend={p.isFriend} styles={styles} />
                ))}
                {overflow > 0 && (
                    <span
                        className={`${styles.avatar} rounded-full bg-slate-100 text-ink-soft ${styles.initial} font-semibold flex items-center justify-center ${styles.ring} ring-white`}
                    >
                        +{overflow}
                    </span>
                )}
            </Link>
        );
    }

    if (layout === 'stacked') {
        const nameLine = namesGoingSentence(shown.map((p) => firstNameOf(p.display_name)), totalKnown, viewerGoing);
        return (
            <Link
                to={`/event/${eventId}#attendees`}
                onClick={(e) => e.stopPropagation()}
                className="flex flex-col gap-1.5 min-w-0"
                title={namesTitle}
                data-testid={hasFriend ? 'attendee-track-with-friends' : 'attendee-track'}
            >
                <span className={styles.stack}>
                    {shown.map((p, i) => (
                        <MiniAvatar key={p.user_id} person={p} z={shown.length - i} isFriend={p.isFriend} styles={styles} />
                    ))}
                    {overflow > 0 && (
                        <span
                            className={`${styles.avatar} rounded-full bg-slate-100 text-ink-soft ${styles.initial} font-semibold flex items-center justify-center ${styles.ring} ring-white`}
                        >
                            +{overflow}
                        </span>
                    )}
                </span>
                <span className="truncate text-xs text-ink-soft">{nameLine}</span>
            </Link>
        );
    }

    return (
        <Link
            to={`/event/${eventId}#attendees`}
            onClick={(e) => e.stopPropagation()}
            className={styles.link}
            title={namesTitle}
            data-testid={hasFriend ? 'attendee-track-with-friends' : 'attendee-track'}
        >
            {eventCardShowPeopleIconEnabled && <PeopleIcon className={styles.icon} color="text-blue-400" />}
            <span className={styles.stack}>
                {shown.map((p, i) => (
                    <MiniAvatar key={p.user_id} person={p} z={shown.length - i} isFriend={p.isFriend} styles={styles} />
                ))}
            </span>
            <span className="truncate">{goingSentence(viewerGoing, totalKnown)}</span>
        </Link>
    );
}
