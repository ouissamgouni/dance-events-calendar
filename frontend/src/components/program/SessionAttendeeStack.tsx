import type { SessionAttendanceSummary, SessionPlanAttendee } from '../../types';

function Avatar({ attendee, size }: { attendee: SessionPlanAttendee; size: 'sm' | 'md' }) {
    const name = attendee.display_name ?? 'Attendee';
    const dimensions = size === 'sm' ? 'h-5 w-5 ring-1' : 'h-7 w-7 ring-2';
    if (attendee.avatar_url) {
        return (
            <img
                src={attendee.avatar_url}
                alt={name}
                // eslint-disable-next-line no-restricted-syntax -- avatar is intentionally circular
                className={`${dimensions} rounded-full object-cover ring-white`}
            />
        );
    }
    return (
        // eslint-disable-next-line no-restricted-syntax -- avatar placeholder is intentionally circular
        <span className={`flex items-center justify-center rounded-full bg-canvas font-semibold text-ink ring-white ${size === 'sm' ? 'h-5 w-5 text-[8px] ring-1' : 'h-7 w-7 text-[10px] ring-2'}`} aria-hidden="true">
            {name.trim()[0]?.toUpperCase() ?? '?'}
        </span>
    );
}

export default function SessionAttendeeStack({
    summary,
    max = 2,
    size = 'md',
}: {
    summary: SessionAttendanceSummary;
    max?: number;
    size?: 'sm' | 'md';
}) {
    const shown = summary.preview_attendees.slice(0, max);
    const overflow = Math.max(0, summary.visible_count - shown.length);
    if (!summary.visible_count) return null;
    return (
        <span className="flex items-center" aria-hidden="true">
            {shown.map((attendee, index) => (
                <span key={attendee.user_id} className={index ? '-ml-1.5' : ''}>
                    <Avatar attendee={attendee} size={size} />
                </span>
            ))}
            {overflow > 0 ? (
                // eslint-disable-next-line no-restricted-syntax -- avatar overflow badge is intentionally circular
                <span className={`-ml-1.5 flex items-center justify-center rounded-full bg-canvas px-1 font-semibold text-ink-soft ring-white ${size === 'sm' ? 'h-5 min-w-5 text-[8px] ring-1' : 'h-7 min-w-7 text-[10px] ring-2'}`}>
                    +{overflow}
                </span>
            ) : null}
        </span>
    );
}
