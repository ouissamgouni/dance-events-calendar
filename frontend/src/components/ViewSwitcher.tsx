import type { CSSProperties } from 'react';

export type ExploreView = 'list' | 'map' | 'calendar';

interface ViewSwitcherProps {
    currentView: ExploreView;
    onSelect: (view: ExploreView) => void;
    mapPreviewVisible?: boolean;
    /** Height (px) of the map preview sheet, so the control floats just
     * above it instead of jumping to the top of the viewport. */
    previewOffsetPx?: number;
    /** When provided, renders a separate "+" action. */
    onCreate?: () => void;
    /** When true, presents the create action as a control that closes the
     * currently open create flow. */
    createExpanded?: boolean;
    /** Show text labels below the desktop breakpoint. Desktop labels are
     * always visible. */
    mobileLabelsEnabled?: boolean;
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

/** Vertical map space taken by the floating switcher (h-12 control + 12px gap). */
export const VIEW_SWITCHER_BAND_PX = 60;

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

export default function ViewSwitcher({ currentView, onSelect, mapPreviewVisible, previewOffsetPx, onCreate, createExpanded, mobileLabelsEnabled = true }: ViewSwitcherProps) {
    // Float just above the map preview card, or near the map's bottom edge.
    // The map ends above the mobile bottom nav (64px + safe-area) but reaches
    // the viewport bottom from md up, where the nav is hidden.
    const previewOpen = !!mapPreviewVisible;
    const measuredOffset = previewOffsetPx != null && previewOffsetPx > 0 ? previewOffsetPx : 220;
    const offsetPx = previewOpen ? measuredOffset + 12 : 16;
    const destinationClass = mobileLabelsEnabled
        ? 'inline-flex h-11 items-center justify-center gap-2 px-3 text-ink transition hover:bg-blue-100'
        : 'inline-flex h-11 w-11 items-center justify-center text-ink transition hover:bg-blue-100 lg:w-auto lg:gap-2 lg:px-3';
    const labelClass = mobileLabelsEnabled
        ? 'text-sm font-medium'
        : 'hidden text-sm font-medium lg:inline';
    const createClass = mobileLabelsEnabled
        ? 'pointer-events-auto inline-flex h-12 items-center justify-center gap-2 border-2 border-line bg-canvas px-3 text-action shadow-xl transition hover:bg-surface'
        : 'pointer-events-auto inline-flex h-12 w-12 items-center justify-center border-2 border-line bg-canvas text-action shadow-xl transition hover:bg-surface lg:w-auto lg:gap-2 lg:px-3';
    return (
        <nav
            aria-label="Change event view"
            className={`pointer-events-none fixed inset-x-4 z-[8000] flex items-center justify-between transition-[bottom] bottom-[calc(var(--bottom-nav-offset,64px)+env(safe-area-inset-bottom)+var(--map-preview-offset))] md:bottom-[var(--map-preview-offset)]`}
            style={{ '--map-preview-offset': `${offsetPx}px` } as CSSProperties}
            data-testid="view-switcher"
        >
            <div className="pointer-events-auto flex items-center border-2 border-blue-100 bg-blue-50 shadow-xl" data-testid="view-switcher-destinations">
                {destinations[currentView].map((view, index) => (
                    <button
                        key={view}
                        type="button"
                        onClick={() => onSelect(view)}
                        aria-label={`${labels[view]} view`}
                        title={`${labels[view]} view`}
                        className={`${destinationClass} ${index > 0 ? 'border-l-2 border-line' : ''}`}
                        data-testid={`view-switcher-${view}`}
                    >
                        <ViewIcon view={view} />
                        <span className={labelClass}>{labels[view]}</span>
                    </button>
                ))}
            </div>
            {onCreate && (
                <button
                    type="button"
                    onClick={onCreate}
                    aria-label={createExpanded ? 'Close event search' : 'Add event'}
                    aria-expanded={createExpanded}
                    title={createExpanded ? 'Close event search' : 'Add event'}
                    className={createClass}
                    data-testid="view-switcher-create"
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-6 w-6 transition ${createExpanded ? 'rotate-45' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                    <span className={labelClass}>{createExpanded ? 'Close' : 'Add'}</span>
                </button>
            )}
        </nav>
    );
}
