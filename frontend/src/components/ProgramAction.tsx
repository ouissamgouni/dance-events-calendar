import { CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import type { CalendarEvent } from '../types';

interface ProgramActionProps {
    event: CalendarEvent;
    variant?: 'full' | 'compact';
    onNavigate?: () => void;
}

export default function ProgramAction({ event, variant = 'compact', onNavigate }: ProgramActionProps) {
    const { eventScheduleEnabled } = useFeatureFlags();
    if (!eventScheduleEnabled || !event.schedule_published) return null;

    const now = Date.now();
    const isLive = new Date(event.start).getTime() <= now && now < new Date(event.end).getTime();
    const label = variant === 'full' ? (isLive ? 'Open live program' : 'View program') : 'Program';

    return (
        <Link
            to={`/event/${event.event_id}/program`}
            onClick={(clickEvent) => {
                clickEvent.stopPropagation();
                onNavigate?.();
            }}
            className={variant === 'full'
                ? 'inline-flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-2 text-sm font-semibold text-action hover:bg-canvas'
                : 'pointer-events-auto relative z-[2] inline-flex items-center gap-1.5 rounded-field border border-line bg-surface px-2 py-1 text-xs font-semibold text-action hover:bg-canvas'}
        >
            <CalendarDays size={variant === 'full' ? 16 : 14} aria-hidden="true" />
            {label}
        </Link>
    );
}
