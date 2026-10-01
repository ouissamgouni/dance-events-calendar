import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagGroup } from '../types';
import { REACH_FILTER_LABELS, type ReachFilter } from '../utils/reach';
import PeopleAvatarTrack, { type PersonMini } from './PeopleAvatarTrack';

// SummaryBar — filter summary with deterministic, width-based priority
// collapse and an opt-in two-row capacity. Fixed semantic priority (left→right):
//   Date → Area → Dance → Reach → People → Remaining (+X ⚙)
// As available width shrinks, pills hide RIGHT-TO-LEFT by priority and every
// hidden/never-shown active filter group folds into a single "+X ⚙" control
// that opens the main Filters sheet. The default bar never wraps or
// horizontally scrolls; the two-line variant wraps once before applying the
// same collapse rule. Pills are visually quiet: neutral background, light
// border, dark text, no active-blue fills — the bar communicates search state
// without competing with the results.

export type InterestSource = 'follows' | 'friends' | null;
export type InterestKind = 'any' | 'going' | 'saved';
export type InterestMatch = 'any' | 'all';

export interface SummaryBarProps {
    className?: string;
    twoLine?: boolean;

    // Counts are accepted for API compatibility with callers but the bar no
    // longer renders them — it shows filter state only.
    totalCount?: number;
    visibleCount?: number;
    loading?: boolean;

    // Date pill (always present). ISO yyyy-mm-dd. Text-only.
    startDate: string;
    endDate: string;
    onEditPeriod?: () => void;

    // Area pill (always present). ``label`` shown verbatim; text-only.
    areaLabel: string;
    areaKind: 'map-view' | 'show-all' | 'user' | 'default';
    onEditArea?: () => void;
    onClearArea?: () => void;
    areaIsDefault: boolean;

    // Tag selection resolved against ``tagGroups``. Every selected tag group
    // that isn't Dance or Reach folds into the "+X" count.
    activeTagIds: Set<number>;
    tagGroups: TagGroup[];

    // Dance pill (text, "Salsa +2") and Reach pill (icon + short label). Pass the
    // resolved groups so the bar can render + deep-link into their editors.
    danceGroup?: TagGroup | null;
    onEditDance?: () => void;
    reachGroup?: TagGroup | null;
    reachFilter: ReachFilter;
    onEditReach?: () => void;

    // People pill (people icon + count of explicitly-selected handles).
    interestSource: InterestSource;
    interestKind: InterestKind;
    interestUserHandles: string[];
    /** Resolved minis for the selected handles — renders avatar faces in the
     * people-type chip instead of a bare count. */
    interestUserPeople?: PersonMini[];
    interestMatch: InterestMatch;
    onEditPeople?: () => void;

    // "Has discount" chip, lowest priority (collapses first).
    discountActive?: boolean;
    onEditDiscount?: () => void;

    // Remaining-filters control. Always rendered as "+X ⚙" (or just "⚙" when
    // nothing extra is active) so the full filter sheet is always reachable.
    onOpenFilters?: () => void;

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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // No end cap (Tribe's all-upcoming mode).
    if (start && !endDate) {
        return start.getTime() === today.getTime() ? 'Any' : `From ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    if (!start || !end) return `${startDate}-${endDate}`;
    const sameYear = start.getFullYear() === end.getFullYear();
    const sameMonth = sameYear && start.getMonth() === end.getMonth();
    const fmt = (d: Date, withYear: boolean) =>
        d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            ...(withYear ? { year: 'numeric' } : {}),
        });
    const startLabel = start.getTime() === today.getTime()
        ? 'Today'
        : fmt(start, !sameYear);
    const endLabel = sameMonth && start.getTime() !== today.getTime()
        ? end.toLocaleDateString(undefined, { day: 'numeric' })
        : fmt(end, !sameYear);
    return `${startLabel}–${endLabel}`;
}

// Shared pill chrome. Neutral only — no accent/blue tone. Rounded ~10px to
// match the design reference (this bar intentionally deviates from the
// square-control convention; it is a distinct, quiet search-state surface).
const PILL_BASE =
    'inline-flex items-center gap-1 h-8 px-3 rounded-[10px] border border-line bg-surface text-ink text-sm font-medium whitespace-nowrap';
const PILL_INTERACTIVE = 'cursor-pointer hover:bg-blue-100 transition';

interface PillProps {
    label?: string;
    title?: string;
    icon?: React.ReactNode;
    onClick?: () => void;
    onRemove?: () => void;
    removeAriaLabel?: string;
    testId?: string;
    ariaLabel?: string;
    className?: string;
    maxWidth?: number;
    labelMaxWidth?: number;
    measureKey?: CandidateKey;
    measureVariant?: PillVariant;
    measureGear?: boolean;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest('button, a, input, select, textarea, [role="button"]') !== null;
}

function Pill({ label, title, icon, onClick, onRemove, removeAriaLabel, testId, ariaLabel, className, maxWidth, labelMaxWidth, measureKey, measureVariant, measureGear }: PillProps) {
    const padding = onRemove ? 'pl-2.5 pr-1' : '';
    return (
        <span
            className={`${PILL_BASE} ${padding} ${onClick ? PILL_INTERACTIVE : ''} ${className ?? ''}`.trim()}
            style={maxWidth === undefined ? undefined : { maxWidth }}
            title={title ?? label}
            aria-label={ariaLabel}
            onClick={onClick}
            data-testid={testId}
            data-measure-key={measureKey}
            data-measure-variant={measureVariant}
            data-measure-gear={measureGear ? '' : undefined}
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
            {icon}
            {label !== undefined && (
                <span
                    className="truncate"
                    style={labelMaxWidth === undefined ? undefined : { maxWidth: labelMaxWidth }}
                >
                    {label}
                </span>
            )}
            {onRemove && (
                <button
                    type="button"
                    aria-label={removeAriaLabel ?? `Remove ${label ?? 'filter'}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    // eslint-disable-next-line no-restricted-syntax -- rounded chrome matches the approved filter-summary UX design reference
                    className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:text-ink hover:bg-canvas"
                >
                    ×
                </button>
            )}
        </span>
    );
}

const ICON_CLS = 'h-4 w-4 shrink-0';
const AREA_COMPACT_LABEL_MAX_WIDTH = 48;

// Every chip carries the same icon its filter-sheet section uses, so the
// summary bar reads as a compact echo of the open Filters sheet.

type CandidateKey = 'period' | 'area' | 'dance' | 'reach' | 'people' | 'discount';
type PillVariant = 'compact' | 'full';

interface SummaryLayout {
    visibleCount: number;
    expandedWidths: Partial<Record<CandidateKey, number>>;
}

export default function SummaryBar(props: SummaryBarProps) {
    const {
        className = '',
        twoLine = false,
        startDate,
        endDate,
        onEditPeriod,
        areaLabel,
        onEditArea,
        onClearArea,
        areaIsDefault,
        activeTagIds,
        tagGroups,
        danceGroup,
        onEditDance,
        reachGroup,
        reachFilter,
        onEditReach,
        interestSource,
        interestKind,
        interestUserHandles,
        interestUserPeople,
        onEditPeople,
        discountActive = false,
        onEditDiscount,
        onOpenFilters,
    } = props;

    const danceSel = useMemo(() => {
        if (!danceGroup) return { compactLabel: '', fullLabel: '', count: 0 };
        const selected = danceGroup.tags.filter((t) => activeTagIds.has(t.id));
        if (selected.length === 0) return { compactLabel: 'Any', fullLabel: 'Any', count: 0 };
        const first = selected[0].label;
        return {
            compactLabel: selected.length > 1 ? `${first} +${selected.length - 1}` : first,
            fullLabel: selected.map((tag) => tag.label).join(', '),
            count: selected.length,
        };
    }, [danceGroup, activeTagIds]);

    // Opt-in: a status-only selection (kind alone) never surfaces a chip.
    const peopleActive = interestSource !== null || interestUserHandles.length > 0;
    // Split people display: a WHO chip (Following / Friends / selected-people
    // avatar track) and a STATUS chip (Going / Interested / Both).
    const peopleStatusLabel = useMemo(() => {
        if (!peopleActive) return '';
        return interestKind === 'going' ? 'Going' : interestKind === 'saved' ? 'Interested' : 'Both';
    }, [peopleActive, interestKind]);
    const peopleTypeLabel = useMemo(() => {
        if (!peopleActive) return '';
        const n = interestUserHandles.length;
        if (n > 0) return `${n} ${n === 1 ? 'person' : 'people'}`;
        return interestSource === 'friends' ? 'Friends' : 'Following';
    }, [peopleActive, interestSource, interestUserHandles]);

    // Every selected tag group that isn't surfaced as its own pill (Dance /
    // Reach, when provided) folds into "+X" — each group counts once,
    // regardless of how many of its tags are selected.
    const foldedRemainingCount = useMemo(() => {
        const handled = new Set<string>();
        if (danceGroup) handled.add(danceGroup.slug);
        if (reachGroup) handled.add(reachGroup.slug);
        let n = 0;
        for (const g of tagGroups) {
            if (handled.has(g.slug)) continue;
            if (g.tags.some((t) => activeTagIds.has(t.id))) n += 1;
        }
        return n;
    }, [tagGroups, activeTagIds, danceGroup, reachGroup]);

    // Ordered candidate pills. People appear first (highest priority), then Date, Area, and Reach.
    // Dance and People appear when they carry a selection.
    const candidates = useMemo(() => {
        const list: CandidateKey[] = [];
        if (peopleActive && onEditPeople) {
            list.push('people');
        }
        list.push('period', 'area');
        if (danceGroup) list.push('dance');
        if (reachGroup) list.push('reach');
        if (discountActive && onEditDiscount) list.push('discount');
        return list;
    }, [danceGroup, danceSel.count, reachGroup, peopleActive, onEditPeople, discountActive, onEditDiscount]);

    // ---- Measurement-based collapse -----------------------------------
    const containerRef = useRef<HTMLDivElement>(null);
    const ghostRowRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [layout, setLayout] = useState<SummaryLayout>({
        visibleCount: candidates.length,
        expandedWidths: {},
    });

    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) setContainerWidth(entry.contentRect.width);
        });
        ro.observe(el);
        setContainerWidth(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    const GAP = 6; // matches gap-1.5

    useLayoutEffect(() => {
        const ghostRow = ghostRowRef.current;
        const compactWidths = new Map<CandidateKey, number>();
        const fullWidths = new Map<CandidateKey, number>();
        for (const key of candidates) {
            compactWidths.set(
                key,
                ghostRow?.querySelector<HTMLElement>(`[data-measure-key="${key}"][data-measure-variant="compact"]`)?.offsetWidth ?? 0,
            );
            fullWidths.set(
                key,
                ghostRow?.querySelector<HTMLElement>(`[data-measure-key="${key}"][data-measure-variant="full"]`)?.offsetWidth ?? 0,
            );
        }
        const widths = candidates.map((key) => compactWidths.get(key) ?? 0);
        const gearW = ghostRow?.querySelector<HTMLElement>('[data-measure-gear]')?.offsetWidth ?? 0;
        // No usable measurement yet (e.g. jsdom / first paint): show everything.
        if (containerWidth <= 0 || gearW <= 0 || widths.some((w) => w <= 0) || candidates.some((key) => (fullWidths.get(key) ?? 0) <= 0)) {
            setLayout({ visibleCount: candidates.length, expandedWidths: {} });
            return;
        }
        const fits = (candidateCount: number) => {
            const itemWidths = [...widths.slice(0, candidateCount), gearW];
            let rows = 1;
            let rowWidth = 0;
            for (const width of itemWidths) {
                const nextWidth = rowWidth === 0 ? width : rowWidth + GAP + width;
                if (rowWidth > 0 && nextWidth > containerWidth) {
                    rows += 1;
                    rowWidth = width;
                } else {
                    rowWidth = nextWidth;
                }
            }
            return rows <= (twoLine ? 2 : 1);
        };

        let count = 0;
        for (let i = 1; i <= widths.length; i += 1) {
            if (!fits(i)) break;
            count = i;
        }

        type RowItem = { key: CandidateKey | null; width: number };
        const rows: Array<{ items: RowItem[]; used: number }> = [];
        const items: RowItem[] = [
            ...candidates.slice(0, count).map((key) => ({ key, width: compactWidths.get(key) ?? 0 })),
            { key: null, width: gearW },
        ];
        for (const item of items) {
            let row = rows[rows.length - 1];
            const nextWidth = row ? row.used + GAP + item.width : item.width;
            if (row && nextWidth > containerWidth) {
                row = { items: [], used: 0 };
                rows.push(row);
            } else if (!row) {
                row = { items: [], used: 0 };
                rows.push(row);
            }
            row.used = row.items.length === 0 ? item.width : row.used + GAP + item.width;
            row.items.push(item);
        }

        const expandedWidths: Partial<Record<CandidateKey, number>> = {};
        for (const row of rows) {
            let remainingSlack = Math.max(0, Math.floor(containerWidth - row.used - 1));
            let expandable = row.items.flatMap((item) => {
                if (!item.key) return [];
                const fullWidth = fullWidths.get(item.key) ?? item.width;
                const needed = fullWidth - item.width;
                return needed > 0 ? [{ key: item.key, compactWidth: item.width, needed }] : [];
            });
            const increments = new Map<CandidateKey, number>();

            while (remainingSlack > 0 && expandable.length > 0) {
                const share = remainingSlack / expandable.length;
                const saturated = expandable.filter((item) => item.needed <= share);
                if (saturated.length === 0) {
                    for (const item of expandable) increments.set(item.key, share);
                    remainingSlack = 0;
                    break;
                }
                for (const item of saturated) {
                    increments.set(item.key, item.needed);
                    remainingSlack -= item.needed;
                }
                const saturatedKeys = new Set(saturated.map((item) => item.key));
                expandable = expandable.filter((item) => !saturatedKeys.has(item.key));
            }

            for (const item of row.items) {
                if (!item.key) continue;
                const increment = increments.get(item.key) ?? 0;
                if (increment > 0) {
                    expandedWidths[item.key] = Math.min(
                        fullWidths.get(item.key) ?? item.width,
                        item.width + increment,
                    );
                }
            }
        }

        setLayout({ visibleCount: count, expandedWidths });
    }, [candidates, containerWidth, foldedRemainingCount, danceSel.compactLabel, danceSel.fullLabel, areaLabel, startDate, endDate, peopleTypeLabel, peopleStatusLabel, reachFilter, twoLine]);

    const hiddenActivePrimaries = Math.max(0, candidates.length - layout.visibleCount);
    const extraCount = foldedRemainingCount + hiddenActivePrimaries;

    // ---- Pill builders -------------------------------------------------
    const buildPill = (key: CandidateKey, measuring = false, variant: PillVariant = 'compact', maxWidth?: number): React.ReactNode => {
        const tid = (id: string) => (measuring ? undefined : id);
        const measurementProps = measuring ? { measureKey: key, measureVariant: variant } : {};
        const pillKey = measuring ? `${key}-${variant}` : key;
        switch (key) {
            case 'period':
                return (
                    <Pill
                        key={pillKey}
                        icon={<img src="/calendar.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label={formatPeriodLabel(startDate, endDate)}
                        onClick={onEditPeriod}
                        testId={tid('summary-chip-period')}
                        maxWidth={maxWidth}
                        {...measurementProps}
                    />
                );
            case 'area':
                return (
                    <Pill
                        key={pillKey}
                        icon={<img src="/pin.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label={areaLabel}
                        maxWidth={maxWidth}
                        labelMaxWidth={variant === 'compact' ? AREA_COMPACT_LABEL_MAX_WIDTH : undefined}
                        onClick={onEditArea}
                        onRemove={!areaIsDefault ? onClearArea : undefined}
                        removeAriaLabel="Clear area filter"
                        testId={tid('summary-chip-area')}
                        {...measurementProps}
                    />
                );
            case 'dance':
                return (
                    <Pill
                        key={pillKey}
                        icon={<img src="/dance.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label={variant === 'full' ? danceSel.fullLabel : danceSel.compactLabel}
                        title={`Dance styles: ${danceSel.fullLabel}`}
                        onClick={onEditDance}
                        testId={tid('summary-chip-dance')}
                        maxWidth={maxWidth}
                        {...measurementProps}
                    />
                );
            case 'reach': {
                // Truncate long labels to 3 chars but keep short words (e.g.
                // "Any", "local") intact.
                const full = REACH_FILTER_LABELS[reachFilter];
                const short = full.length <= 5 ? full : full.slice(0, 3);
                return (
                    <Pill
                        key={pillKey}
                        icon={<img src="/scale.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label={variant === 'full' ? full : short}
                        ariaLabel={`Event reach: ${full}`}
                        title={`Event reach: ${full}`}
                        onClick={onEditReach}
                        testId={tid('summary-chip-reach')}
                        maxWidth={maxWidth}
                        {...measurementProps}
                    />
                );
            }
            case 'people': {
                const hasFaces = interestUserHandles.length > 0 && (interestUserPeople?.length ?? 0) > 0;
                // Consolidated, shortened chip. The default "Following" source is
                // implied, so it collapses to just the status ("Going" /
                // "Interested"); "Both" drops the status entirely.
                const n = interestUserHandles.length;
                const who = n > 0
                    ? `${n} ${n === 1 ? 'person' : 'people'}`
                    : interestSource === 'friends' ? 'Friends' : 'Following';
                const status = interestKind === 'going' ? 'Going' : interestKind === 'saved' ? 'Interested' : '';
                const followingImplied = n === 0 && interestSource !== 'friends';
                const combinedLabel = followingImplied
                    ? (status || 'Following')
                    : status ? `${who} ${status.toLowerCase()}` : who;
                return (
                    <Pill
                        key={pillKey}
                        icon={hasFaces
                            ? <PeopleAvatarTrack people={interestUserPeople!} total={interestUserHandles.length} max={3} size="sm" />
                            : <img src="/high-five.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label={combinedLabel}
                        ariaLabel="People"
                        title={`People: ${combinedLabel}`}
                        onClick={onEditPeople}
                        testId={tid('summary-chip-people')}
                        maxWidth={maxWidth}
                        {...measurementProps}
                    />
                );
            }
            case 'discount':
                return (
                    <Pill
                        key={pillKey}
                        icon={<img src="/promo-code.png" alt="" aria-hidden="true" className={ICON_CLS} />}
                        label="Discount"
                        title="Has discount"
                        onClick={onEditDiscount}
                        testId={tid('summary-chip-discount')}
                        maxWidth={maxWidth}
                        {...measurementProps}
                    />
                );
        }
    };

    const gearIcon = (
        <img src="/filter.png" alt="" aria-hidden="true" className="h-4 w-4 shrink-0 object-contain" />
    );
    const buildGear = (count: number, measuring?: boolean): React.ReactNode => (
        <Pill
            label={count > 0 ? `+${count}` : undefined}
            icon={gearIcon}
            onClick={onOpenFilters}
            ariaLabel={count > 0 ? `${count} more filters` : 'Filters'}
            title="Filters"
            testId={measuring ? undefined : 'summary-open-filters'}
            measureGear={measuring}
        />
    );

    const handleBarClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!onOpenFilters || isInteractiveTarget(event.target)) return;
        onOpenFilters();
    };

    const visibleKeys = candidates.slice(0, layout.visibleCount);

    return (
        <div
            ref={containerRef}
            className={`summary-bar relative w-full overflow-hidden border-y-2 border-blue-100 bg-blue-50 px-3 py-3 shadow-md ${onOpenFilters ? 'cursor-pointer' : ''} ${className}`}
            data-testid="summary-bar"
            data-variant={twoLine ? 'two-line' : 'single'}
            aria-label="Active filters"
            onClick={handleBarClick}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div className={`flex items-center gap-1.5 min-w-0 flex-1 ${twoLine ? 'flex-wrap' : ''}`}>
                    {visibleKeys.map((key) => {
                        const expandedWidth = layout.expandedWidths[key];
                        return buildPill(key, false, expandedWidth === undefined ? 'compact' : 'full', expandedWidth);
                    })}
                    {buildGear(extraCount)}
                </div>
            </div>

            {/* Hidden measurement layer: full-width copies of every candidate
                pill + the widest gear pill, used to compute the collapse. */}
            <div
                ref={ghostRowRef}
                aria-hidden="true"
                className="pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1.5 opacity-0"
            >
                {candidates.flatMap((key) => [
                    buildPill(key, true, 'compact'),
                    buildPill(key, true, 'full'),
                ])}
                {buildGear(foldedRemainingCount + candidates.length, true)}
            </div>
        </div>
    );
}
