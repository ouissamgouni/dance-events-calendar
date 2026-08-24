export type ExploreView = 'list' | 'map' | 'calendar';

interface ViewSwitcherProps {
    currentView: ExploreView;
    onSelect: (view: ExploreView) => void;
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
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
                <path d="M9 4v14M15 6v14" />
            </svg>
        );
    }
    if (view === 'calendar') {
        return (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4.5" width="18" height="16" rx="2" />
                <path d="M3 9h18M8 2.5v4M16 2.5v4" />
            </svg>
        );
    }
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </svg>
    );
}

export default function ViewSwitcher({ currentView, onSelect }: ViewSwitcherProps) {
    return (
        <nav
            aria-label="Change event view"
            className="fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-[8100] flex items-center border border-line bg-surface shadow-lg md:bottom-4"
            data-testid="view-switcher"
        >
            {destinations[currentView].map((view, index) => (
                <button
                    key={view}
                    type="button"
                    onClick={() => onSelect(view)}
                    aria-label={`${labels[view]} view`}
                    title={`${labels[view]} view`}
                    className={`inline-flex h-10 w-10 items-center justify-center text-ink transition hover:bg-canvas ${index > 0 ? 'border-l border-line' : ''}`}
                    data-testid={`view-switcher-${view}`}
                >
                    <ViewIcon view={view} />
                </button>
            ))}
        </nav>
    );
}
