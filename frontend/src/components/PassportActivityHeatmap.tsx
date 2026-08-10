/**
 * PassportActivityHeatmap — a GitHub-style Year × Month grid of attended-event
 * counts, shown at the top of the Timeline tab. Each cell's colour reflects the
 * number of events that month (five fixed intensity levels); hovering shows the
 * exact count and clicking a month asks the caller to scroll the timeline to it.
 */
import type { MonthlyActivity } from '../types';
import {
    activityLevel,
    buildYearGrid,
    LEVEL_RAMP_LIGHT,
    MONTH_INITIALS,
    MONTH_SHORT,
} from '../utils/passportActivity';

interface PassportActivityHeatmapProps {
    months: MonthlyActivity[];
    /** Called with "YYYY-MM" when a month with activity is clicked. */
    onSelectMonth?: (month: string) => void;
    /** Month ("YYYY-MM") to briefly highlight (e.g. after a click). */
    highlightMonth?: string | null;
}

const GRID_COLUMNS = 'auto repeat(12, minmax(0, 1fr))';

export default function PassportActivityHeatmap({
    months,
    onSelectMonth,
    highlightMonth,
}: PassportActivityHeatmapProps) {
    const rows = buildYearGrid(months);
    if (rows.length === 0) return null;

    return (
        <div className="mb-4 border border-slate-200 bg-white p-3">
            <div className="overflow-x-auto">
                <div
                    className="inline-grid min-w-full gap-1"
                    style={{ gridTemplateColumns: GRID_COLUMNS }}
                    role="grid"
                    aria-label="Attended events per month"
                >
                    <span aria-hidden />
                    {MONTH_INITIALS.map((initial, i) => (
                        <span
                            key={`h-${i}`}
                            className="text-center text-[10px] leading-4 text-slate-400"
                            aria-hidden
                        >
                            {initial}
                        </span>
                    ))}

                    {rows.map((row) => (
                        <ActivityYearRow
                            key={row.year}
                            year={row.year}
                            cells={row.cells}
                            onSelectMonth={onSelectMonth}
                            highlightMonth={highlightMonth}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

function ActivityYearRow({
    year,
    cells,
    onSelectMonth,
    highlightMonth,
}: {
    year: number;
    cells: number[];
    onSelectMonth?: (month: string) => void;
    highlightMonth?: string | null;
}) {
    return (
        <>
            <span className="pr-2 text-right text-xs leading-4 tabular-nums text-slate-500">
                {year}
            </span>
            {cells.map((count, i) => {
                const month = `${year}-${String(i + 1).padStart(2, '0')}`;
                const level = activityLevel(count);
                const label = `${count} event${count === 1 ? '' : 's'} · ${MONTH_SHORT[i]} ${year}`;
                const highlighted = highlightMonth === month;
                const ring = highlighted ? 'ring-2 ring-blue-500' : '';
                const interactive = count > 0 && onSelectMonth != null;
                return (
                    <button
                        key={month}
                        type="button"
                        title={label}
                        aria-label={label}
                        disabled={!interactive}
                        onClick={interactive ? () => onSelectMonth?.(month) : undefined}
                        className={`aspect-square h-5 w-5 sm:h-4 sm:w-4 ${LEVEL_RAMP_LIGHT[level]} ${ring} ${interactive ? 'cursor-pointer hover:ring-2 hover:ring-slate-400' : 'cursor-default'
                            }`}
                    />
                );
            })}
        </>
    );
}
