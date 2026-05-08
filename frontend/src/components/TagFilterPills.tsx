import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
     * Sort order for non-hero pills:
     *  - "group" (default): respect admin group/tag ordinals
     *  - "event_count": sort by event_count descending
     * Hero pills are always rendered first regardless of this setting.
     */
    sortMode?: 'group' | 'event_count';
}

// Pill height (text-[11px] + py-px + 1px borders) ≈ 20px.
// Row gap (gap-1) = 4px.
const ROW_HEIGHT_PX = 20;
const ROW_GAP_PX = 4;
const COLLAPSED_ROWS = 2;
const EXPANDED_ROWS = 4;
const COLLAPSED_MAX_PX = ROW_HEIGHT_PX * COLLAPSED_ROWS + ROW_GAP_PX * (COLLAPSED_ROWS - 1); // 44
const EXPANDED_MAX_PX = ROW_HEIGHT_PX * EXPANDED_ROWS + ROW_GAP_PX * (EXPANDED_ROWS - 1);    // 92

type EnrichedTag = TagGroup['tags'][number] & {
    _groupColor: string;
    _groupOrdinal: number;
};

function flattenAndSort(tagGroups: TagGroup[]): EnrichedTag[] {
    return tagGroups
        .filter((g) => g.enabled !== false)
        .flatMap((g) =>
            g.tags
                .filter((t) => t.enabled !== false && (t.event_count == null || t.event_count > 0))
                .map((t) => ({
                    ...t,
                    _groupColor: g.color ?? t.color ?? '#6b7280',
                    _groupOrdinal: g.ordinal,
                })),
        )
        .sort((a, b) => {
            if (a._groupOrdinal !== b._groupOrdinal) return a._groupOrdinal - b._groupOrdinal;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });
}

function selectHeroes(allTags: EnrichedTag[]): EnrichedTag[] {
    return allTags
        .filter((t) => t.is_hero_filter)
        .sort((a, b) => {
            const ao = a.hero_ordinal ?? Infinity;
            const bo = b.hero_ordinal ?? Infinity;
            if (ao !== bo) return ao - bo;
            if (a._groupOrdinal !== b._groupOrdinal) return a._groupOrdinal - b._groupOrdinal;
            if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
            return a.label.localeCompare(b.label);
        });
}

function selectRemainder(
    allTags: EnrichedTag[],
    heroTags: EnrichedTag[],
    sortMode: 'group' | 'event_count',
): EnrichedTag[] {
    const heroIds = new Set(heroTags.map((t) => t.id));
    const rest = allTags.filter((t) => !heroIds.has(t.id));
    if (sortMode === 'event_count') {
        return [...rest].sort((a, b) => {
            const ac = a.event_count ?? 0;
            const bc = b.event_count ?? 0;
            if (ac !== bc) return bc - ac;
            return a.label.localeCompare(b.label);
        });
    }
    return rest;
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

export default function TagFilterPills({
    tagGroups,
    activeTagIds,
    onToggle,
    onClear,
    countOverrides,
    sortMode = 'group',
}: Props) {
    // Default state on every page/refresh: collapsed (2 rows).
    const [expanded, setExpanded] = useState(false);
    const [hasOverflow, setHasOverflow] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const allTags = useMemo(() => flattenAndSort(tagGroups), [tagGroups]);
    const heroTags = useMemo(() => selectHeroes(allTags), [allTags]);
    const remainderTags = useMemo(
        () => selectRemainder(allTags, heroTags, sortMode),
        [allTags, heroTags, sortMode],
    );
    const heroTagsOrdered = useMemo(
        () => partitionEnabledFirst(heroTags, activeTagIds, countOverrides),
        [heroTags, activeTagIds, countOverrides],
    );
    const remainderTagsOrdered = useMemo(
        () => partitionEnabledFirst(remainderTags, activeTagIds, countOverrides),
        [remainderTags, activeTagIds, countOverrides],
    );
    const allOrdered = useMemo(
        () => [...heroTagsOrdered, ...remainderTagsOrdered],
        [heroTagsOrdered, remainderTagsOrdered],
    );

    // Detect whether natural pill content overflows 2 rows. We always render
    // every pill; CSS clips overflow. scrollHeight reflects full content
    // height regardless of clipping.
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        setHasOverflow(el.scrollHeight > COLLAPSED_MAX_PX + 1);
    }, [allOrdered.length, expanded]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            setHasOverflow(el.scrollHeight > COLLAPSED_MAX_PX + 1);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    if (!allTags.length) return null;

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
                className={`inline-flex items-center gap-0.5 px-2 py-px text-[11px] font-medium transition-colors border ${active ? 'text-white shadow-sm' : 'text-gray-700'
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

    const containerStyle: React.CSSProperties = expanded
        ? { maxHeight: `${EXPANDED_MAX_PX}px`, overflowY: 'auto' }
        : { maxHeight: `${COLLAPSED_MAX_PX}px`, overflow: 'hidden' };

    return (
        <div className="relative">
            <div
                ref={containerRef}
                className="flex flex-wrap gap-1 items-center"
                style={containerStyle}
            >
                {activeTagIds.size > 0 && (
                    <button
                        onClick={onClear}
                        className="inline-flex h-5 w-5 items-center justify-center text-rose-500 hover:text-rose-700 font-semibold mr-1"
                        aria-label="Clear tag filters"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                            <path fillRule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                )}
                {allOrdered.map(renderPill)}
            </div>

            {/* Collapsed overflow: floating "Show more" with gradient fade so
                pills underneath fade into white instead of being abruptly hidden. */}
            {!expanded && hasOverflow && (
                <>
                    <div
                        aria-hidden
                        className="pointer-events-none absolute right-0 bottom-0 h-5 w-24 bg-gradient-to-l from-white via-white/95 to-transparent"
                    />
                    <button
                        onClick={() => setExpanded(true)}
                        className="absolute bottom-0 right-0 border border-slate-200 bg-white px-2 py-px text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition"
                        aria-label="Show more tags"
                    >
                        Show more
                    </button>
                </>
            )}

            {expanded && (
                <button
                    onClick={() => {
                        // Reset scroll so collapsing always shows the first 2 rows.
                        if (containerRef.current) containerRef.current.scrollTop = 0;
                        setExpanded(false);
                    }}
                    className="mt-1 border border-slate-200 bg-white px-2 py-px text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition"
                    aria-label="Show fewer tags"
                >
                    Show less
                </button>
            )}
        </div>
    );
}
