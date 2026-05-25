import { useMemo, useRef } from 'react';

interface DateRangePickerProps {
    startDate: string;
    endDate: string;
    onChange: (start: string, end: string) => void;
}

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
    const toInputRef = useRef<HTMLInputElement>(null);

    const presets = useMemo(() => {
        const today = new Date();
        const year = today.getFullYear();
        const dayOfWeek = today.getDay(); // 0=Sun, 5=Fri, 6=Sat

        // ── Weekend (contextual "This" / "Next") ─────────────
        // Weekend is Friday-Sunday.
        let weekendStart: Date;
        let weekendLabel: string;
        if (dayOfWeek >= 5 || dayOfWeek === 0) {
            // Fri/Sat/Sun -> current weekend.
            const daysSinceFriday = dayOfWeek === 0 ? 2 : dayOfWeek - 5;
            weekendStart = new Date(today);
            weekendStart.setDate(today.getDate() - daysSinceFriday);
            weekendLabel = 'This weekend';
        } else {
            // Mon-Thu -> upcoming Friday-Sunday.
            const daysUntilFriday = 5 - dayOfWeek;
            weekendStart = new Date(today);
            weekendStart.setDate(today.getDate() + daysUntilFriday);
            weekendLabel = 'Next weekend';
        }
        const weekendEnd = new Date(weekendStart);
        weekendEnd.setDate(weekendStart.getDate() + 2);

        // ── Next week ─────────────────────────────────────────
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);

        // ── Next month ────────────────────────────────────────
        const nextMonth = new Date(today);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        // ── Next 3 months (explorer default — keep aligned with
        // ``defaultExplorerDateRange`` in pages/Home.tsx) ─────
        const next3Months = new Date(today);
        next3Months.setMonth(next3Months.getMonth() + 3);

        // ── Next 6 months ─────────────────────────────────────
        const next6Months = new Date(today);
        next6Months.setMonth(next6Months.getMonth() + 6);

        // ── Seasons (meteorological) ──────────────────────────
        const seasons = [
            { icon: '🌸', startMonth: 2, endMonth: 4 },   // Spring: Mar–May
            { icon: '☀️', startMonth: 5, endMonth: 7 },   // Summer: Jun–Aug
            { icon: '🍂', startMonth: 8, endMonth: 10 },  // Fall:   Sep–Nov
            { icon: '❄️', startMonth: 11, endMonth: 1 },  // Winter: Dec–Feb
        ];

        function seasonRange(idx: number, baseYear: number) {
            const s = seasons[idx];
            if (s.startMonth > s.endMonth) {
                // Winter crosses year boundary
                const start = new Date(baseYear, s.startMonth, 1);
                const end = new Date(baseYear + 1, s.endMonth + 1, 0); // last day of Feb
                return { start, end };
            }
            const start = new Date(baseYear, s.startMonth, 1);
            const end = new Date(baseYear, s.endMonth + 1, 0); // last day of end month
            return { start, end };
        }

        // Determine current season index
        const month = today.getMonth();
        let currentIdx: number;
        if (month >= 2 && month <= 4) currentIdx = 0;       // Spring
        else if (month >= 5 && month <= 7) currentIdx = 1;   // Summer
        else if (month >= 8 && month <= 10) currentIdx = 2;  // Fall
        else currentIdx = 3;                                   // Winter

        // "This {season}" — remainder of current season
        const currentBaseYear = (currentIdx === 3 && month <= 1) ? year - 1 : year;
        const currentRange = seasonRange(currentIdx, currentBaseYear);
        const thisSeasonStart = today > currentRange.start ? today : currentRange.start;

        // Generate current season + next 3 seasons
        const seasonPresets = Array.from({ length: 4 }, (_, offset) => {
            const seasonIdx = (currentIdx + offset) % 4;
            const seasonBaseYear = currentBaseYear + Math.floor((currentIdx + offset) / 4);
            const range = seasonRange(seasonIdx, seasonBaseYear);

            const label =
                offset === 0
                    ? `This ${seasons[seasonIdx].icon}`
                    : `Next ${seasons[seasonIdx].icon}`;
            // Mobile (Option D): icon only; current season prefixed with a small dot.
            const mobileLabel =
                offset === 0
                    ? `•${seasons[seasonIdx].icon}`
                    : seasons[seasonIdx].icon;

            return {
                label,
                mobileLabel,
                start: formatDate(offset === 0 ? thisSeasonStart : range.start),
                end: formatDate(range.end),
            };
        });

        // ── Build in fixed display order ─────────────────────
        return [
            { label: weekendLabel, mobileLabel: 'Wknd', start: formatDate(weekendStart), end: formatDate(weekendEnd) },
            { label: 'Next Week', mobileLabel: 'Next 7d', start: formatDate(today), end: formatDate(nextWeek) },
            { label: 'Next Month', mobileLabel: 'Next 30d', start: formatDate(today), end: formatDate(nextMonth) },
            { label: 'Next 3 months', mobileLabel: 'Next 3mo', start: formatDate(today), end: formatDate(next3Months) },
            { label: 'Next 6 months', mobileLabel: 'Next 6mo', start: formatDate(today), end: formatDate(next6Months) },
            ...seasonPresets,
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
                        onChange={(e) => {
                            onChange(e.target.value, endDate);
                            const toInput = toInputRef.current;
                            if (!toInput) return;
                            toInput.focus();
                            if ('showPicker' in toInput && typeof toInput.showPicker === 'function') {
                                toInput.showPicker();
                            }
                        }}
                    />
                </label>
                <label>
                    <span className="date-label">To</span>
                    <input
                        ref={toInputRef}
                        type="date"
                        value={endDate}
                        onChange={(e) => onChange(startDate, e.target.value)}
                    />
                </label>
            </div>
            <div className="date-range-presets">
                {presets.map((p) => {
                    const active = startDate === p.start && endDate === p.end;
                    return (
                        <button
                            key={p.label}
                            type="button"
                            className={`preset-btn ${active ? 'active' : ''}`}
                            onClick={() => onChange(p.start, p.end)}
                            aria-label={p.label}
                            title={p.label}
                        >
                            {/* Short label on mobile, full label on sm+ */}
                            <span className="sm:hidden">{p.mobileLabel}</span>
                            <span className="hidden sm:inline">{p.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
