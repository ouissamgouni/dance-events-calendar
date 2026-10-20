import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventAttendees } from '../../api';
import type { Attendee } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useSignIn } from '../../context/SignInSheetContext';
import { useAttendanceSummary } from '../../context/AttendanceSummariesContext';
import FollowPill, { AttendeeAvatar as Avatar } from '../AttendeeFollowPill';

interface Props {
    eventId: string;
}

const INITIAL_VISIBLE = 6;

function PersonCard({ attendee, showRelationship }: { attendee: Attendee; showRelationship: boolean }) {
    const name = attendee.display_name || (attendee.handle ? `@${attendee.handle}` : 'Someone');
    const mutuals = attendee.mutual_friend_count ?? 0;
    return (
        <div className="relative flex flex-col items-center gap-1 border border-line bg-surface px-2 py-3 text-center">
            {attendee.handle && (
                <Link to={`/u/${attendee.handle}`} aria-label={name} className="absolute inset-0" />
            )}
            <Avatar attendee={attendee} size={36} />
            <span className="w-full truncate text-xs font-medium text-ink">{name}</span>
            {showRelationship && mutuals > 0 && (
                <span className="w-full truncate text-xs text-ink-soft">
                    {mutuals} mutual friend{mutuals === 1 ? '' : 's'}
                </span>
            )}
            {showRelationship && <FollowPill attendee={attendee} />}
        </div>
    );
}

function Section({
    title,
    people,
    showRelationship,
}: {
    title: string;
    people: Attendee[];
    showRelationship: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    if (people.length === 0) return null;
    const visible = expanded ? people : people.slice(0, INITIAL_VISIBLE);
    return (
        <section className="space-y-2">
            <h4 className="text-sm font-semibold text-ink">
                {title} <span className="font-normal tabular-nums text-muted">· {people.length}</span>
            </h4>
            <div className="grid grid-cols-3 gap-2">
                {visible.map((p) => (
                    <PersonCard key={p.user_id} attendee={p} showRelationship={showRelationship} />
                ))}
            </div>
            {people.length > INITIAL_VISIBLE && (
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="text-xs font-medium text-action hover:underline"
                >
                    {expanded ? 'Show less' : `Show all ${people.length}`}
                </button>
            )}
        </section>
    );
}

/** Event detail "People" tab grouped by the viewer's relationships. */
export default function PeopleTab({ eventId }: Props) {
    const { user } = useAuth();
    const openSignIn = useSignIn();
    const summary = useAttendanceSummary(eventId);
    const [attendees, setAttendees] = useState<Attendee[] | null>(null);
    const [unauthorized, setUnauthorized] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        fetchEventAttendees(eventId)
            .then((res) => {
                if (!alive) return;
                if ('unauthorized' in res) {
                    setUnauthorized(true);
                    setAttendees([]);
                } else {
                    setAttendees(res);
                }
            })
            .catch(() => { if (alive) setAttendees([]); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [eventId]);

    if (loading) return <p className="text-xs text-ink-soft">Loading…</p>;

    if (unauthorized || !user) {
        const going = summary?.total_going ?? 0;
        const interested = summary?.total_saved ?? 0;
        return (
            <div className="space-y-4">
                <div className="space-y-2">
                    <h3 className="text-lg font-bold text-ink">
                        {summary ? `${going} going · ${interested} interested` : 'People'}
                    </h3>
                    <p className="text-xs text-ink-soft">See which friends and dancers are going to this event.</p>
                </div>
                {!summary || going + interested > 0 ? (
                    <div className="space-y-2 border border-blue-100 bg-blue-50 p-4 text-center" data-testid="people-signin-lock">
                        <p className="text-sm font-semibold text-ink">See who's going</p>
                        <p className="mx-auto max-w-xs text-xs text-ink-soft">
                            Sign in to see friends and other dancers going to this event.
                        </p>
                        <button
                            type="button"
                            onClick={() => openSignIn('people')}
                            className="inline-flex items-center justify-center bg-action px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90"
                        >
                            Sign in to see people
                        </button>
                    </div>
                ) : (
                    <div className="space-y-2 py-6 text-center">
                        <p className="text-sm font-semibold text-ink">No one's going yet</p>
                        <p className="mx-auto max-w-xs text-xs text-ink-soft">Be the first to RSVP.</p>
                    </div>
                )}
            </div>
        );
    }

    const list = attendees ?? [];
    const going = list.filter((a) => a.attendance_status !== 'interested');
    const interested = list.filter((a) => a.attendance_status === 'interested');
    const friends = going.filter((a) => a.is_friend);
    const following = going.filter(
        (a) => !a.is_friend && a.viewer_follow_status === 'approved',
    );
    const others = going.filter(
        (a) => !a.is_friend && a.viewer_follow_status !== 'approved',
    );
    const hasSocialGoing = friends.length > 0 || following.length > 0;
    const totalGoing = summary?.total_going ?? going.length;
    const totalInterested = summary?.total_saved ?? interested.length;

    if (list.length === 0 && totalGoing === 0 && totalInterested === 0) {
        return (
            <div className="py-6 text-center">
                <p className="text-sm font-semibold text-ink">No one's going yet</p>
                <p className="mt-1 text-xs text-ink-soft">Be the first to RSVP.</p>
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <h3 className="text-lg font-bold text-ink">
                {totalGoing} going · {totalInterested} interested
            </h3>
            <Section title="Friends going" people={friends} showRelationship={false} />
            <Section title="Following going" people={following} showRelationship={true} />
            <Section title={hasSocialGoing ? 'Other people going' : 'Going'} people={others} showRelationship={true} />
            <Section title="Interested" people={interested} showRelationship={true} />
        </div>
    );
}
