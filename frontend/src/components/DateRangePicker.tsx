import { useMemo, useRef, useState } from 'react';
import { getDateRangePresetOptions } from '../utils/dateRangePresets';
import type { DateRangePresetKey, DateRangePresetOption } from '../utils/dateRangePresets';

interface DateRangePickerProps {
    startDate: string;
    endDate: string;
    onChange: (start: string, end: string) => void;
}

// Presets shown in the grid before "More" expands the rest.
const PRIMARY_PRESET_KEYS: DateRangePresetKey[] = [
    'this_weekend',
    'next_weekend',
    'next_7_days',
    'next_30_days',
    'next_3_months',
];

function formatLong(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

const calendarIcon = (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
);

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
    const fromInputRef = useRef<HTMLInputElement>(null);
    const toInputRef = useRef<HTMLInputElement>(null);
    const [moreOpen, setMoreOpen] = useState(false);

    const options = useMemo(() => getDateRangePresetOptions(), []);
    const optionByKey = useMemo(
        () => new Map(options.map((o) => [o.key, o])),
        [options],
    );

    const primaryOptions = PRIMARY_PRESET_KEYS
        .map((key) => optionByKey.get(key))
        .filter((o): o is NonNullable<typeof o> => o != null);
    const extraOptions = options.filter((o) => !PRIMARY_PRESET_KEYS.includes(o.key));

    const renderPreset = (option: DateRangePresetOption) => {
        const active = startDate === option.start && endDate === option.end;
        return (
            <button
                key={option.key}
                type="button"
                onClick={() => onChange(option.start, option.end)}
                className={`rounded-card border px-3 py-3 text-sm font-medium transition ${active
                    ? 'border-action bg-action/5 text-action'
                    : 'border-line bg-surface text-ink hover:bg-canvas'}`}
                aria-pressed={active}
            >
                {option.label}
            </button>
        );
    };

    const openPicker = (input: HTMLInputElement | null) => {
        if (!input) return;
        input.focus();
        if ('showPicker' in input && typeof input.showPicker === 'function') {
            try { input.showPicker(); } catch { /* showPicker may throw if not user-activated */ }
        }
    };

    return (
        <div className="flex flex-col gap-5">
            <section>
                <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-soft">Presets</h4>
                <div className="grid grid-cols-2 gap-3">
                    {primaryOptions.map((o) => renderPreset(o))}
                    {moreOpen && extraOptions.map((o) => renderPreset(o))}
                    <button
                        type="button"
                        onClick={() => setMoreOpen((v) => !v)}
                        className="inline-flex items-center justify-center gap-1 rounded-card border border-line bg-surface px-3 py-3 text-sm font-medium text-ink transition hover:bg-canvas"
                        aria-expanded={moreOpen}
                    >
                        {moreOpen ? 'Less' : 'More'}
                        <svg viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 transition-transform ${moreOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                </div>
            </section>

            <section>
                <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-soft">Custom range</h4>
                <div className="flex flex-col gap-3">
                    <label
                        className="relative block rounded-card border border-line bg-surface px-4 py-3"
                        onClick={() => openPicker(fromInputRef.current)}
                    >
                        <span className="block text-[11px] font-medium text-ink-soft">From</span>
                        <span className="block text-sm font-semibold text-ink">{formatLong(startDate)}</span>
                        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-soft">
                            {calendarIcon}
                        </span>
                        <input
                            ref={fromInputRef}
                            type="date"
                            value={startDate}
                            onChange={(e) => {
                                onChange(e.target.value, endDate);
                                openPicker(toInputRef.current);
                            }}
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            aria-label="Start date"
                        />
                    </label>
                    <label
                        className="relative block rounded-card border border-line bg-surface px-4 py-3"
                        onClick={() => openPicker(toInputRef.current)}
                    >
                        <span className="block text-[11px] font-medium text-ink-soft">To</span>
                        <span className="block text-sm font-semibold text-ink">{formatLong(endDate)}</span>
                        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-soft">
                            {calendarIcon}
                        </span>
                        <input
                            ref={toInputRef}
                            type="date"
                            value={endDate}
                            onChange={(e) => onChange(startDate, e.target.value)}
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            aria-label="End date"
                        />
                    </label>
                </div>
            </section>
        </div>
    );
}
