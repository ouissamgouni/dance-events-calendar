export type AreaChipState =
    | { kind: 'map-view' }
    | { kind: 'show-all' }
    | { kind: 'user'; label: string }
    | { kind: 'default'; label: string };

interface AreaFilterChipProps {
    /** Discriminates the four user-visible cases — see {@link AreaChipState}. */
    state: AreaChipState;
}

/**
 * Inline icon + label used inside the default-area bar. Renders only the
 * content (icon + prefix + label); the bar styling (background, border,
 * padding) is owned by the parent so chip + action buttons sit inside one
 * visually unified pill.
 */
export default function AreaFilterChip({ state }: AreaFilterChipProps) {
    if (state.kind === 'map-view') {
        // The user has panned/zoomed away from the configured area; the
        // events query follows the live viewport. Surfacing this explicitly
        // tells the user "what you see on the map is what's being queried"
        // — without it the chip would still read "Default area: Europe"
        // even after panning to Asia, which is misleading.
        return (
            <span
                className="flex items-center gap-1.5 min-w-0"
                data-testid="area-filter-chip"
                data-area-state="map-view"
            >
                <span aria-hidden="true">🔍</span>
                <span className="truncate">Custom map view</span>
            </span>
        );
    }
    if (state.kind === 'show-all') {
        return (
            <span
                className="flex items-center gap-1.5 min-w-0"
                data-testid="area-filter-chip"
                data-area-state="all"
                aria-label="Worldwide"
            >
                <span aria-hidden="true">🌐</span>
                <span className="truncate" aria-hidden="true">🌐</span>
            </span>
        );
    }

    const prefix = state.kind === 'default' ? '' : 'Your area:';
    const icon = state.kind === 'default' ? '🧭' : '📍';

    return (
        <span
            className="flex items-center gap-1.5 min-w-0"
            data-testid="area-filter-chip"
            data-area-state={state.kind}
        >
            <span aria-hidden="true">{icon}</span>
            <span className="truncate min-w-0">
                {prefix} <span className="font-medium">{state.label}</span>
            </span>
        </span>
    );
}
