import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchEventAttendees, followUser } from '../../api';
import type { Attendee } from '../../types';
import { useAuth } from '../../context/AuthContext';

interface Props {
    eventId: string;
}

const INITIAL_VISIBLE = 6;

function Avatar({ attendee, size }: { attendee: Attendee; size: number }) {
    const name = attendee.display_name || (attendee.handle ? `@${attendee.handle}` : 'Someone');
    if (attendee.avatar_url) {
        return (
            // eslint-disable-next-line no-restricted-syntax -- avatar (allowed exception per frontend rules)
            <img
                src={attendee.avatar_url}
                alt=""
                style={{ width: size, height: size }}
                className="rounded-full object-cover"
            />
        );
    }
    return (
        <span
            style={{ width: size, height: size }}
            // eslint-disable-next-line no-restricted-syntax -- avatar placeholder (allowed exception per frontend rules)
            className="flex items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-ink-soft"
        >
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

/** Follow / Following / Requested / Friend state pill. Sits above the card's
 *  profile link and stops propagation so tapping it never navigates. */
function FollowPill({ attendee }: { attendee: Attendee }) {
    const [state, setState] = useState<'idle' | 'busy' | 'followed' | 'error'>(
        attendee.viewer_follow_status === 'approved' ? 'followed' : 'idle',
    );
    const isPending = attendee.viewer_follow_status === 'pending' && state === 'idle';

    if (attendee.is_friend) {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-[11px] leading-none text-ink-soft">
                Friend
            </span>
        );
    }
    if (state === 'followed') {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-[11px] leading-none text-ink-soft">
                Following
            </span>
        );
    }
    if (isPending) {
        return (
            <span className="relative z-10 inline-flex items-center border border-line bg-surface px-2 py-0.5 text-[11px] leading-none text-ink-soft">
                Requested
            </span>
        );
    }
    if (!attendee.handle) return null;

    const onClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (state === 'busy') return;
        setState('busy');
        try {
            await followUser(attendee.handle!);
            setState('followed');
            window.dispatchEvent(new Event('network:changed'));
        } catch {
            setState('error');
        }
    };

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={state === 'busy'}
            className="relative z-10 inline-flex items-center bg-action px-2 py-0.5 text-[11px] leading-none text-white transition hover:opacity-90 disabled:opacity-50"
        >
            {state === 'busy' ? 'Following…' : state === 'error' ? 'Retry' : 'Follow'}
        </button>
    );
}

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
                <span className="w-full truncate text-[10px] text-muted">
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

/**
 * Event detail "People" tab — the full attendee roster split into "Friends
 * going" (mutual friends, no follow controls) and "Other people going" (with
 * follows-in-common and a Follow/Following control). Requires authentication;
 * anonymous callers are prompted to sign in.
 */
export default function PeopleTab({ eventId }: Props) {
    const { user } = useAuth();
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

    if (loading) return <p className="text-xs text-muted">Loading…</p>;

    if (unauthorized || !user) {
        return (
            <div className="space-y-2 py-6 text-center">
                <p className="text-sm font-semibold text-ink">See who's going</p>
                <p className="mx-auto max-w-xs text-xs text-ink-soft">Sign in to see friends and other attendees.</p>
                <Link to="/login" className="inline-block text-sm font-medium text-action hover:underline">
                    Sign in
                </Link>
            </div>
        );
    }

    const list = attendees ?? [];
    const going = list.filter((a) => a.attendance_status !== 'interested');
    const interested = list.filter((a) => a.attendance_status === 'interested');
    const friends = going.filter((a) => a.is_friend);
    const others = going.filter((a) => !a.is_friend);

    if (list.length === 0) {
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
                {going.length} {going.length === 1 ? 'person' : 'people'} going
            </h3>
            <Section title="Friends going" people={friends} showRelationship={false} />
            <Section title="Other people going" people={others} showRelationship={true} />
            <Section title="Interested" people={interested} showRelationship={true} />
        </div>
    );
}
