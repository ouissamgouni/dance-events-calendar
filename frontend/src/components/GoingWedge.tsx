/**
 * Phase E (E5) — friends / FoF "Who you know going" wedge.
 *
 * Renders three buckets in the event modal for signed-in viewers:
 *   1. Friends going (mutual follows; full identity)
 *   2. Friends-of-friends going (public-audience only; with
 *      "Followed by @alice" attribution)
 *   3. "+N more public" tail counter (public-audience strangers)
 *
 * Anonymous viewers see nothing (the public `going_count` already
 * lives elsewhere on the card). The component renders nothing when
 * all three buckets are empty.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    fetchGoingWedge,
    type FofGoingAttendee,
    type GoingWedgeResponse,
    type WedgeAttendee,
} from '../api';
import { useAuth } from '../context/AuthContext';

interface Props {
    eventId: string;
}

function AvatarPill({
    handle,
    display_name,
    avatar_url,
}: WedgeAttendee) {
    const fallback = (display_name || handle || '?').slice(0, 1).toUpperCase();
    return (
        <span className="inline-flex items-center gap-1.5 text-xs">
            {avatar_url ? (
                <img
                    src={avatar_url}
                    alt=""
                    className="h-5 w-5 rounded-full object-cover"
                />
            ) : (
                <span className="h-5 w-5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-semibold flex items-center justify-center">
                    {fallback}
                </span>
            )}
            {handle ? (
                <Link
                    to={`/u/${handle}`}
                    className="text-slate-700 hover:text-rose-600 hover:underline"
                >
                    {display_name || `@${handle}`}
                </Link>
            ) : (
                <span className="text-slate-700">{display_name}</span>
            )}
        </span>
    );
}

function FofRow({ attendee }: { attendee: FofGoingAttendee }) {
    return (
        <li className="flex items-center justify-between gap-2 py-1">
            <div className="min-w-0 flex-1">
                <AvatarPill
                    user_id={attendee.user_id}
                    handle={attendee.handle}
                    display_name={attendee.display_name}
                    avatar_url={attendee.avatar_url}
                />
                {attendee.via_friend_handle && (
                    <div className="text-[11px] text-slate-500 mt-0.5 ml-7">
                        Followed by{' '}
                        <Link
                            to={`/u/${attendee.via_friend_handle}`}
                            className="hover:underline"
                        >
                            @{attendee.via_friend_handle}
                        </Link>
                    </div>
                )}
            </div>
        </li>
    );
}

export default function GoingWedge({ eventId }: Props) {
    const { user } = useAuth();
    const [wedge, setWedge] = useState<GoingWedgeResponse | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // Signed-out viewers never see the wedge — backend would 401
        // anyway. Skip the request entirely.
        if (!user) {
            setWedge(null);
            setLoaded(true);
            return;
        }
        setLoaded(false);
        fetchGoingWedge(eventId)
            .then((res) => {
                if (cancelled) return;
                setWedge(res);
                setLoaded(true);
            })
            .catch(() => {
                if (cancelled) return;
                setLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, [eventId, user?.user_id]);

    if (!loaded || !wedge) return null;
    const empty =
        wedge.friends_going.length === 0 &&
        wedge.fof_going.length === 0 &&
        wedge.public_going_count === 0;
    if (empty) return null;

    return (
        <div
            className="border-t border-slate-100 pt-3"
            data-testid="going-wedge"
        >
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Who you know going
            </h3>

            {wedge.friends_going.length > 0 && (
                <div className="mb-2" data-testid="wedge-friends">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
                        Your friends
                    </div>
                    <ul className="flex flex-wrap gap-x-3 gap-y-1">
                        {wedge.friends_going.map((a) => (
                            <li key={a.user_id}>
                                <AvatarPill {...a} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {wedge.fof_going.length > 0 && (
                <div className="mb-2" data-testid="wedge-fof">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
                        Friends of friends
                    </div>
                    <ul>
                        {wedge.fof_going.map((a) => (
                            <FofRow key={a.user_id} attendee={a} />
                        ))}
                    </ul>
                </div>
            )}

            {wedge.public_going_count > 0 && (
                <div
                    className="text-xs text-slate-500"
                    data-testid="wedge-public-count"
                >
                    +{wedge.public_going_count} more public
                </div>
            )}
        </div>
    );
}
