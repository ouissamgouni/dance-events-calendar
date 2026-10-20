import type { Attendee } from '../types';

export const ALSO_GOING_LIMIT = 3;

export interface RsvpPeople {
    /** Friends and people the viewer follows. */
    yourPeople: Attendee[];
    /** Followable attendees the viewer has no follow edge to, best matches first. */
    alsoGoing: Attendee[];
    /** Total followable attendees before the cap. */
    alsoGoingTotal: number;
}

export function splitRsvpPeople(
    attendees: Attendee[],
    viewerId: string | null | undefined,
    limit = ALSO_GOING_LIMIT,
): RsvpPeople {
    const going = attendees.filter(
        (a) => a.user_id !== viewerId && a.attendance_status !== 'interested',
    );
    const yourPeople = going.filter((a) => a.is_friend || a.viewer_follow_status === 'approved');
    // Stable sort keeps the backend's attending_since order among ties.
    const candidates = going
        .filter((a) => !a.is_friend && !a.viewer_follow_status && !!a.handle)
        .map((a, i) => ({ a, i }))
        .sort((x, y) => (y.a.mutual_friend_count ?? 0) - (x.a.mutual_friend_count ?? 0) || x.i - y.i)
        .map(({ a }) => a);
    return {
        yourPeople,
        alsoGoing: candidates.slice(0, limit),
        alsoGoingTotal: candidates.length,
    };
}

/** Event link that credits the sharer and, with an invite code, offers friendship. */
export function buildEventShareUrl(
    origin: string,
    eventId: string,
    shareCode?: string | null,
    inviteCode?: string | null,
): string {
    const url = new URL(`/event/${encodeURIComponent(eventId)}`, origin);
    if (shareCode) {
        url.searchParams.set('ref', 'share');
        url.searchParams.set('src', shareCode);
        if (inviteCode) url.searchParams.set('inv', inviteCode);
    }
    return url.toString();
}

/** "Ana, Leo + 3 more" summary for a collapsed avatar trail. */
export function peopleTrailLabel(people: Attendee[], named = 2): string {
    const names = people
        .slice(0, named)
        .map((p) => p.display_name || (p.handle ? `@${p.handle}` : 'Someone'));
    const rest = people.length - names.length;
    return rest > 0 ? `${names.join(', ')} + ${rest} more` : names.join(', ');
}
