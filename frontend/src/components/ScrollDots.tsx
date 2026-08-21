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
 * shown as an elongated dot; tapping a dot scrolls the rail to that page.
 */
export default function ScrollDotsIndicator({
    count,
    activeIndex,
    onSelect,
    label = 'Scroll position',
    className = '',
}: ScrollDotsIndicatorProps) {
    if (count <= 1) return null;

    return (
        <div
            role="tablist"
            aria-label={label}
            className={`flex items-center justify-center gap-1.5 pt-1 ${className}`}
            data-testid="scroll-dots"
        >
            {Array.from({ length: count }, (_, index) => {
                const isActive = index === activeIndex;
                return (
                    <button
                        key={index}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-label={`Go to page ${index + 1} of ${count}`}
                        onClick={() => onSelect(index)}
                        className={`h-1.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-blue-300 ${isActive ? 'w-4 bg-ink-soft' : 'w-1.5 bg-muted/40 hover:bg-muted'}`}
                    />
                );
            })}
        </div>
    );
}
