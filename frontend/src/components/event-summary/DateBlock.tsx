interface Props {
    date: Date;
    timeZone?: string;
}

/**
 * Compact date block for the event identity row: weekday (red) over a large
 * day number over the month. Red is used ONLY for the weekday, per the event
 * page design spec.
 */
export default function DateBlock({ date, timeZone }: Props) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short', timeZone }).toUpperCase();
    const day = date.toLocaleDateString(undefined, { day: '2-digit', timeZone });
    const month = date.toLocaleDateString(undefined, { month: 'short', timeZone }).toUpperCase();

    return (
        <div className="flex w-[46px] shrink-0 flex-col items-center leading-none">
            <span className="text-xs font-semibold tracking-wide text-danger">{weekday}</span>
            <span className="text-2xl font-bold text-ink tabular-nums">{day}</span>
            <span className="text-xs font-medium text-ink">{month}</span>
        </div>
    );
}
