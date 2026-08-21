import { useState } from 'react';
import type { TagGroup } from '../types';

interface MoreFiltersEditorProps {
    groups: TagGroup[];
    /** Renders the pill picker for a single group. */
    renderGroup: (group: TagGroup) => React.ReactNode;
    /** Number of currently-selected tags in a group. */
    selCount: (group: TagGroup) => number;
    /** Short summary of the current selection for a group. */
    summary: (group: TagGroup) => string;
}

/**
 * Nested navigable list for the "More filters" section: the main view lists one
 * row per tag group, and tapping a row opens that group's pills on its own
 * surface (with a back affordance). Layout only — selection logic lives in the
 * pill picker passed via {@link MoreFiltersEditorProps.renderGroup}.
 */
export default function MoreFiltersEditor({ groups, renderGroup, selCount, summary }: MoreFiltersEditorProps) {
    const [activeId, setActiveId] = useState<number | null>(null);
    const active = groups.find((g) => g.id === activeId) ?? null;

    if (active) {
        return (
            <div className="flex flex-col gap-3">
                <button
                    type="button"
                    onClick={() => setActiveId(null)}
                    className="inline-flex items-center gap-1 self-start text-sm font-medium text-action hover:opacity-80"
                    data-testid="more-filters-back"
                >
                    <span aria-hidden="true">‹</span>
                    <span>{active.label}</span>
                </button>
                {renderGroup(active)}
            </div>
        );
    }

    return (
        <ul className="divide-y divide-card-line" data-testid="more-filters-list">
            {groups.map((g) => {
                const n = selCount(g);
                const value = n > 0 ? summary(g) : 'Any';
                return (
                    <li key={g.id}>
                        <button
                            type="button"
                            onClick={() => setActiveId(g.id)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas"
                            data-testid={`more-filters-row-${g.id}`}
                        >
                            <span className="text-[15px] font-medium text-ink">{g.label}</span>
                            <span className={`ml-auto truncate text-xs ${n > 0 ? 'text-ink-soft' : 'text-muted'}`}>
                                {value}
                            </span>
                            <span className="text-ink-soft" aria-hidden="true">›</span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
