import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Columns3 } from 'lucide-react';
import AdminPopover from './AdminPopover';
import { CONFIGURABLE_COLUMNS } from './adminEventColumns';
import type { AdminEventsTablePrefs } from './useAdminEventsTablePrefs';

interface Props {
    prefs: AdminEventsTablePrefs;
    onChange: (prefs: AdminEventsTablePrefs) => void;
    onReset: () => void;
}

const LABELS = Object.fromEntries(CONFIGURABLE_COLUMNS.map((c) => [c.id, c.label]));

export default function AdminEventsColumnsMenu({ prefs, onChange, onReset }: Props) {
    const [open, setOpen] = useState(false);
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
                <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[11px] text-muted">
                    <span>Drag column edges to resize</span>
                    <button type="button" onClick={onReset} className="font-medium text-action hover:underline">Reset</button>
                </div>
            </AdminPopover>
        </div>
    );
}
