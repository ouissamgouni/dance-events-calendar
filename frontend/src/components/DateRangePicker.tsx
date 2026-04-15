import { useMemo } from 'react';

interface DateRangePickerProps {
    startDate: string;
    endDate: string;
    onChange: (start: string, end: string) => void;
}

function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
    const presets = useMemo(() => {
        const today = new Date();

        // This weekend
        const weekend = new Date(today);
        const dayOfWeek = today.getDay();
        const daysUntilSat = dayOfWeek === 6 ? 0 : (6 - dayOfWeek);
        weekend.setDate(today.getDate() + daysUntilSat);
        const sunday = new Date(weekend);
        sunday.setDate(weekend.getDate() + 1);

        // Next week: 7 days from today
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);

        // Next month: same day next month
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        // Next 6 months
        const next6Months = new Date(today);
        next6Months.setMonth(next6Months.getMonth() + 6);

        // Next summer: June 1 – August 31 of the nearest upcoming summer
        const year = today.getFullYear();
        const summerStart = new Date(year, 5, 1); // June 1
        const summerEnd = new Date(year, 7, 31); // Aug 31
        // If we're past Aug 31, use next year's summer
        const nextSummerStart = today > summerEnd ? new Date(year + 1, 5, 1) : summerStart;
        const nextSummerEnd = today > summerEnd ? new Date(year + 1, 7, 31) : summerEnd;

        return [
            { label: 'This weekend', start: formatDate(weekend), end: formatDate(sunday) },
            { label: 'Next week', start: formatDate(today), end: formatDate(nextWeek) },
            { label: 'Next month', start: formatDate(today), end: formatDate(nextMonth) },
            { label: 'Next 6 months', start: formatDate(today), end: formatDate(next6Months) },
            { label: 'Next summer', start: formatDate(nextSummerStart), end: formatDate(nextSummerEnd) },
        ];
    }, []);

    return (
        <div className="date-range-picker">
            <div className="date-range-inputs">
                <label>
                    <span className="date-label">From</span>
                    <input
                        type="date"
                        value={startDate}
                        onChange={(e) => onChange(e.target.value, endDate)}
                    />
                </label>
                <label>
                    <span className="date-label">To</span>
                    <input
                        type="date"
                        value={endDate}
                        onChange={(e) => onChange(startDate, e.target.value)}
                    />
                </label>
            </div>
            <div className="date-range-presets">
                {presets.map((p) => (
                    <button
                        key={p.label}
                        type="button"
                        className={`preset-btn ${startDate === p.start && endDate === p.end ? 'active' : ''}`}
                        onClick={() => onChange(p.start, p.end)}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
