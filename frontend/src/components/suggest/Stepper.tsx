import { Minus, Plus } from 'lucide-react';

interface Props {
    label: string;
    value: number;
    min?: number;
    max?: number;
    onChange: (next: number) => void;
}

/** `[−] 1 [+]` numeric stepper used by the recurrence interval fields. */
export default function Stepper({ label, value, min = 1, max = 30, onChange }: Props) {
    const clamp = (n: number) => Math.max(min, Math.min(max, n));

    return (
        <div className="inline-flex items-center rounded-field border border-line bg-surface">
            <button
                type="button"
                aria-label={`Decrease ${label}`}
                disabled={value <= min}
                onClick={() => onChange(clamp(value - 1))}
                className="flex h-11 w-11 items-center justify-center text-ink-soft transition hover:text-ink disabled:opacity-40"
            >
                <Minus size={16} aria-hidden="true" />
            </button>
            <input
                type="number"
                aria-label={label}
                min={min}
                max={max}
                value={value}
                onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
                className="h-11 w-12 border-x border-line bg-surface text-center text-base text-ink focus:outline-none"
            />
            <button
                type="button"
                aria-label={`Increase ${label}`}
                disabled={value >= max}
                onClick={() => onChange(clamp(value + 1))}
                className="flex h-11 w-11 items-center justify-center text-ink-soft transition hover:text-ink disabled:opacity-40"
            >
                <Plus size={16} aria-hidden="true" />
            </button>
        </div>
    );
}
