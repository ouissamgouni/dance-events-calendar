import { CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useMyPlanCount } from '../context/MyPlanCountContext';
import type { CalendarEvent } from '../types';

interface ProgramActionProps {
    event: CalendarEvent;
    variant?: 'full' | 'compact';
    onNavigate?: () => void;
}

export default function ProgramAction({ event, variant = 'compact', onNavigate }: ProgramActionProps) {
    const { eventScheduleEnabled } = useFeatureFlags();
    const myPlanCount = useMyPlanCount(eventScheduleEnabled && event.schedule_published ? event.event_id : null);
    if (!eventScheduleEnabled || !event.schedule_published) return null;

    const now = Date.now();
    const isLive = new Date(event.start).getTime() <= now && now < new Date(event.end).getTime();
    const hasPlan = (myPlanCount ?? 0) > 0;
    const label = hasPlan
        ? 'My Plan'
        : variant === 'full'
            ? (isLive ? 'Open live program' : 'View program')
            : 'Program';

    return (
        <Link
            to={`/event/${event.event_id}/program${hasPlan ? '/plan' : ''}`}
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
