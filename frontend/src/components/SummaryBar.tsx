import { useMemo } from 'react';
import type { TagGroup } from '../types';

// SummaryBar — single mobile-first strip that shows every active filter +
// the visible/total event counts in one place. Sits above the
// EventListPanel and consolidates what used to be a separate ScopeBanner
// plus a row of inline chips. Square corners, blue-500 primary, secondary
// slate chrome per .github/instructions/frontend.instructions.md.

export type InterestSource = 'follows' | 'friends' | null;
export type InterestKind = 'any' | 'going' | 'saved';

export interface SummaryBarProps {
    // Counts: ``totalCount`` is the size of the full filtered set;
    // ``visibleCount`` is what's currently rendered in the list. Equal
    // values render as a single number ("87 events"); otherwise renders
    // "Showing X of Y".
    totalCount: number;
    visibleCount: number;

    // Period chip. ``startDate``/``endDate`` are ISO yyyy-mm-dd. Tap re-opens
    // the date picker (parent handles).
    startDate: string;
    endDate: string;
    onEditPeriod?: () => void;

    // Area chip. ``label`` is shown verbatim; ``kind`` colors it subtly
    // (map view / show all / user prefs / default). ``onEditArea`` opens
    // the area picker, ``onClearArea`` clears any area session override.
    areaLabel: string;
    areaKind: 'map-view' | 'show-all' | 'user' | 'default';
    onEditArea?: () => void;
    onClearArea?: () => void;
    areaIsDefault: boolean;

    // Tag chips. ``activeTagIds`` resolved against ``tagGroups``; unknown
    // ids are skipped silently.
    activeTagIds: Set<number>;
    tagGroups: TagGroup[];
    onRemoveTag: (tagId: number) => void;

    // Interest chips.
    interestSource: InterestSource;
    interestKind: InterestKind;
    interestUserHandle: string | null;
    onClearInterest: () => void;

    // Clear-all link, only rendered when ≥1 non-default filter active.
    onClearAll: () => void;

    // Loading: dims the count while a fetch is in flight so users don't
    // misread a stale "0 of 0".
    loading?: boolean;

    // When provided, renders a leading "Filters (N)" pill that opens the
    // mobile FilterSheet. This lets the SummaryBar double as the mobile
    // filter strip — applied-filter chips render inline next to the
    // opener so users see at a glance what's narrowing the result set.
    onOpenFilters?: () => void;
    activeFilterCount?: number;
}

function formatPeriodLabel(startDate: string, endDate: string): string {
    // Best-effort short label; falls back to ISO if parsing fails.
    const parse = (iso: string) => {
        const [y, m, d] = iso.split('-').map(Number);
        if (!y || !m || !d) return null;
        return new Date(y, m - 1, d);
    };
    const start = parse(startDate);
    const end = parse(endDate);
    if (!start || !end) return `${startDate} → ${endDate}`;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sameYear = start.getFullYear() === end.getFullYear();
    const fmt = (d: Date, withYear: boolean) =>
        d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            ...(withYear ? { year: 'numeric' } : {}),
        });
    const startLabel = start.getTime() === today.getTime()
        ? 'Today'
        : fmt(start, !sameYear);
    return `${startLabel} → ${fmt(end, true)}`;
}

interface ChipProps {
    label: string;
    title?: string;
    tone?: 'neutral' | 'accent';
    onClick?: () => void;
    onRemove?: () => void;
    removeAriaLabel?: string;
    testId?: string;
}

function Chip({ label, title, tone = 'neutral', onClick, onRemove, removeAriaLabel, testId }: ChipProps) {
    // Square, no rounded corners. Accent tone bumps the border + bg to make
    // the period/count chips slightly more prominent than tag chips.
    const base = 'inline-flex items-center gap-1 max-w-full text-xs font-medium border transition';
    const toneClasses = tone === 'accent'
        ? 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50';
    const clickable = onClick ? 'cursor-pointer' : '';
    const padding = onRemove ? 'pl-2 pr-1 py-0.5' : 'px-2 py-0.5';
    return (
        <span
            className={`${base} ${toneClasses} ${clickable} ${padding}`}
            title={title ?? label}
            onClick={onClick}
            data-testid={testId}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={(e) => {
                if (!onClick) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
        >
            <span className="truncate">{label}</span>
            {onRemove && (
                <button
                    type="button"
                    aria-label={removeAriaLabel ?? `Remove ${label}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                >
                    ×
                </button>
            )}
        </span>
    );
}

export default function SummaryBar(props: SummaryBarProps) {
    const {
        totalCount,
        visibleCount,
        startDate,
        endDate,
        onEditPeriod,
        areaLabel,
        areaKind,
        onEditArea,
        onClearArea,
        areaIsDefault,
        activeTagIds,
        tagGroups,
        onRemoveTag,
        interestSource,
        interestKind,
        interestUserHandle,
        onClearInterest,
        onClearAll,
        loading,
        onOpenFilters,
        activeFilterCount = 0,
    } = props;

    const tagChips = useMemo(() => {
        if (activeTagIds.size === 0) return [];
        const lookup = new Map<number, { label: string; groupLabel: string }>();
        for (const g of tagGroups) {
            for (const t of g.tags) {
                lookup.set(t.id, { label: t.label, groupLabel: g.label });
            }
        }
        return Array.from(activeTagIds)
            .map((id) => ({ id, ...(lookup.get(id) ?? { label: `#${id}`, groupLabel: '' }) }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [activeTagIds, tagGroups]);

    const interestChip = useMemo(() => {
        if (!interestSource && interestKind === 'any' && !interestUserHandle) return null;
        const parts: string[] = [];
        if (interestUserHandle) parts.push(`@${interestUserHandle}`);
        else if (interestSource === 'follows') parts.push('People you follow');
        else if (interestSource === 'friends') parts.push('Friends');
        if (interestKind === 'going') parts.push('going');
        else if (interestKind === 'saved') parts.push('saved');
        return parts.join(' · ');
    }, [interestSource, interestKind, interestUserHandle]);

    const hasAnyNonDefault =
        tagChips.length > 0
        || interestChip !== null
        || !areaIsDefault;

    const showShowing = visibleCount > 0 && visibleCount < totalCount;
    const countLabel = totalCount === 0
        ? 'No events'
        : showShowing
            ? `Showing ${visibleCount} of ${totalCount}`
            : `${totalCount} event${totalCount === 1 ? '' : 's'}`;

    return (
        <div
            className="summary-bar w-full bg-white border-y border-slate-200 px-3 py-2"
            data-testid="summary-bar"
            aria-label="Active filters and result count"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    {onOpenFilters && (
                        <button
                            type="button"
                            onClick={onOpenFilters}
                            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-2 py-0.5 transition"
                            data-testid="summary-open-filters"
                            aria-label={`Open filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ''}`}
                        >
                            <span>Filters</span>
                            {activeFilterCount > 0 && (
                                <span className="inline-flex items-center justify-center min-w-[1rem] h-4 px-1 text-[10px] font-semibold bg-blue-500 text-white">
                                    {activeFilterCount}
                                </span>
                            )}
                        </button>
                    )}
                    <Chip
                        label={formatPeriodLabel(startDate, endDate)}
                        tone="accent"
                        onClick={onEditPeriod}
                        testId="summary-chip-period"
                    />
                    <Chip
                        label={areaLabel}
                        title={
                            areaKind === 'map-view' ? 'Current map view'
                                : areaKind === 'show-all' ? 'Worldwide'
                                    : areaLabel
                        }
                        onClick={onEditArea}
                        onRemove={!areaIsDefault && onClearArea ? onClearArea : undefined}
                        removeAriaLabel="Reset area to default"
                        testId="summary-chip-area"
                    />
                    {tagChips.map((t) => (
                        <Chip
                            key={t.id}
                            label={t.label}
                            title={t.groupLabel ? `${t.groupLabel}: ${t.label}` : t.label}
                            onRemove={() => onRemoveTag(t.id)}
                            removeAriaLabel={`Remove ${t.label} tag`}
                            testId={`summary-chip-tag-${t.id}`}
                        />
                    ))}
                    {interestChip && (
                        <Chip
                            label={interestChip}
                            onRemove={onClearInterest}
                            removeAriaLabel="Clear interest filter"
                            testId="summary-chip-interest"
                        />
                    )}
                    {hasAnyNonDefault && (
                        <button
                            type="button"
                            onClick={onClearAll}
                            className="ml-1 inline-flex items-center text-xs text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline"
                            data-testid="summary-clear-all"
                        >
                            Clear all
                        </button>
                    )}
                </div>
                <div
                    className={`shrink-0 text-xs font-semibold tabular-nums ${loading ? 'text-slate-400' : 'text-slate-700'}`}
                    data-testid="summary-count"
                    aria-live="polite"
                >
                    {countLabel}
                </div>
            </div>
        </div>
    );
}
