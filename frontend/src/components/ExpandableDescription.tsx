import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cleanEventDescription } from '../utils/eventDescription';

interface Props {
    text: string;
    compact?: boolean;
    /** Maximum visible lines while collapsed. Defaults to 6. */
    maxLines?: number;
    /** Opaque background behind the inline more control. */
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
    maxLines = 6,
    moreBackgroundClassName = 'bg-surface',
    onOpen,
}: Props) {
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);
    const displayText = cleanEventDescription(text);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        // When collapsed, scrollHeight > clientHeight means content is clipped.
        setOverflowing(el.scrollHeight - el.clientHeight > 1);
    }, [displayText, maxLines]);

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

    const collapsedStyle = expanded
        ? undefined
        : { maxHeight: `${maxLines * 1.625}em` };

    const description = (
        <span
            ref={ref}
            style={collapsedStyle}
            className={`block whitespace-pre-line leading-relaxed text-ink-soft ${compact ? 'text-xs' : 'text-sm'} ${expanded ? '' : 'overflow-hidden'}`}
        >
            {displayText}
        </span>
    );

    if (onOpen) {
        return (
            <button type="button" onClick={onOpen} className="relative block w-full text-left">
                {description}
                {overflowing && (
                    <span className={`absolute bottom-0 right-0 pl-1 text-sm font-medium text-action ${moreBackgroundClassName}`}>
                        …more
                    </span>
                )}
            </button>
        );
    }

    return (
        <div>
            <div className="relative">
                {description}
                {!expanded && overflowing && (
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className={`absolute bottom-0 right-0 pl-1 text-xs font-medium text-action hover:underline ${moreBackgroundClassName}`}
                    >
                        …more
                    </button>
                )}
            </div>
            {expanded && (
                <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="mt-1 text-xs font-medium text-action hover:underline"
                >
                    Show less
                </button>
            )}
        </div>
    );
}
