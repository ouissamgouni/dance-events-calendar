interface ScrollDotsIndicatorProps {
    /** Total number of pages. Renders nothing when 1 or fewer. */
    count: number;
    /** Currently visible page index. */
    activeIndex: number;
    /** Called with the page index when a dot is activated. */
    onSelect: (index: number) => void;
    /** Accessible label for the dot group. */
    label?: string;
    className?: string;
}

/**
 * Page-based scroll position indicator for a horizontal rail. The active page is
 * shown as an elongated dot; tapping a dot scrolls the rail to that page. When
 * there are more pages than `MAX_DOTS`, a sliding window centered on the active
 * page is shown with the edge dots tapered to hint that more pages exist.
 */
const MAX_DOTS = 7;

export default function ScrollDotsIndicator({
    count,
    activeIndex,
    onSelect,
    label = 'Scroll position',
    className = '',
}: ScrollDotsIndicatorProps) {
    if (count <= 1) return null;

    const windowed = count > MAX_DOTS;
    const visibleCount = windowed ? MAX_DOTS : count;
    const start = windowed
        ? Math.min(Math.max(0, activeIndex - Math.floor(MAX_DOTS / 2)), count - MAX_DOTS)
        : 0;
    const moreBefore = start > 0;
    const moreAfter = start + visibleCount < count;

    return (
        <div
            role="tablist"
            aria-label={label}
            className={`flex items-center justify-center gap-1.5 pt-1 ${className}`}
            data-testid="scroll-dots"
        >
            {Array.from({ length: visibleCount }, (_, offset) => {
                const index = start + offset;
                const isActive = index === activeIndex;
                const isTaperedStart = moreBefore && offset === 0;
                const isTaperedEnd = moreAfter && offset === visibleCount - 1;
                const shape = isActive
                    ? 'w-4 bg-ink-soft'
                    : isTaperedStart || isTaperedEnd
                        ? 'w-1 bg-muted/30'
                        : 'w-1.5 bg-muted/40 hover:bg-muted';
                return (
                    <button
                        key={index}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-label={`Go to page ${index + 1} of ${count}`}
                        onClick={() => onSelect(index)}
                        className={`h-1.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-blue-300 ${shape}`}
                    />
                );
            })}
        </div>
    );
}
