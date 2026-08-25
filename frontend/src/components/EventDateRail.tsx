interface EventDateRailProps {
    start: Date;
}

export default function EventDateRail({ start }: EventDateRailProps) {
    return (
        <div
            className="flex w-11 shrink-0 flex-col items-center self-stretch border-r border-card-line px-1 pt-2.5 text-center leading-tight"
            aria-hidden="true"
            data-testid="rail-card-date-rail"
        >
            <span className="event-card-rail-weekday">
                {start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
            </span>
            <span className="event-card-rail-month">
                {start.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}
            </span>
            <span className="event-card-rail-day">{start.getDate()}</span>
        </div>
    );
}
