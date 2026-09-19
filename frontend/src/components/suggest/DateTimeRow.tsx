import { useRef, type ComponentType } from 'react';

type Mode = 'datetime-local' | 'date' | 'time';

interface Props {
    id?: string;
    label: string;
    icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
    mode: Mode;
    value: string;
    min?: string;
    placeholder?: string;
    /** Pre-formatted display text; falls back to `placeholder` when empty. */
    display?: string;
    invalid?: boolean;
    describedBy?: string;
    onChange: (value: string) => void;
}

/**
 * A tappable row backed by a real `<input type="date|time|datetime-local">` —
 * we deliberately never render a calendar or clock of our own.
 *
 * On touch the input is stretched transparently over the row, because tapping
 * anywhere on a native input opens the platform picker. That is not true on
 * pointer devices: desktop browsers only open the picker from the small
 * calendar glyph, so from `sm:` up the real input is shown — glyph included —
 * and a click anywhere on the row also calls `showPicker()`.
 */
export default function DateTimeRow({
    id,
    label,
    icon: Icon,
    mode,
    value,
    min,
    placeholder = 'Select',
    display,
    invalid,
    describedBy,
    onChange,
}: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const text = display ?? value;

    const openPicker = () => {
        const input = inputRef.current;
        if (!input) return;
        try {
            input.showPicker();
        } catch {
            // Unsupported, or the browser refused it outside a trusted gesture.
            input.focus();
        }
    };

    const borderCls = invalid
        ? 'border-danger focus-within:border-danger focus-within:ring-danger'
        : 'border-line focus-within:border-action focus-within:ring-action';

    return (
        <div
            onClick={openPicker}
            className={`relative flex min-h-12 items-center gap-3 rounded-field border bg-surface px-4 py-2 focus-within:ring-1 ${borderCls}`}
        >
            {Icon ? <Icon size={18} className="shrink-0 text-ink-soft" aria-hidden={true} /> : null}
            <span className="shrink-0 text-sm text-ink" aria-hidden="true">
                {label}
            </span>
            <span
                className={`ml-auto min-w-0 truncate text-right text-sm sm:hidden ${text ? 'text-ink' : 'text-muted'}`}
                aria-hidden="true"
            >
                {text || placeholder}
            </span>
            <input
                ref={inputRef}
                id={id}
                type={mode}
                aria-label={label}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                value={value}
                min={min}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 sm:relative sm:inset-auto sm:ml-auto sm:h-auto sm:w-auto sm:bg-transparent sm:text-right sm:text-sm sm:text-ink sm:opacity-100 sm:outline-none"
            />
        </div>
    );
}
