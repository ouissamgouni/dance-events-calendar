import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TagGroup } from '../types';
import { REACH_FILTER_ICON_SRC, REACH_FILTER_LABELS, type ReachFilter } from '../utils/reach';
import PeopleAvatarTrack, { type PersonMini } from './PeopleAvatarTrack';

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
        return start.getTime() === today.getTime() ? 'All upcoming' : `From ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    if (!start || !end) return `${startDate}-${endDate}`;
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
        reachFilter,
        onEditReach,
        interestSource,
        interestKind,
        interestUserHandles,
        interestUserPeople,
        onEditPeople,
        onOpenFilters,
    } = props;

    const danceSel = useMemo(() => {
        if (!danceGroup) return { label: '', count: 0 };
        const selected = danceGroup.tags.filter((t) => activeTagIds.has(t.id));
        if (selected.length === 0) return { label: '', count: 0 };
        const first = selected[0].label;
        return { label: selected.length > 1 ? `${first} +${selected.length - 1}` : first, count: selected.length };
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
        if (danceGroup && danceSel.count > 0) list.push('dance');
        if (reachGroup) list.push('reach');
        return list;
    }, [danceGroup, danceSel.count, reachGroup, peopleActive, onEditPeople]);

    // ---- Measurement-based collapse -----------------------------------
    const containerRef = useRef<HTMLDivElement>(null);
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
        // No usable measurement yet (e.g. jsdom / first paint): show everything.
        if (containerWidth <= 0 || gearW <= 0 || widths.some((w) => w <= 0)) {
            setVisibleCount(candidates.length);
            return;
        }
        // Reserve the always-present Filters pill before fitting candidates.
        let avail = containerWidth - gearW - GAP;
        let count = 0;
        for (let i = 0; i < widths.length; i += 1) {
            const next = widths[i] + GAP;
            if (avail - next < 0) break;
            avail -= next;
            count += 1;
        }
        setVisibleCount(count);
    }, [candidates, containerWidth, foldedRemainingCount, danceSel.label, areaLabel, startDate, endDate, peopleTypeLabel, peopleStatusLabel, reachFilter]);

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
                        label={formatPeriodLabel(startDate, endDate)}
                        onClick={onEditPeriod}
                        testId={tid('summary-chip-period')}
                    />
                );
            case 'area':
                return (
                    <Pill
                        key="area"
                        icon={<img src="/pin.png" alt="" aria-hidden="true" className={ICON_CLS} />}
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
                        icon={<img src={REACH_FILTER_ICON_SRC[reachFilter]} alt="" className={ICON_CLS} aria-hidden="true" />}
                        ariaLabel={`Event reach: ${REACH_FILTER_LABELS[reachFilter]}`}
                        title={`Event reach: ${REACH_FILTER_LABELS[reachFilter]}`}
                        onClick={onEditReach}
                        testId={tid('summary-chip-reach')}
                    />
                );
            case 'people': {
                const hasFaces = interestUserHandles.length > 0 && (interestUserPeople?.length ?? 0) > 0;
                // Consolidated chip: {WHO} · {STATUS} (e.g., "Following · Going")
                const n = interestUserHandles.length;
                let whoLabel = '';
                if (n > 0) {
                    whoLabel = `${n} ${n === 1 ? 'person' : 'people'}`;
                } else {
                    whoLabel = interestSource === 'friends' ? 'Friends' : 'Following';
                }
                const combinedLabel = `${whoLabel} · ${peopleStatusLabel}`;
                return (
                    <Pill
                        key="people"
                        icon={hasFaces
                            ? <PeopleAvatarTrack people={interestUserPeople!} total={interestUserHandles.length} max={3} size="sm" />
                            : undefined}
                        label={combinedLabel}
                        ariaLabel="People"
                        title={`People: ${combinedLabel}`}
                        onClick={onEditPeople}
                        testId={tid('summary-chip-people')}
                    />
                );
            }
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
            data-variant="single"
            aria-label="Active filters"
            onClick={handleBarClick}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    {visibleKeys.map((k) => buildPill(k))}
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
                {candidates.map((k) => buildPill(k, true))}
                {buildGear(foldedRemainingCount + candidates.length, true)}
            </div>
        </div>
    );
}
