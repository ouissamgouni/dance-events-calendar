import type { KeyboardEvent } from 'react';

interface Props {
    value: number;
    onChange?: (next: number) => void;
    interactive?: boolean;
    size?: 'sm' | 'md' | 'lg';
    color?: string;
    ariaLabel?: string;
}

const SIZES: Record<'sm' | 'md' | 'lg', string> = {
    sm: 'w-3.5 h-3.5',
    md: 'w-5 h-5',
    lg: 'w-7 h-7',
};

export default function RatingStars({
    value,
    onChange,
    interactive = false,
    size = 'md',
    color = '#f59e0b',
    ariaLabel,
}: Props) {
    const isInteractive = interactive && !!onChange;
    const cls = SIZES[size];

    const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!onChange) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(Math.min(5, (value || 0) + 1));
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(Math.max(1, (value || 1) - 1));
        }
    };

    return (
        <div
            role={isInteractive ? 'radiogroup' : 'img'}
            aria-label={ariaLabel ?? (isInteractive ? 'Rate this event' : `${value} out of 5 stars`)}
            tabIndex={isInteractive ? 0 : -1}
            onKeyDown={isInteractive ? handleKey : undefined}
            className="inline-flex items-center gap-0.5"
        >
            {[1, 2, 3, 4, 5].map((n) => {
                const filled = n <= Math.round(value);
                if (isInteractive) {
                    return (
                        <button
                            key={n}
                            type="button"
                            role="radio"
                            aria-checked={value === n}
                            aria-label={`${n} star${n !== 1 ? 's' : ''}`}
                            onClick={() => onChange?.(n)}
                            className="p-0.5 hover:scale-110 transition-transform focus:outline-none focus:ring-1 focus:ring-amber-400 rounded"
                        >
                            <svg viewBox="0 0 20 20" className={cls} fill={filled ? color : 'none'} stroke={color} strokeWidth={1.5}>
                                <path d="M10 1.6l2.6 5.3 5.9.9-4.3 4.2 1 5.9L10 15.1 4.8 17.9l1-5.9L1.5 7.8l5.9-.9L10 1.6z" />
                            </svg>
                        </button>
                    );
                }
                return (
                    <svg key={n} viewBox="0 0 20 20" className={cls} fill={filled ? color : 'none'} stroke={color} strokeWidth={1.5}>
                        <path d="M10 1.6l2.6 5.3 5.9.9-4.3 4.2 1 5.9L10 15.1 4.8 17.9l1-5.9L1.5 7.8l5.9-.9L10 1.6z" />
                    </svg>
                );
            })}
        </div>
    );
}
