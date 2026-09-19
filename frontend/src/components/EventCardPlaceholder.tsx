import { useMemo } from 'react';

/** Palette of full literal class strings — Tailwind's scanner cannot see
 * interpolated class names, so each variant is written out in full. */
const GRADIENTS = [
    'bg-gradient-to-br from-rose-200 to-orange-200',
    'bg-gradient-to-br from-sky-200 to-indigo-200',
    'bg-gradient-to-br from-emerald-200 to-teal-200',
    'bg-gradient-to-br from-amber-200 to-pink-200',
    'bg-gradient-to-br from-violet-200 to-fuchsia-200',
    'bg-gradient-to-br from-cyan-200 to-blue-200',
];

function hashIndex(seed: string, buckets: number): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % buckets;
}

interface EventCardPlaceholderProps {
    /** Stable seed so the same event always gets the same colours. */
    seed: string;
    /** Event title — its first letter is shown in the ``initial`` style. */
    title: string;
    style: 'gradient' | 'initial';
    className?: string;
}

/**
 * Stand-in artwork for an event that has no picture. Keeps card layout stable
 * whether or not a picture was uploaded.
 */
export default function EventCardPlaceholder({
    seed,
    title,
    style,
    className = '',
}: EventCardPlaceholderProps) {
    const gradient = useMemo(() => GRADIENTS[hashIndex(seed, GRADIENTS.length)], [seed]);
    const initial = title.trim().charAt(0).toUpperCase() || '?';

    return (
        <div
            className={`flex items-center justify-center ${gradient} ${className}`}
            data-testid="event-card-placeholder"
            data-placeholder-style={style}
            aria-hidden="true"
        >
            {style === 'initial' && (
                <span className="text-2xl font-semibold text-ink-soft">{initial}</span>
            )}
        </div>
    );
}
