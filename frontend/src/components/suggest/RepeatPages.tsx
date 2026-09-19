import { useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import SubPage from './SubPage';
import Stepper from './Stepper';
import DateTimeRow from './DateTimeRow';
import {
    MAX_OCCURRENCES,
    MONTH_LABELS,
    WEEKDAY_CODES,
    WEEKDAY_LABELS,
    defaultsFor,
    hasDuplicateDates,
    nthWeekdayLabel,
    summarize,
    type ManualDate,
    type RecurrenceEnd,
    type RecurrenceState,
    type WeekdayCode,
} from './recurrence';
import { btnPrimary, btnSecondary, chipCls, errorCls, helpCls, inputCls, sectionLabelCls } from './formState';
import { formatDateTime, toLocalInput } from './datetime';

type View = 'modes' | 'weekly' | 'monthly' | 'yearly' | 'dates';

interface Props {
    value: RecurrenceState;
    start: Date | null;
    onChange: (next: RecurrenceState) => void;
    onClose: () => void;
}

const MODES: { key: View | 'none'; label: string }[] = [
    { key: 'none', label: 'Does not repeat' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'yearly', label: 'Yearly' },
    { key: 'dates', label: 'Choose dates' },
];

const TITLES: Record<Exclude<View, 'modes'>, string> = {
    weekly: 'Weekly',
    monthly: 'Monthly',
    yearly: 'Yearly',
    dates: 'Choose dates',
};

const radioRowCls =
    'flex min-h-12 w-full items-center gap-3 rounded-field border border-line bg-surface px-4 py-2 text-sm text-ink';

function IntervalField({
    unit,
    value,
    onChange,
}: {
    unit: string;
    value: number;
    onChange: (n: number) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink">Repeat every</span>
            <div className="flex items-center gap-2">
                <Stepper label={`Repeat every ${unit}`} value={value} onChange={onChange} />
                <span className="text-sm text-ink-soft">{value === 1 ? unit : `${unit}s`}</span>
            </div>
        </div>
    );
}

function EndField({ value, onChange }: { value: RecurrenceEnd; onChange: (e: RecurrenceEnd) => void }) {
    return (
        <fieldset className="mt-6">
            <legend className={sectionLabelCls}>Ends</legend>
            <div className="space-y-2">
                <label className={radioRowCls}>
                    <input
                        type="radio"
                        name="recurrence-end"
                        checked={value.kind === 'never'}
                        onChange={() => onChange({ kind: 'never' })}
                    />
                    Never
                </label>
                <label className={radioRowCls}>
                    <input
                        type="radio"
                        name="recurrence-end"
                        checked={value.kind === 'on'}
                        onChange={() =>
                            onChange({
                                kind: 'on',
                                date: value.kind === 'on' ? value.date : new Date().toISOString().slice(0, 10),
                            })
                        }
                    />
                    On
                    <input
                        type="date"
                        aria-label="Repeat until"
                        disabled={value.kind !== 'on'}
                        value={value.kind === 'on' ? value.date : ''}
                        onChange={(e) => onChange({ kind: 'on', date: e.target.value })}
                        className="ml-auto min-w-0 flex-1 bg-transparent text-right text-sm text-ink focus:outline-none disabled:opacity-40"
                    />
                </label>
                <label className={radioRowCls}>
                    <input
                        type="radio"
                        name="recurrence-end"
                        checked={value.kind === 'after'}
                        onChange={() =>
                            onChange({ kind: 'after', count: value.kind === 'after' ? value.count : 10 })
                        }
                    />
                    After
                    <input
                        type="number"
                        aria-label="Number of occurrences"
                        min={1}
                        max={MAX_OCCURRENCES}
                        disabled={value.kind !== 'after'}
                        value={value.kind === 'after' ? value.count : ''}
                        onChange={(e) =>
                            onChange({
                                kind: 'after',
                                count: Math.max(1, Math.min(MAX_OCCURRENCES, Number(e.target.value) || 1)),
                            })
                        }
                        className="ml-auto w-16 bg-transparent text-right text-sm text-ink focus:outline-none disabled:opacity-40"
                    />
                    <span className="shrink-0 text-ink-soft">times</span>
                </label>
            </div>
        </fieldset>
    );
}

/**
 * The whole "Repeat" flow as full-screen pages: a mode list that pushes one
 * configuration page on top of it. Nothing is written back to the form until
 * the user taps Done, so backing out always restores the previous recurrence.
 */
export default function RepeatPages({ value, start, onChange, onClose }: Props) {
    const [view, setView] = useState<View>('modes');
    const [draft, setDraft] = useState<RecurrenceState>(value);
    const anchor = start ?? new Date();

    const pickMode = (key: View | 'none') => {
        if (key === 'none' || key === 'modes') {
            onChange({ mode: 'none' });
            onClose();
            return;
        }
        // Keep the existing settings when re-opening the mode already chosen.
        setDraft(draft.mode === key ? draft : defaultsFor(key, anchor));
        setView(key);
    };

    const confirm = () => {
        onChange(draft);
        onClose();
    };

    if (view === 'modes') {
        return (
            <SubPage title="Repeat" onBack={onClose}>
                <div className="space-y-2">
                    {MODES.map((m) => {
                        const active = m.key === 'none' ? value.mode === 'none' : value.mode === m.key;
                        return (
                            <button
                                key={m.key}
                                type="button"
                                onClick={() => pickMode(m.key)}
                                aria-pressed={active}
                                className={`flex min-h-12 w-full items-center gap-3 rounded-field border px-4 py-2 text-left text-sm font-medium transition hover:bg-canvas ${active ? 'border-action text-action' : 'border-line text-ink'
                                    }`}
                            >
                                <span>{m.label}</span>
                                {active ? (
                                    <Check size={18} className="ml-auto text-action" aria-hidden="true" />
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            </SubPage>
        );
    }

    const done = (
        <button type="button" className={btnPrimary} onClick={confirm}>
            Done
        </button>
    );

    if (view === 'dates') {
        const dates: ManualDate[] = draft.mode === 'dates' ? draft.dates : [];
        const setDates = (next: ManualDate[]) => setDraft({ mode: 'dates', dates: next });
        const duplicates = hasDuplicateDates(dates);
        return (
            <SubPage title={TITLES.dates} onBack={() => setView('modes')} backIcon="back" footer={done}>
                {dates.length === 0 ? (
                    <p className={helpCls}>
                        Add each date this event happens. Every date keeps its own start and end time.
                    </p>
                ) : null}
                <div className="space-y-3">
                    {dates.map((d, i) => (
                        <div key={i} className="rounded-field border border-line p-3">
                            <div className="mb-2 flex items-center justify-between">
                                <span className="text-xs font-semibold text-muted">Date {i + 1}</span>
                                <button
                                    type="button"
                                    aria-label={`Remove date ${i + 1}`}
                                    onClick={() => setDates(dates.filter((_, idx) => idx !== i))}
                                    className="-mr-2 flex h-11 w-11 items-center justify-center text-muted transition hover:text-danger"
                                >
                                    <Trash2 size={16} aria-hidden="true" />
                                </button>
                            </div>
                            <div className="space-y-2">
                                <DateTimeRow
                                    label={`Start ${i + 1}`}
                                    mode="datetime-local"
                                    value={d.start}
                                    display={formatDateTime(d.start, false)}
                                    onChange={(v) =>
                                        setDates(dates.map((x, idx) => (idx === i ? { ...x, start: v } : x)))
                                    }
                                />
                                <DateTimeRow
                                    label={`End ${i + 1}`}
                                    mode="datetime-local"
                                    value={d.end}
                                    min={d.start}
                                    display={formatDateTime(d.end, false)}
                                    onChange={(v) =>
                                        setDates(dates.map((x, idx) => (idx === i ? { ...x, end: v } : x)))
                                    }
                                />
                            </div>
                        </div>
                    ))}
                </div>
                {duplicates ? <p className={errorCls}>Two dates have the same start time.</p> : null}
                {dates.length < MAX_OCCURRENCES ? (
                    <button
                        type="button"
                        className={`${btnSecondary} mt-3`}
                        onClick={() => {
                            const last = dates[dates.length - 1];
                            const base = last ? new Date(last.start) : anchor;
                            const next = new Date(base.getTime());
                            if (last) next.setDate(next.getDate() + 7);
                            setDates([
                                ...dates,
                                {
                                    start: toLocalInput(next),
                                    end: toLocalInput(new Date(next.getTime() + 60 * 60 * 1000)),
                                },
                            ]);
                        }}
                    >
                        + Add date
                    </button>
                ) : (
                    <p className={helpCls}>You can add up to {MAX_OCCURRENCES} dates.</p>
                )}
            </SubPage>
        );
    }

    return (
        <SubPage title={TITLES[view]} onBack={() => setView('modes')} backIcon="back" footer={done}>
            {draft.mode === 'weekly' ? (
                <div>
                    <IntervalField
                        unit="week"
                        value={draft.interval}
                        onChange={(interval) => setDraft({ ...draft, interval })}
                    />
                    <fieldset className="mt-6">
                        <legend className={sectionLabelCls}>On these days</legend>
                        <div className="flex flex-wrap gap-2">
                            {WEEKDAY_CODES.map((code: WeekdayCode) => {
                                const on = draft.weekdays.includes(code);
                                return (
                                    <button
                                        key={code}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() =>
                                            setDraft({
                                                ...draft,
                                                weekdays: on
                                                    ? draft.weekdays.filter((d) => d !== code)
                                                    : [...draft.weekdays, code],
                                            })
                                        }
                                        className={chipCls(on)}
                                    >
                                        {WEEKDAY_LABELS[code]}
                                    </button>
                                );
                            })}
                        </div>
                    </fieldset>
                    <EndField value={draft.end} onChange={(end) => setDraft({ ...draft, end })} />
                </div>
            ) : null}

            {draft.mode === 'monthly' ? (
                <div>
                    <IntervalField
                        unit="month"
                        value={draft.interval}
                        onChange={(interval) => setDraft({ ...draft, interval })}
                    />
                    <fieldset className="mt-6">
                        <legend className={sectionLabelCls}>Repeats on</legend>
                        <div className="space-y-2">
                            <label className={radioRowCls}>
                                <input
                                    type="radio"
                                    name="monthly-by"
                                    checked={draft.by === 'day-of-month'}
                                    onChange={() => setDraft({ ...draft, by: 'day-of-month' })}
                                />
                                On day {draft.monthDay}
                            </label>
                            <label className={radioRowCls}>
                                <input
                                    type="radio"
                                    name="monthly-by"
                                    checked={draft.by === 'day-of-week'}
                                    onChange={() => setDraft({ ...draft, by: 'day-of-week' })}
                                />
                                On the {nthWeekdayLabel(anchor)}
                            </label>
                        </div>
                    </fieldset>
                    <EndField value={draft.end} onChange={(end) => setDraft({ ...draft, end })} />
                </div>
            ) : null}

            {draft.mode === 'yearly' ? (
                <div>
                    <IntervalField
                        unit="year"
                        value={draft.interval}
                        onChange={(interval) => setDraft({ ...draft, interval })}
                    />
                    <div className="mt-6">
                        <span className={sectionLabelCls}>On date</span>
                        <div className="flex gap-2">
                            <select
                                aria-label="Month"
                                value={draft.month}
                                onChange={(e) => setDraft({ ...draft, month: Number(e.target.value) })}
                                className={`${inputCls} flex-1`}
                            >
                                {MONTH_LABELS.map((label, i) => (
                                    <option key={label} value={i + 1}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                            <select
                                aria-label="Day"
                                value={draft.day}
                                onChange={(e) => setDraft({ ...draft, day: Number(e.target.value) })}
                                className={`${inputCls} w-24 shrink-0`}
                            >
                                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                                    <option key={d} value={d}>
                                        {d}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <EndField value={draft.end} onChange={(end) => setDraft({ ...draft, end })} />
                </div>
            ) : null}

            <p className={`${helpCls} mt-6`}>{summarize(draft, anchor)}</p>
        </SubPage>
    );
}
