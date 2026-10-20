import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventAttendees } from '../api';
import type { Attendee } from '../types';
import { useAuth } from '../context/AuthContext';
import AttendeeFollowPill, { AttendeeAvatar } from './AttendeeFollowPill';
import { peopleTrailLabel, splitRsvpPeople } from '../utils/postRsvp';

interface Props {
    eventId: string;
    isPast?: boolean;
    /** Shown when nobody else is visibly going. */
    emptyHint?: string;
    /** Called before navigating away so the sheet can close. */
    onNavigate: () => void;
}

/** Post-RSVP people: collapsed trail of friends/following + followable "Also going". */
export default function RsvpPeopleSection({ eventId, isPast = false, emptyHint, onNavigate }: Props) {
    const { user } = useAuth();
    const [attendees, setAttendees] = useState<Attendee[] | null>(null);

    useEffect(() => {
        if (!user) return;
        let alive = true;
        fetchEventAttendees(eventId)
            .then((res) => { if (alive) setAttendees('unauthorized' in res ? [] : res); })
            .catch(() => { if (alive) setAttendees([]); });
        return () => { alive = false; };
    }, [eventId, user]);

    if (!user || attendees === null) return null;

    const { yourPeople, alsoGoing, alsoGoingTotal } = splitRsvpPeople(attendees, user.user_id);
    const peopleHref = `/event/${encodeURIComponent(eventId)}#people`;

    if (yourPeople.length === 0 && alsoGoing.length === 0) {
        return emptyHint ? <p className="mb-3 text-sm text-ink-soft">{emptyHint}</p> : null;
    }

    return (
        <div className="mb-4 space-y-4" data-testid="rsvp-people">
            {yourPeople.length > 0 && (
                <section>
                    <h4 className="mb-1.5 text-xs font-medium text-ink-soft">
                        {isPast ? 'Your people there' : 'Your people going'}
                    </h4>
                    <Link
                        to={peopleHref}
                        onClick={onNavigate}
                        className="flex items-center gap-3 text-sm text-ink hover:text-action"
                    >
                        <span className="flex shrink-0 -space-x-2">
                            {yourPeople.slice(0, 3).map((p) => (
                                // eslint-disable-next-line no-restricted-syntax -- avatar ring (allowed exception per frontend rules)
                                <span key={p.user_id} className="rounded-full ring-2 ring-surface">
                                    <AttendeeAvatar attendee={p} size={28} />
                                </span>
                            ))}
                        </span>
                        <span className="min-w-0 truncate">{peopleTrailLabel(yourPeople)}</span>
                    </Link>
                </section>
            )}
            {alsoGoing.length > 0 && (
                <section>
                    <h4 className="mb-1.5 text-xs font-medium text-ink-soft">
                        {isPast ? 'Also there' : 'Also going'}
                    </h4>
                    <ul className="space-y-2">
                        {alsoGoing.map((p) => {
                            const name = p.display_name || `@${p.handle}`;
                            const mutuals = p.mutual_friend_count ?? 0;
                            return (
                                <li key={p.user_id} className="flex items-center gap-3">
                                    <Link
                                        to={`/u/${p.handle}`}
                                        onClick={onNavigate}
                                        className="flex min-w-0 flex-1 items-center gap-3 hover:text-action"
                                    >
                                        <AttendeeAvatar attendee={p} size={32} />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium text-ink">{name}</span>
                                            {mutuals > 0 && (
                                                <span className="block truncate text-xs text-ink-soft">
                                                    {mutuals} mutual friend{mutuals === 1 ? '' : 's'}
                                                </span>
                                            )}
                                        </span>
                                    </Link>
                                    <AttendeeFollowPill attendee={p} />
                                </li>
                            );
                        })}
                    </ul>
                    {alsoGoingTotal > alsoGoing.length && (
                        <Link
                            to={peopleHref}
                            onClick={onNavigate}
                            className="mt-2 inline-block text-xs font-medium text-action hover:underline"
                        >
                            {isPast ? 'See everyone who went' : 'See everyone going'}
                        </Link>
                    )}
                </section>
            )}
        </div>
    );
}
