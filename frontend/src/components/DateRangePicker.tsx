import { useMemo, useRef } from 'react';
import { getDateRangePresetGroups } from '../utils/dateRangePresets';
import type { DateRangePresetOption } from '../utils/dateRangePresets';

interface DateRangePickerProps {
    startDate: string;
    endDate: string;
    onChange: (start: string, end: string) => void;
}

export default function DateRangePicker({ startDate, endDate, onChange }: DateRangePickerProps) {
    const toInputRef = useRef<HTMLInputElement>(null);

    const presets = useMemo(() => getDateRangePresetGroups(), []);

    const renderPreset = (preset: DateRangePresetOption) => {
        const active = startDate === preset.start && endDate === preset.end;
        return (
            <button
                key={preset.key}
                type="button"
                className={`preset-btn ${active ? 'active' : ''}`}
                onClick={() => onChange(preset.start, preset.end)}
                aria-label={preset.label}
                title={preset.label}
            >
                <span className="sm:hidden">{preset.mobileLabel}</span>
                <span className="hidden sm:inline">{preset.icon ? `${preset.icon} ${preset.label}` : preset.label}</span>
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
            <div className="date-range-presets scrollbar-hide" aria-label="Date presets">
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
