import { useEffect, useRef, useState } from 'react';
import { fetchAttendanceSummary, fetchEventAttendees } from '../api';
import type { Attendee, AttendanceSummary } from '../types';
import { useAuth } from '../context/AuthContext';
import { useAttendanceInvalidationKey } from '../context/AttendanceSummariesContext';

interface Props {
    eventId: string;
    /** Optional pre-loaded summary (e.g. from a batch call) to skip first fetch. */
    initialSummary?: AttendanceSummary;
    /** When true, expand the full attendee list inline (event detail view). */
    expanded?: boolean;
}

function Avatar({ attendee, size = 'md' }: { attendee: Attendee; size?: 'sm' | 'md' }) {
    const px = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs';
    const name = attendee.display_name ?? 'Attendee';
    if (attendee.avatar_url) {
        return (
            <img
                src={attendee.avatar_url}
                alt={name}
                title={name}
                className={`${px} rounded-full object-cover ring-2 ring-white`}
            />
        );
    }
    const initial = name.trim()[0]?.toUpperCase() ?? '?';
    return (
        <span
            title={name}
            className={`${px} rounded-full bg-slate-300 text-slate-700 font-semibold flex items-center justify-center ring-2 ring-white`}
        >
            {initial}
        </span>
    );
}

export default function AttendeeList({ eventId, initialSummary, expanded = false }: Props) {
    const { user } = useAuth();
    const [summary, setSummary] = useState<AttendanceSummary | null>(initialSummary ?? null);
    const [fullList, setFullList] = useState<Attendee[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(!initialSummary);
    const [showAll, setShowAll] = useState<boolean>(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const invalidationKey = useAttendanceInvalidationKey(eventId);

    // If the page was navigated to with #attendees in the URL (e.g. from the
    // event-card avatar stack), scroll the section into view once it has
    // rendered. Runs once per mount.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (window.location.hash !== '#attendees') return;
        // Defer to next tick so layout is settled.
        const t = setTimeout(() => {
            containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
        return () => clearTimeout(t);
    }, []);

    // Reload summary whenever event or auth state changes.
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchAttendanceSummary(eventId)
            .then((s) => { if (!cancelled) { setSummary(s); setError(null); } })
            .catch((e: Error) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [eventId, user?.user_id, invalidationKey]);

    // Lazy-load full list only when expanded and viewer is authed.
    useEffect(() => {
        if (!expanded || !user) { setFullList(null); return; }
        let cancelled = false;
        fetchEventAttendees(eventId)
            .then((res) => {
                if (cancelled) return;
                if ('unauthorized' in res) setFullList(null);
                else setFullList(res);
            })
            .catch(() => { /* keep preview only */ });
        return () => { cancelled = true; };
    }, [eventId, expanded, user?.user_id, invalidationKey]);

    if (loading && !summary) {
        return <div ref={containerRef} id="attendees" className="text-xs text-slate-400">Loading attendees…</div>;
    }
    if (error || !summary) {
        return null;
    }

    // Logged-out: show only total counts + sign-in CTA.
    if (!user) {
        if (summary.total_going === 0 && summary.total_saved === 0) {
            return <div ref={containerRef} id="attendees" className="text-xs text-slate-500">No interest yet — be the first.</div>;
        }
        return (
            <div ref={containerRef} id="attendees" className="text-xs text-slate-600 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span><span className="font-medium">{summary.total_going}</span> going</span>
                    <span className="text-slate-300">·</span>
                    <span><span className="font-medium">{summary.total_saved}</span> saved</span>
                </div>
                {summary.total_going > 0 && (
                    <div className="text-slate-500">Sign in to see who's going.</div>
                )}
            </div>
        );
    }

    // Authed viewer.
    const allAttendees = fullList ?? summary.preview_attendees;
    const INITIAL_LIMIT = 10;
    const tooMany = expanded && allAttendees.length > INITIAL_LIMIT;
    const attendees = tooMany && !showAll ? allAttendees.slice(0, INITIAL_LIMIT) : allAttendees;
    const hiddenCount = Math.max(0, summary.public_going - attendees.length);

    return (
        <div ref={containerRef} id="attendees" className="space-y-2 scroll-mt-4">
            <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span><span className="font-medium">{summary.total_going}</span> going</span>
                <span className="text-slate-300">·</span>
                <span><span className="font-medium">{summary.total_saved}</span> saved</span>
            </div>

            {attendees.length === 0 ? (
                <div className="text-[10px] text-slate-500">
                    No one has shared their name yet — be the first by marking yourself going publicly.
                </div>
            ) : (
                <ul className="flex flex-wrap gap-2 items-center">
                    {attendees.map((a) => (
                        <li key={a.user_id} className="flex items-center gap-1.5 bg-slate-50 rounded-full pl-0.5 pr-2.5 py-0.5">
                            <Avatar attendee={a} size="sm" />
                            <span className="text-xs text-slate-800 whitespace-nowrap">{a.display_name ?? 'Attendee'}</span>
                        </li>
                    ))}
                    {!expanded && hiddenCount > 0 && (
                        <li className="text-xs text-slate-500">+{hiddenCount} more</li>
                    )}
                    {tooMany && (
                        <li>
                            <button
                                type="button"
                                onClick={() => setShowAll((v) => !v)}
                                className="text-xs text-rose-600 hover:text-rose-700 hover:underline"
                            >
                                {showAll ? 'Show less' : `Show all ${allAttendees.length}`}
                            </button>
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}
