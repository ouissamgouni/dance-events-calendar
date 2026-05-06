import { Link } from 'react-router-dom';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';
import { useAuth } from '../context/AuthContext';
import type { Attendee } from '../types';

interface Props {
    eventId: string;
    /** Max avatars before collapsing into "+N". Defaults to 3. */
    max?: number;
}

function MiniAvatar({ attendee, z }: { attendee: Attendee; z: number }) {
    const ring = 'ring-2 ring-white';
    if (attendee.avatar_url) {
        return (
            <img
                src={attendee.avatar_url}
                alt={attendee.display_name ?? 'Attendee'}
                title={attendee.display_name ?? undefined}
                className={`w-5 h-5 rounded-full object-cover ${ring}`}
                style={{ zIndex: z }}
                referrerPolicy="no-referrer"
            />
        );
    }
    const initial = (attendee.display_name?.trim()[0] ?? '?').toUpperCase();
    return (
        <span
            title={attendee.display_name ?? undefined}
            className={`w-5 h-5 rounded-full bg-slate-300 text-slate-700 text-[10px] font-semibold flex items-center justify-center ${ring}`}
            style={{ zIndex: z }}
        >
            {initial}
        </span>
    );
}

/**
 * Compact attendee preview for event-card rows. Always rendered as a link to
 * the event detail page anchored at the attendees section, so users can tap
 * the avatar stack to jump straight to the full list. Renders nothing when
 * total_going = 0.
 */
export default function AttendeeAvatarStack({ eventId, max = 3 }: Props) {
    const { user } = useAuth();
    const summary = useAttendanceSummary(eventId);
    if (!summary) return null;
    const totalSaved = summary.total_saved ?? 0;
    if (summary.total_going === 0 && totalSaved === 0) return null;

    const savedNode = totalSaved > 0 ? (
        <span className="text-slate-500" title={`${totalSaved} saved`}>
            <span className="text-slate-300 mx-1">·</span>
            <span className="font-medium text-slate-600">Saved</span>
            <span className="ml-1">{totalSaved}</span>
        </span>
    ) : null;

    // Logged-out viewers: count only, still tappable so they reach the
    // sign-in CTA in the detail page.
    if (!user) {
        return (
            <Link
                to={`/event/${eventId}#attendees`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center text-[11px] text-slate-500 hover:text-slate-700"
                title="Sign in to see who"
            >
                {summary.total_going > 0 && (
                    <>
                        <span className="font-medium text-slate-600">Going</span>
                        <span className="ml-1">{summary.total_going}</span>
                    </>
                )}
                {summary.total_going > 0 && savedNode}
                {summary.total_going === 0 && totalSaved > 0 && (
                    <>
                        <span className="font-medium text-slate-600">Saved</span>
                        <span className="ml-1">{totalSaved}</span>
                    </>
                )}
            </Link>
        );
    }

    const shown = summary.preview_attendees.slice(0, max);
    const overflow = Math.max(0, summary.total_going - shown.length);
    const namesTitle = shown.length
        ? `${shown.map((a) => a.display_name ?? 'Attendee').join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`
        : `${summary.total_going} going`;

    return (
        <Link
            to={`/event/${eventId}#attendees`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-700"
            title={namesTitle}
        >
            {summary.total_going > 0 && (
                <>
                    <span className="font-medium text-slate-600">Going</span>
                    {shown.length > 0 && (
                        <span className="flex -space-x-1.5">
                            {shown.map((a, i) => (
                                <MiniAvatar key={a.user_id} attendee={a} z={shown.length - i} />
                            ))}
                        </span>
                    )}
                    <span>
                        {shown.length === 0
                            ? `· ${summary.total_going}`
                            : overflow > 0
                                ? `+${overflow}`
                                : `· ${summary.total_going}`}
                    </span>
                </>
            )}
            {summary.total_going === 0 && totalSaved > 0 && (
                <>
                    <span className="font-medium text-slate-600">Saved</span>
                    <span>{totalSaved}</span>
                </>
            )}
            {summary.total_going > 0 && savedNode}
        </Link>
    );
}
