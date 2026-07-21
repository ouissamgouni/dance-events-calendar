import { Fragment, useMemo } from 'react';
import type { TagGroup } from '../types';

interface Props {
    tagGroups: TagGroup[];
    activeTagIds: Set<number>;
    onToggle: (tagId: number) => void;
    onClear: () => void;
    /**
     * Optional map of tagId -> residual count under the currently active filters
     * (disjunctive faceting). Overrides static `tag.event_count` for display
     * and renders zero-count pills as disabled.
     */
    countOverrides?: Map<number, number>;
    /**
     * Sort order for non-hero pills within each group's row:
     *  - "group" (default): respect admin tag ordinals
     *  - "event_count": sort by event_count descending
     * Hero pills are always rendered first within their group's row,
     * regardless of this setting.
     */
    sortMode?: 'group' | 'event_count';
    /**
     * Optional content rendered as the last row, after the last tag
     * group's row. Used by the explorer to surface a "save as default"
     * link.
     */
    trailingSlot?: React.ReactNode;
}

type EnrichedTag = TagGroup['tags'][number] & {
    _groupColor: string;
};

interface GroupRow {
    key: string;
    label: string;
    tags: EnrichedTag[];
}

function selectHeroes(tags: EnrichedTag[]): EnrichedTag[] {
    return tags
        .filter((t) => t.is_hero_filter)
        .sort((a, b) => {
            const ao = a.hero_ordinal ?? Infinity;
            const bo = b.hero_ordinal ?? Infinity;
            if (ao !== bo) return ao - bo;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });
}

function selectRemainder(
    tags: EnrichedTag[],
    heroTags: EnrichedTag[],
    sortMode: 'group' | 'event_count',
): EnrichedTag[] {
    const heroIds = new Set(heroTags.map((t) => t.id));
    const rest = tags.filter((t) => !heroIds.has(t.id));
    if (sortMode === 'event_count') {
        return [...rest].sort((a, b) => {
            const ac = a.event_count ?? 0;
            const bc = b.event_count ?? 0;
            if (ac !== bc) return bc - ac;
            return a.label.localeCompare(b.label);
        });
    }
    return [...rest].sort((a, b) => {
        if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
        return a.label.localeCompare(b.label);
    });
}

/**
 * Move pills with no remaining matches (residual count = 0 and not active)
 * to the end, preserving order otherwise.
 */
function partitionEnabledFirst(
    arr: EnrichedTag[],
    activeTagIds: Set<number>,
    countOverrides: Map<number, number> | undefined,
): EnrichedTag[] {
    const enabled: EnrichedTag[] = [];
    const disabled: EnrichedTag[] = [];
    for (const t of arr) {
        const isActive = activeTagIds.has(t.id);
        const c = countOverrides?.get(t.id) ?? t.event_count ?? null;
        const isDisabled = !isActive && c === 0;
        (isDisabled ? disabled : enabled).push(t);
    }
    return [...enabled, ...disabled];
}

// One row per tag group, sorted by group ordinal. Within a row, that
// group's hero tags come first (by hero_ordinal), then the rest per
// `sortMode`; zero-residual-count pills are pushed to the row's end.
function buildGroupRows(
    tagGroups: TagGroup[],
    sortMode: 'group' | 'event_count',
    activeTagIds: Set<number>,
    countOverrides: Map<number, number> | undefined,
): GroupRow[] {
    return tagGroups
        .filter((g) => g.enabled !== false)
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((g) => {
            const tags: EnrichedTag[] = g.tags
                .filter((t) => t.enabled !== false && (t.event_count == null || t.event_count > 0))
                .map((t) => ({ ...t, _groupColor: g.color ?? t.color ?? '#6b7280' }));
            const heroTags = selectHeroes(tags);
            const remainderTags = selectRemainder(tags, heroTags, sortMode);
            const ordered = [
                ...partitionEnabledFirst(heroTags, activeTagIds, countOverrides),
                ...partitionEnabledFirst(remainderTags, activeTagIds, countOverrides),
            ];
            return { key: g.slug, label: g.label, tags: ordered };
        })
        .filter((row) => row.tags.length > 0);
}

export default function TagFilterPills({
    tagGroups,
    activeTagIds,
    onToggle,
    onClear,
    countOverrides,
    sortMode = 'group',
    trailingSlot,
}: Props) {
    const groupRows = useMemo(
        () => buildGroupRows(tagGroups, sortMode, activeTagIds, countOverrides),
        [tagGroups, sortMode, activeTagIds, countOverrides],
    );

    if (!groupRows.length) return null;

    const renderPill = (tag: EnrichedTag) => {
        const active = activeTagIds.has(tag.id);
        const displayCount = countOverrides?.get(tag.id) ?? tag.event_count ?? null;
        const disabled = !active && displayCount === 0;
        const c = tag._groupColor;
        return (
            <button
                key={tag.id}
                onClick={() => { if (!disabled) onToggle(tag.id); }}
                disabled={disabled}
                aria-disabled={disabled}
                className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap px-2 py-px text-[11px] font-medium transition-colors border ${active ? 'text-white shadow-sm' : 'text-gray-700'
                    } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                style={
                    active
                        ? { backgroundColor: c, borderColor: c }
                        : { backgroundColor: `${c}30`, borderColor: `${c}50` }
                }
            >
                {tag.label}
                {displayCount != null && (
                    <span className={`text-[9px] font-semibold ${active ? 'opacity-80' : 'opacity-60'}`}>
                        {displayCount}
                    </span>
                )}
            </button>
        );
    };

    return (
        <div className="flex flex-col gap-1.5">
            {activeTagIds.size > 0 && (
                <div className="flex justify-end">
                    <button
                        onClick={onClear}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-500 hover:text-rose-700"
                        aria-label="Clear tag filters"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                            <path fillRule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                        Clear tags
                    </button>
                </div>
            )}
            {/* 2-column grid: label column | horizontally-scrollable tags column.
                `auto-rows` fixes each row's height so `max-h-24` (3 * 1.75rem
                rows + 2 * 0.375rem gaps = 6rem) shows exactly 3 groups by
                default, with the rest reachable via vertical scroll. */}
            <div className="grid grid-cols-[max-content_1fr] auto-rows-[1.75rem] items-center gap-x-2 gap-y-1.5 max-h-24 overflow-y-auto pr-1">
                {groupRows.map((row) => (
                    <Fragment key={row.key}>
                        <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-slate-500">
                            {row.label}
                        </span>
                        <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto scrollbar-hide py-0.5">
                            {row.tags.map(renderPill)}
                        </div>
                    </Fragment>
                ))}
            </div>
            {trailingSlot}
        </div>
    );
}
