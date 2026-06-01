import { Link, useLocation } from 'react-router-dom';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';
import { useAuth } from '../context/AuthContext';
import type { Attendee, FriendMini } from '../types';

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
}

function MiniAvatar({
    person,
    z,
    isFriend,
}: {
    person: { user_id: string; display_name: string | null; avatar_url: string | null };
    z: number;
    isFriend?: boolean;
}) {
    // Friend avatars get a blue ring (not a chip, not a label) — single
    // affordance that reads as "someone you follow / who follows you".
    const ring = isFriend ? 'ring-2 ring-blue-300' : 'ring-2 ring-white';
    if (person.avatar_url) {
        return (
            <img
                src={person.avatar_url}
                alt={person.display_name ?? 'Attendee'}
                title={person.display_name ?? undefined}
                className={`w-5 h-5 rounded-full object-cover ${ring}`}
                style={{ zIndex: z }}
                referrerPolicy="no-referrer"
            />
        );
    }
    const initial = (person.display_name?.trim()[0] ?? '?').toUpperCase();
    const bg = isFriend ? 'bg-blue-50 text-blue-500' : 'bg-slate-300 text-slate-700';
    return (
        <span
            title={person.display_name ?? undefined}
            className={`w-5 h-5 rounded-full ${bg} text-[10px] font-semibold flex items-center justify-center ${ring}`}
            style={{ zIndex: z }}
        >
            {initial}
        </span>
    );
}

/** Inline SVG "people" icon used to label the avatar track when it
 * contains at least one friend. Two heads — clearly distinct from a
 * single-user silhouette so the reader parses it as "social signal". */
function PeopleIcon() {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-3.5 h-3.5 text-blue-400"
        >
            <path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 16.25c0-2.69 2.46-4.5 5.5-4.5s5.5 1.81 5.5 4.5v.5h-11v-.5Zm12.25.5v-.5c0-1.18-.42-2.2-1.14-3.01.36-.05.74-.07 1.14-.07 2.62 0 4.5 1.45 4.5 3.58v0Z" />
        </svg>
    );
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
export default function AttendeeAvatarStack({ eventId, max = 5, friendsPreview }: Props) {
    const { user } = useAuth();
    const location = useLocation();
    const summary = useAttendanceSummary(eventId);

    const friends = friendsPreview ?? [];
    const friendIds = new Set(friends.map((f) => f.user_id));
    const previewAttendees: Attendee[] = summary?.preview_attendees ?? [];
    const others = previewAttendees.filter((a) => !friendIds.has(a.user_id));

    // Combined ordered list: friends first, then non-friend attendees,
    // capped at ``max``.
    const combined: Array<{ user_id: string; display_name: string | null; avatar_url: string | null; isFriend: boolean }> = [];
    for (const f of friends) combined.push({ ...f, isFriend: true });
    for (const a of others) combined.push({ user_id: a.user_id, display_name: a.display_name, avatar_url: a.avatar_url, isFriend: false });
    const shown = combined.slice(0, max);

    if (shown.length === 0) {
        if (!user) {
            const totalGoing = summary?.total_going ?? 0;
            if (totalGoing === 0) return null;
            const goingCopy = totalGoing === 1 ? '1 is going' : `${totalGoing} are going`;
            const next = encodeURIComponent(location.pathname + location.search);
            return (
                <span
                    className="inline-flex items-center gap-1 text-[11px] text-slate-500"
                    data-testid="anonymous-attendee-prompt"
                >
                    <span>{goingCopy}</span>
                    <Link
                        to={`/login?next=${next}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:underline"
                    >
                        Sign in
                    </Link>
                    <span>to see who</span>
                </span>
            );
        }
        if (!summary || summary.total_going === 0) return null;
        return null;
    }

    const totalKnown = (summary?.total_going ?? 0) + (friends.length > (summary?.preview_attendees.length ?? 0) ? friends.length : 0);
    const overflow = Math.max(0, totalKnown - shown.length);
    const hasFriend = friends.length > 0;
    const namesTitle = `${shown.map((p) => p.display_name ?? 'Attendee').join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`;

    return (
        <Link
            to={`/event/${eventId}#attendees`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-700"
            title={namesTitle}
            data-testid={hasFriend ? 'attendee-track-with-friends' : 'attendee-track'}
        >
            {hasFriend && <PeopleIcon />}
            <span className="flex -space-x-1.5">
                {shown.map((p, i) => (
                    <MiniAvatar key={p.user_id} person={p} z={shown.length - i} isFriend={p.isFriend} />
                ))}
            </span>
            {overflow > 0 && <span>+{overflow} more</span>}
        </Link>
    );
}
