interface EventDateRailProps {
    start: Date;
    sequence?: number;
    tone?: 'default' | 'neutral';
}

export default function EventDateRail({ start, sequence, tone = 'default' }: EventDateRailProps) {
    return (
        <div
            className="flex w-11 shrink-0 flex-col items-center self-stretch border-r border-card-line px-1 pt-2.5 text-center leading-tight"
            aria-hidden="true"
            data-testid="rail-card-date-rail"
        >
            {sequence != null && (
                <span className="mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-action px-1 text-[11px] font-extrabold leading-none text-white shadow-sm" data-testid="event-date-sequence">
                    {sequence}
                </span>
            )}
            <span className={tone === 'neutral' ? 'text-xs font-semibold text-ink-soft' : 'event-card-rail-weekday'}>
                {start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
            </span>
            <span className={tone === 'neutral' ? 'mt-1 text-xs font-semibold text-ink-soft' : 'event-card-rail-month'}>
                {start.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}
            </span>
            <span className={tone === 'neutral' ? 'mt-1 text-sm font-semibold text-ink-soft' : 'event-card-rail-day'}>{start.getDate()}</span>
        </div>
    );
}
