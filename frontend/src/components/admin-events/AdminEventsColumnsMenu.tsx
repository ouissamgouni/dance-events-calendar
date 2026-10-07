import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Columns3 } from 'lucide-react';
import AdminPopover from './AdminPopover';
import { CONFIGURABLE_COLUMNS } from './adminEventColumns';
import type { AdminEventsTablePrefs, ConfigurableColumn } from './useAdminEventsTablePrefs';

interface Props {
    prefs: AdminEventsTablePrefs;
    onChange: (prefs: AdminEventsTablePrefs) => void;
    onReset: () => void;
    onSaveAsDefault: () => void;
    onFactoryReset: () => void;
    hasUserDefault: boolean;
    /** Current layout equals the default Reset would restore. */
    isDefault: boolean;
    columns?: ConfigurableColumn[];
}

export default function AdminEventsColumnsMenu({ prefs, onChange, onReset, onSaveAsDefault, onFactoryReset, hasUserDefault, isDefault, columns = CONFIGURABLE_COLUMNS }: Props) {
    const [open, setOpen] = useState(false);
    const LABELS: Record<string, string> = Object.fromEntries(columns.map((c) => [c.id, c.label]));
    const hidden = new Set(prefs.hidden);
    const visibleCount = prefs.order.length - prefs.hidden.length;

    const toggle = (id: string) => onChange({
        ...prefs,
        hidden: hidden.has(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id],
    });
    const move = (index: number, delta: number) => {
        const order = [...prefs.order];
        const [id] = order.splice(index, 1);
        order.splice(index + delta, 0, id);
        onChange({ ...prefs, order });
    };

    return (
        <div className="relative">
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink hover:bg-canvas"
            >
                <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
                Columns
                <span className="text-muted">{visibleCount}</span>
            </button>
            <AdminPopover open={open} onClose={() => setOpen(false)} label="Columns" align="right" className="w-64">
                <ul className="max-h-80 overflow-y-auto">
                    {prefs.order.map((id, index) => {
                        const visible = !hidden.has(id);
                        return (
                            <li key={id} className="flex items-center gap-1">
                                <button
                                    type="button"
                                    role="checkbox"
                                    aria-checked={visible}
                                    onClick={() => toggle(id)}
                                    className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left text-xs text-ink hover:bg-canvas"
                                >
                                    <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center border ${visible ? 'border-action bg-action text-white' : 'border-line bg-surface'}`}>
                                        {visible && <Check className="h-3 w-3" />}
                                    </span>
                                    <span className="truncate">{LABELS[id]}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => move(index, -1)}
                                    disabled={index === 0}
                                    aria-label={`Move ${LABELS[id]} left`}
                                    className="p-1 text-ink-soft hover:text-action disabled:opacity-30"
                                >
                                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => move(index, 1)}
                                    disabled={index === prefs.order.length - 1}
                                    aria-label={`Move ${LABELS[id]} right`}
                                    className="p-1 text-ink-soft hover:text-action disabled:opacity-30"
                                >
                                    <ArrowDown className="h-3 w-3" aria-hidden="true" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
                <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-[11px] text-muted">
                    <p>Drag column edges to resize</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <button type="button" onClick={onSaveAsDefault} disabled={isDefault} className="font-medium text-action hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline">
                            Save as my default
                        </button>
                        <button type="button" onClick={onReset} disabled={isDefault} title={hasUserDefault ? 'Back to my saved default' : 'Back to the standard columns'} className="font-medium text-action hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline">
                            Reset
                        </button>
                        {hasUserDefault && (
                            <button type="button" onClick={onFactoryReset} className="ml-auto text-ink-soft hover:text-ink hover:underline">
                                Standard columns
                            </button>
                        )}
                    </div>
                </div>
            </AdminPopover>
        </div>
    );
}
