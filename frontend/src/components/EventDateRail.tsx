import { dayOfMonth } from '../utils/eventDates';

interface EventDateRailProps {
    start: Date;
    /** Zone the date is read in (viewer's when omitted). */
    timeZone?: string;
    sequence?: number;
    tone?: 'default' | 'neutral';
}

export default function EventDateRail({ start, timeZone, sequence, tone = 'default' }: EventDateRailProps) {
    return (
        <div
            className="flex w-11 shrink-0 flex-col items-center self-stretch border-r border-card-line px-1 pt-2.5 text-center leading-tight"
            aria-hidden="true"
            data-testid="rail-card-date-rail"
        >
            {sequence != null && (
                <span className="mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-action px-1 text-xs font-extrabold leading-none text-white shadow-sm" data-testid="event-date-sequence">
                    {sequence}
                </span>
            )}
            <span className={tone === 'neutral' ? 'text-xs font-semibold text-ink-soft' : 'event-card-rail-weekday'}>
                {start.toLocaleDateString(undefined, { weekday: 'short', timeZone }).toUpperCase()}
            </span>
            <span className={tone === 'neutral' ? 'mt-1 text-xs font-semibold text-ink-soft' : 'event-card-rail-month'}>
                {start.toLocaleDateString(undefined, { month: 'short', timeZone }).toUpperCase()}
            </span>
            <span className={tone === 'neutral' ? 'mt-1 text-sm font-semibold text-ink-soft' : 'event-card-rail-day'}>{dayOfMonth(start, timeZone)}</span>
        </div>
    );
}
