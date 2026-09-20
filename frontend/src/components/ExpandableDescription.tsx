import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
    text: string;
    compact?: boolean;
    /** Larger body copy with a centered expansion control for the Details tab. */
    variant?: 'default' | 'details';
    /** Tailwind line-clamp class. Defaults to line-clamp-6. */
    clampClass?: string;
    /** Numeric line limit used when a generated Tailwind class is unavailable. */
    maxLines?: number;
    /** Background applied behind the inline more control. */
    moreBackgroundClassName?: string;
    /** When set, the whole preview opens another view instead of expanding inline. */
    onOpen?: () => void;
}

/**
 * Renders `text` (preserving newlines) clamped to N lines with a
 * "Show more" / "Show less" toggle that only appears if the text overflows
 * the clamped height.
 */
export default function ExpandableDescription({
    text,
    compact = false,
    variant = 'default',
    clampClass = 'line-clamp-6',
    maxLines,
    moreBackgroundClassName = 'bg-surface',
    onOpen,
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

    const details = variant === 'details';
    const description = (
        <div
            ref={ref}
            className={`whitespace-pre-line text-ink-soft ${details ? 'text-sm leading-relaxed' : `leading-relaxed ${compact ? 'text-xs' : 'text-sm'}`} ${expanded || maxLines != null ? '' : clampClass}`}
            style={!expanded && maxLines != null ? {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: maxLines,
                overflow: 'hidden',
            } : undefined}
        >
            {text}
        </div>
    );

    if (onOpen) {
        return (
            <button type="button" onClick={onOpen} className="block w-full text-left">
                {description}
                {overflowing && (
                    <span className="mt-1 block text-sm font-medium text-action hover:underline">
                        …more
                    </span>
                )}
            </button>
        );
    }

    if (details) {
        return (
            <div>
                {description}
                {overflowing && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setExpanded((current) => !current); }}
                        aria-expanded={expanded}
                        className="mx-auto mt-3 flex items-center gap-1 text-sm font-medium text-action hover:underline"
                    >
                        {expanded ? 'Show less' : 'Read more'}
                        {expanded
                            ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
                            : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div>
            <div className="relative">
                {description}
                {overflowing && !expanded && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
                        className={`absolute bottom-0 right-0 pl-1 text-xs font-medium text-action hover:underline ${moreBackgroundClassName}`}
                    >
                        …more
                    </button>
                )}
            </div>
            {expanded && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                    className="mt-1 text-xs font-medium text-action hover:underline"
                >
                    Show less
                </button>
            )}
        </div>
    );
}
