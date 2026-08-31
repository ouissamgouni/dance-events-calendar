/**
 * Trailing three-dot menu for a person row on the People page.
 *
 * Renders a small dropdown of row actions (e.g. Unfollow, Remove
 * friend). Closes on outside click or Escape.
 */
import { useEffect, useRef, useState } from 'react';

export interface RowMenuItem {
    label: string;
    onSelect: () => void;
    danger?: boolean;
}

export default function PersonRowMenu({
    items,
    label = 'Row actions',
}: {
    items: RowMenuItem[];
    label?: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    if (items.length === 0) return null;

    return (
        <div ref={ref} className="relative shrink-0">
            <button
                type="button"
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="flex h-8 w-8 items-center justify-center text-ink-soft hover:text-ink"
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                </svg>
            </button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-9 z-10 min-w-32 border border-line bg-surface py-1 shadow-md"
                >
                    {items.map((it) => (
                        <button
                            key={it.label}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setOpen(false);
                                it.onSelect();
                            }}
                            className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-canvas ${it.danger ? 'text-danger' : 'text-ink'
                                }`}
                        >
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
