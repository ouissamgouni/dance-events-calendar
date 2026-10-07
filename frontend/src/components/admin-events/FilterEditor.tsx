import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { EventFilterOptionsResponse } from '../../api';
import { dimensionOptions, type AdminEventFilterState, type FilterDimension } from './adminEventFilters';

interface EditorProps {
    dim: FilterDimension;
    state: AdminEventFilterState;
    options: EventFilterOptionsResponse | null;
    onChange: (next: AdminEventFilterState) => void;
    /** `sheet` = mobile bottom sheet (larger tap targets). */
    size?: 'popover' | 'sheet';
}

function MinCountInput({ value, label, onCommit, sheet }: { value: number | null; label: string; onCommit: (v: number | null) => void; sheet: boolean }) {
    const [draft, setDraft] = useState(value == null ? '' : String(value));
    const [prevValue, setPrevValue] = useState(value);
    if (prevValue !== value) {
        setPrevValue(value);
        setDraft(value == null ? '' : String(value));
    }
    useEffect(() => {
        const parsed = draft === '' ? null : Math.max(1, Math.floor(Number(draft)));
        if (parsed !== null && Number.isNaN(parsed)) return;
        if (parsed === value) return;
        const timer = setTimeout(() => onCommit(parsed), 300);
        return () => clearTimeout(timer);
    }, [draft, value, onCommit]);
    return (
        <label className={`flex items-center gap-2 text-ink ${sheet ? 'text-sm' : 'text-xs'}`}>
            <span className="text-ink-soft">At least</span>
            <input
                type="number"
                min={1}
                inputMode="numeric"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={`${label} at least`}
                placeholder="Any"
                className={`w-20 border border-line bg-surface px-2 text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action ${sheet ? 'min-h-11 text-base' : 'py-1 text-xs'}`}
            />
        </label>
    );
}

export default function FilterEditor({ dim, state, options, onChange, size = 'popover' }: EditorProps) {
    const sheet = size === 'sheet';
    const rowClass = `flex w-full items-center gap-2 text-left transition hover:bg-canvas ${sheet ? 'min-h-11 px-1 text-sm' : 'px-2 py-1.5 text-xs'}`;
    const [query, setQuery] = useState('');

    if (dim.kind === 'multi' || dim.kind === 'single') {
        const all = dimensionOptions(dim, options);
        const visible = query ? all.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())) : all;
        const isSelected = (value: string) => dim.kind === 'multi' ? (state[dim.id] as string[]).includes(value) : state[dim.id] === value;
        const toggle = (value: string) => {
            if (dim.kind === 'multi') {
                const current = state[dim.id] as string[];
                const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
                onChange({ ...state, [dim.id]: next });
            } else {
                onChange({ ...state, [dim.id]: state[dim.id] === value ? '' : value });
            }
        };
        return (
            <div className="space-y-1">
                {all.length > 8 && (
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={`Search ${dim.label.toLowerCase()}…`}
                        aria-label={`Search ${dim.label}`}
                        className={`w-full border border-line px-2 text-ink placeholder:text-muted focus:border-action focus:outline-none focus:ring-1 focus:ring-action ${sheet ? 'min-h-11 text-base' : 'py-1 text-xs'}`}
                    />
                )}
                {all.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">No options for the current results.</p>}
                <div role="group" aria-label={dim.label} className="max-h-64 overflow-y-auto">
                    {visible.map((option) => {
                        const selected = isSelected(option.value);
                        return (
                            <button
                                key={option.value}
                                type="button"
                                role={dim.kind === 'multi' ? 'checkbox' : 'radio'}
                                aria-checked={selected}
                                onClick={() => toggle(option.value)}
                                className={rowClass}
                            >
                                <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center border ${selected ? 'border-action bg-action text-white' : 'border-line bg-surface'}`}>
                                    {selected && <Check className="h-3 w-3" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                <span className="tabular-nums text-muted">{option.count}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    }

    if (dim.kind === 'min') {
        return <MinCountInput value={state[dim.id]} label={dim.label} sheet={sheet} onCommit={(v) => onChange({ ...state, [dim.id]: v })} />;
    }

    if (dim.kind === 'bool') {
        const value = state.has[dim.id];
        const counts = options?.has_counts?.[dim.id];
        const choices: { label: string; value: boolean | undefined; count?: number }[] = [
            { label: 'Any', value: undefined, count: counts && counts.yes + counts.no },
            { label: dim.yes, value: true, count: counts?.yes },
            { label: dim.no, value: false, count: counts?.no },
        ];
        return (
            <div role="radiogroup" aria-label={dim.label} className="inline-flex border border-line">
                {choices.map((choice) => {
                    const active = value === choice.value;
                    return (
                        <button
                            key={choice.label}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => {
                                const has = { ...state.has };
                                if (choice.value === undefined) delete has[dim.id];
                                else has[dim.id] = choice.value;
                                onChange({ ...state, has });
                            }}
                            className={`whitespace-nowrap border-l border-line first:border-l-0 transition ${sheet ? 'min-h-10 px-3 text-sm' : 'px-2 py-1 text-xs'} ${active ? 'bg-action text-white' : 'bg-surface text-ink-soft hover:bg-canvas'}`}
                        >
                            {choice.label}
                            {choice.count != null && <span className={`ml-1 tabular-nums ${active ? 'text-white/80' : 'text-muted'}`}>{choice.count}</span>}
                        </button>
                    );
                })}
            </div>
        );
    }

    return <DatesEditor state={state} onChange={onChange} sheet={sheet} rowClass={rowClass} />;
}

function DatesEditor({ state, onChange, sheet, rowClass }: { state: AdminEventFilterState; onChange: (next: AdminEventFilterState) => void; sheet: boolean; rowClass: string }) {
    // The custom range is a draft until applied, so picking it doesn't refetch with no dates.
    const [mode, setMode] = useState(state.dateMode);
    const [from, setFrom] = useState(state.startFrom);
    const [to, setTo] = useState(state.startTo);
    const appliedKey = `${state.dateMode}|${state.startFrom}|${state.startTo}`;
    const [prevKey, setPrevKey] = useState(appliedKey);
    if (prevKey !== appliedKey) {
        setPrevKey(appliedKey);
        setMode(state.dateMode);
        setFrom(state.startFrom);
        setTo(state.startTo);
    }
    const modes: { value: AdminEventFilterState['dateMode']; label: string }[] = [
        { value: 'upcoming', label: 'Upcoming & in progress' },
        { value: 'all', label: 'All dates (include past)' },
        { value: 'range', label: 'Custom range' },
    ];
    const inputClass = `border border-line bg-surface px-2 text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action ${sheet ? 'min-h-11 text-base' : 'py-1 text-xs'}`;
    const applied = state.dateMode === 'range' && state.startFrom === from && state.startTo === to;
    return (
        <div className="space-y-2">
            <div role="radiogroup" aria-label="Dates">
                {modes.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={mode === option.value}
                        onClick={() => {
                            setMode(option.value);
                            if (option.value !== 'range') onChange({ ...state, dateMode: option.value, startFrom: '', startTo: '' });
                        }}
                        className={rowClass}
                    >
                        {/* eslint-disable-next-line no-restricted-syntax -- radio indicator is circular */}
                        <span aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 rounded-full border ${mode === option.value ? 'border-4 border-action' : 'border-line'}`} />
                        {option.label}
                    </button>
                ))}
            </div>
            {mode === 'range' && (
                <div className={`flex flex-wrap items-center gap-2 ${sheet ? 'text-sm' : 'text-xs'} text-ink-soft`}>
                    <label className="flex items-center gap-1">
                        From
                        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
                    </label>
                    <label className="flex items-center gap-1">
                        To
                        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputClass} />
                    </label>
                    <button
                        type="button"
                        disabled={(!from && !to) || applied}
                        onClick={() => onChange({ ...state, dateMode: 'range', startFrom: from, startTo: to })}
                        className={`bg-action font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${sheet ? 'min-h-11 px-4 text-sm' : 'px-2.5 py-1 text-xs'}`}
                    >
                        Apply
                    </button>
                </div>
            )}
        </div>
    );
}
