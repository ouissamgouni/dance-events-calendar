interface Props {
    date: Date;
}

/**
 * Compact date block for the event identity row: weekday (red) over a large
 * day number over the month. Red is used ONLY for the weekday, per the event
 * page design spec.
 */
export default function DateBlock({ date }: Props) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
    const day = date.toLocaleDateString(undefined, { day: '2-digit' });
    const month = date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();

    return (
        <div className="flex w-[46px] shrink-0 flex-col items-center leading-none">
            <span className="text-[11px] font-semibold tracking-wide text-danger">{weekday}</span>
            <span className="text-2xl font-bold text-ink tabular-nums">{day}</span>
            <span className="text-[11px] font-medium text-ink">{month}</span>
        </div>
    );
}
