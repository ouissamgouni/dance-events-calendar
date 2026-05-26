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

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function addMonths(date: Date, months: number): Date {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
}

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
    const toInputRef = useRef<HTMLInputElement>(null);

    const presets = useMemo(() => {
        const today = new Date();
        const year = today.getFullYear();
        const dayOfWeek = today.getDay(); // 0=Sun, 5=Fri, 6=Sat

        // Weekend is Friday-Sunday. "This weekend" means the current
        // week's weekend: upcoming on Mon-Thu, ongoing on Fri-Sun.
        const thisWeekendStart = addDays(today, dayOfWeek === 0 ? -2 : 5 - dayOfWeek);
        const thisWeekendEnd = addDays(thisWeekendStart, 2);
        const nextWeekendStart = addDays(thisWeekendStart, 7);
        const nextWeekendEnd = addDays(nextWeekendStart, 2);

        // ── Rolling windows ───────────────────────────────────
        const next7Days = addDays(today, 7);
        const next30Days = addMonths(today, 1);

        // ── Next 3 months (explorer default — keep aligned with
        // ``defaultExplorerDateRange`` in pages/Home.tsx) ─────
        const next3Months = addMonths(today, 3);

        // ── Next 6 months ─────────────────────────────────────
        const next6Months = addMonths(today, 6);

        // ── Seasons (meteorological) ──────────────────────────
        const seasons = [
            { name: 'Spring', icon: '🌸', startMonth: 2, endMonth: 4 },
            { name: 'Summer', icon: '☀️', startMonth: 5, endMonth: 7 },
            { name: 'Autumn', icon: '🍂', startMonth: 8, endMonth: 10 },
            { name: 'Winter', icon: '❄️', startMonth: 11, endMonth: 1 },
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
                    ? `This ${seasons[seasonIdx].name}`
                    : `Next ${seasons[seasonIdx].name}`;
            const mobileLabel = seasons[seasonIdx].icon;

            return {
                label,
                mobileLabel,
                start: formatDate(offset === 0 ? thisSeasonStart : range.start),
                end: formatDate(range.end),
            };
        });

        const allPresets = [
            { label: 'This weekend', mobileLabel: 'Wknd', start: formatDate(thisWeekendStart), end: formatDate(thisWeekendEnd), group: 'this' },
            { label: 'Next weekend', mobileLabel: 'Wknd', start: formatDate(nextWeekendStart), end: formatDate(nextWeekendEnd), group: 'next' },
            { label: 'Next 7 days', mobileLabel: '7d', start: formatDate(today), end: formatDate(next7Days), group: 'next' },
            { label: 'Next 30 days', mobileLabel: '30d', start: formatDate(today), end: formatDate(next30Days), group: 'next' },
            { label: 'Next 3 months', mobileLabel: '3mo', start: formatDate(today), end: formatDate(next3Months), group: 'next' },
            { label: 'Next 6 months', mobileLabel: '6mo', start: formatDate(today), end: formatDate(next6Months), group: 'next' },
            ...seasonPresets.map((preset, index) => ({ ...preset, group: index === 0 ? 'this' : 'next' })),
        ] as const;

        return {
            thisPresets: allPresets.filter((preset) => preset.group === 'this'),
            nextPresets: allPresets.filter((preset) => preset.group === 'next'),
        };
    }, []);

    const renderPreset = (preset: { label: string; mobileLabel: string; start: string; end: string }) => {
        const active = startDate === preset.start && endDate === preset.end;
        return (
            <button
                key={preset.label}
                type="button"
                className={`preset-btn ${active ? 'active' : ''}`}
                onClick={() => onChange(preset.start, preset.end)}
                aria-label={preset.label}
                title={preset.label}
            >
                <span className="sm:hidden">{preset.mobileLabel}</span>
                <span className="hidden sm:inline">{preset.label}</span>
            </button>
        );
    };

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
            <div className="date-range-presets" aria-label="Date presets">
                {presets.thisPresets.length > 0 && (
                    <div className="date-range-preset-section date-range-preset-section--this">
                        <span className="date-range-preset-label">This</span>
                        <div className="date-range-preset-buttons">
                            {presets.thisPresets.map(renderPreset)}
                        </div>
                    </div>
                )}
                <div className="date-range-preset-section date-range-preset-section--next">
                    <span className="date-range-preset-label">Next</span>
                    <div className="date-range-preset-buttons">
                        {presets.nextPresets.map(renderPreset)}
                    </div>
                </div>
            </div>
        </div>
    );
}
