import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
    text: string;
    compact?: boolean;
    /** Tailwind line-clamp class. Defaults to line-clamp-6. */
    clampClass?: string;
}

/**
 * Renders `text` (preserving newlines) clamped to N lines with a
 * "Show more" / "Show less" toggle that only appears if the text overflows
 * the clamped height.
 */
export default function ExpandableDescription({
    text,
    compact = false,
    clampClass = 'line-clamp-6',
}: Props) {
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // When collapsed, scrollHeight > clientHeight means content is clipped.
        setOverflowing(el.scrollHeight - el.clientHeight > 1);
    }, [text]);

    // Re-measure on window resize (line wrapping changes with width).
    useEffect(() => {
        const onResize = () => {
            const el = ref.current;
            if (!el || expanded) return;
            setOverflowing(el.scrollHeight - el.clientHeight > 1);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [expanded]);

    return (
        <div>
            <div
                ref={ref}
                className={`whitespace-pre-line leading-relaxed text-slate-600 ${compact ? 'text-xs' : 'text-sm'} ${expanded ? '' : clampClass}`}
            >
                {text}
            </div>
            {(overflowing || expanded) && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                    className="mt-1 text-xs font-medium text-rose-500 hover:text-rose-700 transition"
                >
                    {expanded ? 'Show less' : 'Show more'}
                </button>
            )}
        </div>
    );
}
