import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagGroup } from '../types';

// SummaryBar — single-line filter summary with deterministic, width-based
// priority collapse. Fixed semantic priority (left→right):
//   Date → Area → Dance → Reach → People → Remaining (+X ⚙)
// As available width shrinks, pills hide RIGHT-TO-LEFT by priority and every
// hidden/never-shown active filter group folds into a single "+X ⚙" control
// that opens the main Filters sheet. The bar never wraps or horizontally
// scrolls. Pills are visually quiet: neutral background, light border, dark
// text, no active-blue fills — the bar communicates search state without
// competing with the results.

export type InterestSource = 'follows' | 'friends' | null;
export type InterestKind = 'any' | 'going' | 'saved';
export type InterestMatch = 'any' | 'all';

export interface SummaryBarProps {
    className?: string;

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

    // Dance pill (text, "Salsa +2") and Reach pill (icon-only). Pass the
    // resolved groups so the bar can render + deep-link into their editors.
    danceGroup?: TagGroup | null;
    onEditDance?: () => void;
    reachGroup?: TagGroup | null;
    onEditReach?: () => void;

    // People pill (people icon + count of explicitly-selected handles).
    interestSource: InterestSource;
    interestKind: InterestKind;
    interestUserHandles: string[];
    interestMatch: InterestMatch;
    onEditPeople?: () => void;

    // Remaining-filters control. Always rendered as "+X ⚙" (or just "⚙" when
    // nothing extra is active) so the full filter sheet is always reachable.
    onOpenFilters?: () => void;

    // View controls (Map/Calendar icons) rendered on the right after a subtle
    // divider. Their width is reserved BEFORE fitting pills, so they never
    // disappear as more filters become active. Used by sticky Explore.
    rightSlot?: React.ReactNode;

    // Experiment variant: render chips over up to two wrapping lines, always
    // icon-prefixed, with rightSlot pinned to the right. Overflow past two
    // lines folds into the "+X ⚙" gear (never exceeds two lines).
    twoLine?: boolean;
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
    if (!start || !end) return `${startDate}-${endDate}`;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sameYear = start.getFullYear() === end.getFullYear();
    const currentYear = today.getFullYear();
    const fmt = (d: Date, withYear: boolean) =>
        d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            ...(withYear ? { year: 'numeric' } : {}),
        });
    const startLabel = start.getTime() === today.getTime()
        ? 'Today'
        : fmt(start, !sameYear);
    return `${startLabel}–${fmt(end, end.getFullYear() !== currentYear || !sameYear)}`;
}

// Shared pill chrome. Neutral only — no accent/blue tone. Rounded ~10px to
// match the design reference (this bar intentionally deviates from the
// square-control convention; it is a distinct, quiet search-state surface).
const PILL_BASE =
    'inline-flex items-center gap-1 h-7 px-2.5 rounded-[10px] border border-line bg-surface text-ink text-xs font-medium whitespace-nowrap';
const PILL_INTERACTIVE = 'cursor-pointer hover:bg-canvas transition';

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
}

function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest('button, a, input, select, textarea, [role="button"]') !== null;
}

function Pill({ label, title, icon, onClick, onRemove, removeAriaLabel, testId, ariaLabel, className }: PillProps) {
    const padding = onRemove ? 'pl-2.5 pr-1' : '';
    return (
        <span
            className={`${PILL_BASE} ${padding} ${onClick ? PILL_INTERACTIVE : ''} ${className ?? ''}`.trim()}
            title={title ?? label}
            aria-label={ariaLabel}
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
            {icon}
            {label !== undefined && <span className="truncate">{label}</span>}
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

// Text chips (period/area/dance) are iconless to save width; only reach and
// people carry an icon since the icon *is* their identifier (reach is icon-only,
// people shows an optional count that would be meaningless on its own).
const peopleIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="2.4" />
        <path d="M2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
        <path d="M13 6.2a2.2 2.2 0 0 1 0 4.2M14 12.4c2 .4 3.5 1.8 3.5 3.6" />
    </svg>
);
// Reach line icons — Local (pin) / Regional (concentric) / International (globe).
const reachLocalIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 18s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" />
        <circle cx="10" cy="8" r="2" />
    </svg>
);
const reachRegionalIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="7" />
        <circle cx="10" cy="10" r="3.4" />
        <circle cx="10" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </svg>
);
const reachInternationalIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="7.2" />
        <path d="M2.8 10h14.4M10 2.8c2 2 3 4.6 3 7.2s-1 5.2-3 7.2c-2-2-3-4.6-3-7.2s1-5.2 3-7.2z" />
    </svg>
);

// Icons used only by the two-line variant, where every chip is prefixed.
const periodIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="14" height="13" rx="2" />
        <path d="M3 8h14M7 2.5v3M13 2.5v3" />
    </svg>
);
const areaIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 18s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z" />
        <circle cx="10" cy="8" r="2" />
    </svg>
);
const danceIcon = (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={ICON_CLS} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 15.5V5.5l8-2v9" />
        <circle cx="5" cy="15.5" r="2" />
        <circle cx="13" cy="12.5" r="2" />
    </svg>
);

function reachIconFor(group: TagGroup, activeTagIds: Set<number>): React.ReactNode {
    // Pick the narrowest (most specific) selected tag: Local < Regional < International.
    const selected = group.tags.filter((t) => activeTagIds.has(t.id));
    if (selected.length === 0) return reachInternationalIcon;
    const rank = (label: string) => {
        const l = label.toLowerCase();
        if (l.includes('local')) return 1;
        if (l.includes('regional')) return 2;
        if (l.includes('international')) return 3;
        return 4;
    };
    const top = selected.reduce((best, t) => (rank(t.label) < rank(best.label) ? t : best), selected[0]);
    const l = top.label.toLowerCase();
    if (l.includes('local')) return reachLocalIcon;
    if (l.includes('regional')) return reachRegionalIcon;
    return reachInternationalIcon;
}

type CandidateKey = 'period' | 'area' | 'dance' | 'reach' | 'people';

export default function SummaryBar(props: SummaryBarProps) {
    const {
        className = '',
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
        onEditReach,
        interestSource,
        interestKind,
        interestUserHandles,
        onEditPeople,
        onOpenFilters,
        rightSlot,
        twoLine = false,
    } = props;

    const danceSel = useMemo(() => {
        if (!danceGroup) return { label: '', count: 0 };
        const selected = danceGroup.tags.filter((t) => activeTagIds.has(t.id));
        if (selected.length === 0) return { label: '', count: 0 };
        const first = selected[0].label;
        return { label: selected.length > 1 ? `${first} +${selected.length - 1}` : first, count: selected.length };
    }, [danceGroup, activeTagIds]);

    const reachActive = useMemo(
        () => !!reachGroup && reachGroup.tags.some((t) => activeTagIds.has(t.id)),
        [reachGroup, activeTagIds],
    );

    const reachSelCount = useMemo(
        () => (reachGroup ? reachGroup.tags.filter((t) => activeTagIds.has(t.id)).length : 0),
        [reachGroup, activeTagIds],
    );

    // Opt-in: a status-only selection (kind alone) never surfaces a chip.
    const peopleActive = interestSource !== null || interestUserHandles.length > 0;
    // WHO · STATUS label, or '' when nothing is applied.
    const peopleLabel = useMemo(() => {
        if (!peopleActive) return '';
        const status = interestKind === 'going' ? 'Going' : interestKind === 'saved' ? 'Interested' : 'Both';
        const n = interestUserHandles.length;
        const who = n > 0
            ? `${n} ${n === 1 ? 'person' : 'people'}`
            : interestSource === 'friends'
                ? 'Friends'
                : 'Following';
        return `${who} · ${status}`;
    }, [peopleActive, interestSource, interestKind, interestUserHandles]);

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

    // Ordered active candidate pills. Date + Area are always present; Dance /
    // Reach / People only when they carry a selection.
    const candidates = useMemo(() => {
        const list: CandidateKey[] = ['period', 'area'];
        if (danceGroup && danceSel.count > 0) list.push('dance');
        if (reachActive) list.push('reach');
        if (peopleActive && onEditPeople) list.push('people');
        return list;
    }, [danceGroup, danceSel.count, reachActive, peopleActive, onEditPeople]);

    // ---- Measurement-based collapse -----------------------------------
    const containerRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    const ghostRowRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [visibleCount, setVisibleCount] = useState(candidates.length);

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
        // Ghost row children are the candidate pills in priority order followed
        // by the widest gear pill last.
        const ghostChildren = ghostRowRef.current ? Array.from(ghostRowRef.current.children) : [];
        const widths = candidates.map((_, i) => (ghostChildren[i] as HTMLElement | undefined)?.offsetWidth ?? 0);
        const gearW = (ghostChildren[candidates.length] as HTMLElement | undefined)?.offsetWidth ?? 0;
        const rightW = rightRef.current?.offsetWidth ?? 0;
        // No usable measurement yet (e.g. jsdom / first paint): show everything.
        if (containerWidth <= 0 || gearW <= 0 || widths.some((w) => w <= 0)) {
            setVisibleCount(candidates.length);
            return;
        }
        let count: number;
        if (twoLine) {
            // Wrap chips over up to two rows; the gear (worst-case width) must
            // fit after the last visible chip. Drop chips from the right until
            // the whole sequence packs into two rows.
            const rowWidth = containerWidth - (rightW > 0 ? rightW + GAP : 0);
            const rowsNeeded = (items: number[]): number => {
                let rows = 1;
                let used = 0;
                for (const w of items) {
                    if (used === 0) used = w;
                    else if (used + GAP + w <= rowWidth) used += GAP + w;
                    else { rows += 1; used = w; }
                }
                return rows;
            };
            count = candidates.length;
            while (count > 0 && rowsNeeded([...widths.slice(0, count), gearW]) > 2) {
                count -= 1;
            }
        } else {
            // Reserve the always-present gear pill + the right view controls first.
            let avail = containerWidth - gearW - GAP - (rightW > 0 ? rightW + GAP : 0);
            count = 0;
            for (let i = 0; i < widths.length; i += 1) {
                const next = widths[i] + GAP;
                if (avail - next < 0) break;
                avail -= next;
                count += 1;
            }
        }
        setVisibleCount(count);
    }, [candidates, containerWidth, foldedRemainingCount, danceSel.label, areaLabel, startDate, endDate, peopleLabel, reachSelCount, rightSlot, twoLine]);

    const hiddenActivePrimaries = Math.max(0, candidates.length - visibleCount);
    const extraCount = foldedRemainingCount + hiddenActivePrimaries;

    // ---- Pill builders -------------------------------------------------
    const buildPill = (key: CandidateKey, measuring?: boolean): React.ReactNode => {
        const tid = (id: string) => (measuring ? undefined : id);
        switch (key) {
            case 'period':
                return (
                    <Pill
                        key="period"
                        icon={twoLine ? periodIcon : undefined}
                        label={formatPeriodLabel(startDate, endDate)}
                        onClick={onEditPeriod}
                        testId={tid('summary-chip-period')}
                    />
                );
            case 'area':
                return (
                    <Pill
                        key="area"
                        icon={twoLine ? areaIcon : undefined}
                        label={areaLabel}
                        className="max-w-[88px] sm:max-w-none"
                        onClick={onEditArea}
                        onRemove={!areaIsDefault ? onClearArea : undefined}
                        removeAriaLabel="Clear area filter"
                        testId={tid('summary-chip-area')}
                    />
                );
            case 'dance':
                return (
                    <Pill
                        key="dance"
                        icon={twoLine ? danceIcon : undefined}
                        label={danceSel.label}
                        title={`Dance styles: ${danceSel.label}`}
                        onClick={onEditDance}
                        testId={tid('summary-chip-dance')}
                    />
                );
            case 'reach':
                return (
                    <Pill
                        key="reach"
                        icon={reachGroup ? reachIconFor(reachGroup, activeTagIds) : reachInternationalIcon}
                        label={reachSelCount > 1 ? `+${reachSelCount - 1}` : undefined}
                        ariaLabel="Reach"
                        title="Reach"
                        onClick={onEditReach}
                        testId={tid('summary-chip-reach')}
                    />
                );
            case 'people':
                return (
                    <Pill
                        key="people"
                        icon={peopleIcon}
                        label={peopleLabel || undefined}
                        ariaLabel="People"
                        title="People"
                        onClick={onEditPeople}
                        testId={tid('summary-chip-people')}
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
        />
    );

    const handleBarClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!onOpenFilters || isInteractiveTarget(event.target)) return;
        onOpenFilters();
    };

    const visibleKeys = candidates.slice(0, visibleCount);

    return (
        <div
            ref={containerRef}
            className={`summary-bar relative w-full bg-surface border-y border-line px-2 py-2 overflow-hidden ${onOpenFilters ? 'cursor-pointer' : ''} ${className}`}
            data-testid="summary-bar"
            data-variant={twoLine ? 'two-line' : 'single'}
            aria-label="Active filters"
            onClick={handleBarClick}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div className={`flex ${twoLine ? 'flex-wrap' : ''} items-center gap-1.5 min-w-0 flex-1`}>
                    {visibleKeys.map((k) => buildPill(k))}
                    {buildGear(extraCount)}
                </div>
                {rightSlot && (
                    <div ref={rightRef} className="flex items-center gap-1 shrink-0">
                        <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
                        {rightSlot}
                    </div>
                )}
            </div>

            {/* Hidden measurement layer: full-width copies of every candidate
                pill + the widest gear pill, used to compute the collapse. */}
            <div
                ref={ghostRowRef}
                aria-hidden="true"
                className="pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-1.5 opacity-0"
            >
                {candidates.map((k) => buildPill(k, true))}
                {buildGear(foldedRemainingCount + candidates.length, true)}
            </div>
        </div>
    );
}
