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
 * Compact attendee avatar preview for event-card rows. Shows *who* is going
 * (faces + overflow), not *how many* — the count lives next to the going CTA
 * icon to avoid duplication. Anonymous viewers and events without preview
 * attendees render nothing (the count chip on the CTA already conveys signal).
 */
export default function AttendeeAvatarStack({ eventId, max = 3 }: Props) {
    const { user } = useAuth();
    const summary = useAttendanceSummary(eventId);
    if (!summary) return null;
    if (!user) return null;
    if (summary.total_going === 0) return null;
    const shown = summary.preview_attendees.slice(0, max);
    if (shown.length === 0) return null;

    const overflow = Math.max(0, summary.total_going - shown.length);
    const namesTitle = `${shown.map((a) => a.display_name ?? 'Attendee').join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`;

    return (
        <Link
            to={`/event/${eventId}#attendees`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-700"
            title={namesTitle}
        >
            <span className="flex -space-x-1.5">
                {shown.map((a, i) => (
                    <MiniAvatar key={a.user_id} attendee={a} z={shown.length - i} />
                ))}
            </span>
            {overflow > 0 && <span>+{overflow}</span>}
        </Link>
    );
}
