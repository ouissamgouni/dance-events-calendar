export type ExploreView = 'list' | 'map' | 'calendar';

interface ViewSwitcherProps {
    currentView: ExploreView;
    onSelect: (view: ExploreView) => void;
    mapPreviewVisible?: boolean;
    /** Height (px) of the map preview sheet, so the control floats just
     * above it instead of jumping to the top of the viewport. */
    previewOffsetPx?: number;
    /** When provided, renders a leading "+" button that opens the
     * suggest-event flow. */
    onCreate?: () => void;
}

const destinations: Record<ExploreView, ExploreView[]> = {
    list: ['map', 'calendar'],
    map: ['list', 'calendar'],
    calendar: ['list', 'map'],
};

const labels: Record<ExploreView, string> = {
    list: 'List',
    map: 'Map',
    calendar: 'Calendar',
};

function ViewIcon({ view }: { view: ExploreView }) {
    if (view === 'map') {
        return (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
                <path d="M9 4v14M15 6v14" />
            </svg>
        );
    }
    if (view === 'calendar') {
        return (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4.5" width="18" height="16" rx="2" />
                <path d="M3 9h18M8 2.5v4M16 2.5v4" />
            </svg>
        );
    }
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </svg>
    );
}

export default function ViewSwitcher({ currentView, onSelect, mapPreviewVisible, previewOffsetPx, onCreate }: ViewSwitcherProps) {
    // When a map preview sheet is open, sit just above it at the bottom of the
    // map. The preview lives inside the fullscreen map shell, whose bottom edge
    // is lifted above the bottom nav (64px + safe-area), so we add that inset to
    // the measured sheet height — otherwise the control floats over the card.
    // Until the first measure lands, fall back to a conservative estimate rather
    // than a fixed class that can overlap the preview card.
    const previewOpen = !!mapPreviewVisible;
    const measuredOffset = previewOffsetPx != null && previewOffsetPx > 0 ? previewOffsetPx : 220;
    const bottomClass = previewOpen
        ? ''
        : 'bottom-[calc(80px+env(safe-area-inset-bottom))]';
    return (
        <nav
            aria-label="Change event view"
            className={`fixed right-4 z-[8000] flex items-center border-2 border-line bg-surface shadow-xl md:bottom-4 ${bottomClass}`}
            style={previewOpen ? { bottom: `calc(64px + env(safe-area-inset-bottom) + ${measuredOffset + 12}px)` } : undefined}
            data-testid="view-switcher"
        >

            {destinations[currentView].map((view, index) => (
                <button
                    key={view}
                    type="button"
                    onClick={() => onSelect(view)}
                    aria-label={`${labels[view]} view`}
                    title={`${labels[view]} view`}
                    className={`inline-flex h-11 w-11 items-center justify-center text-ink transition hover:bg-canvas ${index > 0 ? 'border-l-2 border-line' : ''}`}
                    data-testid={`view-switcher-${view}`}
                >
                    <ViewIcon view={view} />
                </button>
            ))}
            {onCreate && (
                <button
                    type="button"
                    onClick={onCreate}
                    aria-label="Suggest an event"
                    title="Suggest an event"
                    className="inline-flex h-11 w-11 items-center justify-center border-r-2 border-line text-action transition hover:bg-canvas"
                    data-testid="view-switcher-create"
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                </button>
            )}
        </nav>
    );
}
