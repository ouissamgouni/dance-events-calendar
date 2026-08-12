/**
 * PassportView — the read-only presentational surface of a Dance Passport.
 *
 * Extracted from PassportPage so the exact same experience (summary header,
 * stat cards and the Milestones/Timeline/Cities/Countries tabs) can be reused
 * by the owner's own /passport page, a profile "Dance Passport" tab and the
 * public shared link. Callers own data fetching; this component only renders.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import EventMap from './EventMap';
import PassportActivityHeatmap from './PassportActivityHeatmap';
import type {
    PassportConsistency,
    PassportMapEvent,
    PassportMilestone,
    PassportResponse,
    PassportSection,
    PassportTimelineItem,
    PassportTimelineMarker,
} from '../types';

export type { PassportSection };

const ALL_SECTIONS: PassportSection[] = ['milestones', 'timeline', 'cities', 'countries'];

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return iso;
    }
}

// Factual, past-tense milestone copy for the timeline (badges use the catalog
// name/description instead). Icons mirror the catalog except where a plain
// label reads better. Unknown keys fall back to the marker icon + description.
const TIMELINE_MILESTONE: Record<string, { icon: string; label: string }> = {
    first_event: { icon: '💃', label: 'First dance event' },
    events_5: { icon: '🔥', label: 'Danced at 5 events' },
    events_15: { icon: '🏆', label: 'Danced at 15 events' },
    events_30: { icon: '👑', label: 'Danced at 30 events' },
    events_50: { icon: '✨', label: 'Danced at 50 events' },
    events_75: { icon: '🌟', label: 'Danced at 75 events' },
    events_100: { icon: '💎', label: 'Danced at 100 events' },
    cities_3: { icon: '🏙️', label: 'Danced in 3 cities' },
    cities_5: { icon: '🧳', label: 'Danced in 5 cities' },
    cities_10: { icon: '🗺️', label: 'Danced in 10 cities' },
    cities_20: { icon: '🚆', label: 'Danced in 20 cities' },
    cities_30: { icon: '🌆', label: 'Danced in 30 cities' },
    cities_50: { icon: '✨', label: 'Danced in 50 cities' },
    countries_3: { icon: '🛂', label: 'Danced in 3 countries' },
    countries_5: { icon: '✈️', label: 'Danced in 5 countries' },
    countries_10: { icon: '🌍', label: 'Danced in 10 countries' },
    countries_15: { icon: '🧭', label: 'Danced in 15 countries' },
    countries_25: { icon: '🌐', label: 'Danced in 25 countries' },
    countries_40: { icon: '🏆', label: 'Danced in 40 countries' },
    first_review: { icon: '✍️', label: 'Wrote your first review' },
    reviews_3: { icon: '⭐', label: 'Wrote 3 reviews' },
    reviews_10: { icon: '💬', label: 'Wrote 10 reviews' },
    reviews_25: { icon: '📝', label: 'Wrote 25 reviews' },
    reviews_50: { icon: '🏆', label: 'Wrote 50 reviews' },
};

function StatCard({
    value,
    label,
    onLabelClick,
    action,
}: {
    value: number | string;
    label: string;
    onLabelClick?: () => void;
    action?: { label: string; onClick: () => void };
}) {
    return (
        <div className="border border-slate-200 bg-white p-2 text-center">
            <div className="text-lg font-semibold text-slate-900 tabular-nums">{value}</div>
            <div className="mt-0.5 text-[11px] leading-tight text-slate-500">
                {onLabelClick ? (
                    <button
                        type="button"
                        onClick={onLabelClick}
                        className="font-medium text-blue-600 underline hover:text-blue-700"
                    >
                        {label}
                    </button>
                ) : (
                    label
                )}
            </div>
            {action && (
                <button
                    type="button"
                    onClick={action.onClick}
                    className="mt-0.5 text-[10px] font-medium text-blue-600 hover:underline"
                >
                    {action.label} →
                </button>
            )}
        </div>
    );
}

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={
                active
                    ? 'border-b-2 border-blue-500 px-4 py-2 text-sm font-semibold text-slate-900'
                    : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700'
            }
        >
            {children}
        </button>
    );
}

function SummaryHeader({
    data,
    title,
    actions,
    dancingSinceSlot,
}: {
    data: PassportResponse;
    title: string;
    actions?: ReactNode;
    dancingSinceSlot?: ReactNode;
}) {
    const { stats } = data;
    const parts = [
        `${stats.total_events_attended} ${stats.total_events_attended === 1 ? 'event' : 'events'}`,
        `${stats.cities_visited} ${stats.cities_visited === 1 ? 'city' : 'cities'}`,
        `${stats.countries_visited} ${stats.countries_visited === 1 ? 'country' : 'countries'}`,
    ];
    const cadence =
        stats.avg_gap_days == null ? null : Math.max(1, Math.round(stats.avg_gap_days));
    return (
        <header className="border border-slate-200 bg-slate-900 p-6 text-white">
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{parts.join(' · ')}</p>
            {cadence != null && (
                <p className="mt-1 font-semibold text-sm text-slate-200 tabular-nums">
                    1 event every {cadence} {cadence === 1 ? 'day' : 'days'}
                </p>
            )}
            <div className="mt-1 flex items-center justify-between gap-4">
                {dancingSinceSlot ?? (
                    <p className="text-xs text-slate-300">
                        Dancing since {formatDate(stats.dancing_since ?? stats.member_since)}
                    </p>
                )}
                {actions && <div className="flex justify-end">{actions}</div>}
            </div>
        </header>
    );
}

type FilterEntry = { key: string; label: string; count: number };

function FilterableEventMap({
    events,
    entries,
    eventKeyOf,
    emptyLabel,
}: {
    events: PassportMapEvent[];
    entries: FilterEntry[];
    eventKeyOf: (e: PassportMapEvent) => string | null;
    emptyLabel: string;
}) {
    const [selected, setSelected] = useState<string>('all');
    const total = useMemo(() => entries.reduce((sum, e) => sum + e.count, 0), [entries]);
    const [autoFitToken, setAutoFitToken] = useState(0);
    useEffect(() => {
        setAutoFitToken((n) => n + 1);
    }, [selected]);
    const filtered = useMemo(
        () => (selected === 'all' ? events : events.filter((e) => eventKeyOf(e) === selected)),
        [events, selected, eventKeyOf],
    );

    function optionClass(active: boolean): string {
        return active
            ? 'flex w-full items-center justify-between bg-slate-900 px-2 py-1.5 text-left text-sm font-medium text-white'
            : 'flex w-full items-center justify-between px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50';
    }

    return (
        <div className="grid gap-4 md:grid-cols-[minmax(0,220px)_1fr]">
            <div className="border border-slate-200 bg-white p-1">
                <ul className="max-h-[360px] space-y-0.5 overflow-y-auto">
                    <li>
                        <button
                            type="button"
                            onClick={() => setSelected('all')}
                            className={optionClass(selected === 'all')}
                        >
                            <span>All</span>
                            <span className="tabular-nums opacity-70">{total}</span>
                        </button>
                    </li>
                    {entries.map((entry) => (
                        <li key={entry.key}>
                            <button
                                type="button"
                                onClick={() => setSelected(entry.key)}
                                className={optionClass(selected === entry.key)}
                            >
                                <span className="truncate">{entry.label}</span>
                                <span className="tabular-nums opacity-70">{entry.count}</span>
                            </button>
                        </li>
                    ))}
                    {entries.length === 0 && (
                        <li className="px-2 py-1.5 text-xs text-slate-400">{emptyLabel}</li>
                    )}
                </ul>
            </div>
            <div className="h-[360px] border border-slate-200">
                <EventMap
                    events={filtered}
                    minimalPopup
                    detailLinkSource="passport"
                    autoFitToken={autoFitToken}
                    showFollowingBadgeOverlay={false}
                    showTrendingOverlay={false}
                />
            </div>
        </div>
    );
}

function cityKey(city: string, country: string | null): string {
    return `${city}|${country ?? ''}`;
}

function CitiesPanel({ data, events }: { data: PassportResponse; events: PassportMapEvent[] }) {
    const { cities } = data.collections;
    const entries: FilterEntry[] = cities.map((c) => ({
        key: cityKey(c.city, c.country),
        label: c.country ? `${c.city}, ${c.country}` : c.city,
        count: c.count,
    }));
    return (
        <FilterableEventMap
            events={events}
            entries={entries}
            eventKeyOf={(e) => (e.city ? cityKey(e.city, e.country) : null)}
            emptyLabel="No cities yet."
        />
    );
}

function CountriesPanel({ data, events }: { data: PassportResponse; events: PassportMapEvent[] }) {
    const { countries } = data.collections;
    const entries: FilterEntry[] = countries.map((c) => ({
        key: c.country,
        label: c.country,
        count: c.count,
    }));
    return (
        <FilterableEventMap
            events={events}
            entries={entries}
            eventKeyOf={(e) => e.country ?? null}
            emptyLabel="No countries yet."
        />
    );
}

function TimelineRow({ item, anchorMonth, highlighted }: { item: PassportTimelineItem; anchorMonth?: string | null; highlighted?: boolean }) {
    const place = [item.city, item.country].filter(Boolean).join(', ');
    return (
        <li className="relative pl-6" data-month-anchor={anchorMonth ?? undefined}>
            {/* eslint-disable-next-line no-restricted-syntax -- small timeline status dot */}
            <span className="absolute left-[1px] top-[6px] h-3 w-3 rounded-full bg-slate-300 ring-2 ring-white" aria-hidden />
            <Link
                to={`/event/${item.event_id}`}
                className={`group block py-1 hover:bg-slate-50 ${highlighted ? 'bg-blue-50 ring-2 ring-blue-400' : ''}`}
            >
                <div className="text-sm font-semibold text-slate-900 group-hover:text-blue-600">
                    {item.title}
                </div>
                <div className="text-xs text-slate-500">
                    {formatDate(item.start)}
                    {place ? ` · ${place}` : item.location ? ` · ${item.location}` : ''}
                </div>
            </Link>
        </li>
    );
}

function TimelineMarkerRow({ markers }: { markers: PassportTimelineMarker[] }) {
    const single = markers.length === 1 ? markers[0] : null;
    return (
        <li className="relative pl-9">
            <span className="absolute left-4 top-0 text-xs leading-5" aria-hidden>
                🏅
            </span>
            {single ? (
                <div className="max-w-[420px] text-xs leading-5 text-slate-600">
                    <span className="font-semibold text-slate-700">{single.name}</span>
                    {(single.label ?? TIMELINE_MILESTONE[single.key]?.label) && (
                        <> · {single.label ?? TIMELINE_MILESTONE[single.key]?.label}</>
                    )}
                </div>
            ) : (
                <div className="max-w-[420px] text-xs leading-5 text-slate-600">
                    <div className="font-medium text-slate-700">
                        {markers.length} milestones unlocked
                    </div>
                    <ul className="mt-0.5 space-y-0.5 pl-4">
                        {markers.map((m) => {
                            const copy = TIMELINE_MILESTONE[m.key];
                            const icon = copy?.icon ?? m.icon;
                            const label = m.label ?? copy?.label;
                            return (
                                <li key={m.key}>
                                    <span aria-hidden>{icon}</span>{' '}
                                    <span className="font-semibold text-slate-700">{m.name}</span>
                                    {label && <> · {label}</>}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </li>
    );
}

function MilestoneBadge({ milestone }: { milestone: PassportMilestone }) {
    const { unlocked, progress, threshold } = milestone;
    const remaining = Math.max(0, threshold - progress);
    return (
        <div
            className={
                unlocked
                    ? 'flex h-full flex-col border border-amber-300 bg-amber-50 p-2 text-center'
                    : 'flex h-full flex-col border border-slate-200 bg-white p-2 text-center'
            }
            title={milestone.description}
        >
            <div className={unlocked ? 'text-xl' : 'text-xl opacity-30 grayscale'}>
                {milestone.icon}
            </div>
            <div
                className={
                    unlocked
                        ? 'mt-1 text-xs font-semibold text-slate-900'
                        : 'mt-1 text-xs font-medium text-slate-400'
                }
            >
                {milestone.name}
            </div>
            {unlocked ? (
                <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
                    {milestone.achieved_description}
                </div>
            ) : (
                <>
                    <div className="mt-0.5 text-[10px] leading-tight text-slate-400">
                        {milestone.description}
                    </div>
                    <div className="mt-1 text-[10px] font-semibold tabular-nums text-slate-500">
                        {remaining} more to unlock
                    </div>
                </>
            )}
        </div>
    );
}

// Category rows, in display order. Unknown categories fall back to a title-cased
// label and are appended after these.
const MILESTONE_CATEGORY_ORDER = [
    'events',
    'cities',
    'countries',
    'reviews',
] as const;

const MILESTONE_CATEGORY_LABEL: Record<string, string> = {
    events: 'Events',
    cities: 'Cities',
    countries: 'Countries',
    reviews: 'Reviews',
};

// Each category is a single horizontally-scrollable row: achieved badges come
// first (catalog order is threshold-ascending), then the next goals. Cards are
// sized so ~4 fit on mobile and ~6 on desktop before the row scrolls.
function MilestoneCategoryRow({
    label,
    milestones,
}: {
    label: string;
    milestones: PassportMilestone[];
}) {
    const unlockedCount = milestones.filter((m) => m.unlocked).length;
    return (
        <div>
            <div className="mb-1.5 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {label}
                </h3>
                <span className="text-[11px] tabular-nums text-slate-400">
                    {unlockedCount}/{milestones.length}
                </span>
            </div>
            <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
                {milestones.map((m) => (
                    <div
                        key={m.key}
                        className="shrink-0 basis-[calc(25%_-_0.375rem)] snap-start md:basis-[calc(16.666%_-_0.417rem)]"
                    >
                        <MilestoneBadge milestone={m} />
                    </div>
                ))}
            </div>
        </div>
    );
}

// Consistency is rendered as the second trail (right after Events), so it lives
// inside the milestone grid rather than as a standalone panel.
function MilestonesGrid({
    milestones,
    consistency,
}: {
    milestones: PassportMilestone[];
    consistency?: PassportConsistency | null;
}) {
    const consistencyRow = consistency ? (
        <ConsistencyTrailRow consistency={consistency} />
    ) : null;
    if (milestones.length === 0) {
        return (
            <div className="space-y-4">
                {consistencyRow}
                <div className="border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                    No milestones yet.
                </div>
            </div>
        );
    }
    const byCategory = new Map<string, PassportMilestone[]>();
    for (const m of milestones) {
        const arr = byCategory.get(m.category);
        if (arr) arr.push(m);
        else byCategory.set(m.category, [m]);
    }
    const orderedCats = [
        ...MILESTONE_CATEGORY_ORDER.filter((c) => byCategory.has(c)),
        ...[...byCategory.keys()].filter(
            (c) => !MILESTONE_CATEGORY_ORDER.includes(c as (typeof MILESTONE_CATEGORY_ORDER)[number]),
        ),
    ];
    const unlockedCount = milestones.filter((m) => m.unlocked).length;
    return (
        <>
            <div className="mb-2 text-xs tabular-nums text-slate-400">
                {unlockedCount}/{milestones.length} unlocked
            </div>
            <div className="space-y-4">
                {orderedCats.map((cat, idx) => (
                    <Fragment key={cat}>
                        <MilestoneCategoryRow
                            label={MILESTONE_CATEGORY_LABEL[cat] ?? cat}
                            milestones={byCategory.get(cat) ?? []}
                        />
                        {idx === 0 && consistencyRow}
                    </Fragment>
                ))}
            </div>
        </>
    );
}

function formatPeriodRange(startYm: string, endYm: string): string {
    const [sy, sm] = startYm.split('-').map((n) => Number(n));
    const [ey, em] = endYm.split('-').map((n) => Number(n));
    if (!sy || !sm || !ey || !em) return `${startYm}–${endYm}`;
    const mon = (y: number, m: number) =>
        new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    if (sy === ey && sm === em) return `${mon(sy, sm)} ${sy}`;
    if (sy === ey) return `${mon(sy, sm)}–${mon(ey, em)} ${ey}`;
    return `${mon(sy, sm)} ${sy}–${mon(ey, em)} ${ey}`;
}

// Recurring "Consistency" achievements: sustained activity over a rolling 12
// calendar months (no consecutive-month requirement). Rendered as a chronological
// trail — every upward reach is a permanent card (repeats are never collapsed),
// historical periods first, then the current period's earned cards, then the
// remaining locked/progress levels.
interface ConsistencyCardModel {
    key: string;
    icon: string;
    name: string;
    earned: boolean;
    // Earned: "{threshold}/{window} active months". Locked: the goal description.
    activeLine: string;
    // Earned only: the period range.
    period?: string;
    // Locked only: count still needed to unlock.
    remaining?: number;
}

function ConsistencyCard({ card }: { card: ConsistencyCardModel }) {
    return (
        <div
            className={
                card.earned
                    ? 'flex h-full flex-col border border-amber-300 bg-amber-50 p-2 text-center'
                    : 'flex h-full flex-col border border-slate-200 bg-white p-2 text-center'
            }
        >
            <div className={card.earned ? 'text-xl' : 'text-xl opacity-30 grayscale'}>
                {card.icon}
            </div>
            <div
                className={
                    card.earned
                        ? 'mt-1 text-xs font-semibold text-slate-900'
                        : 'mt-1 text-xs font-medium text-slate-400'
                }
            >
                {card.name}
            </div>
            <div
                className={
                    card.earned
                        ? 'mt-0.5 text-[10px] leading-tight tabular-nums text-slate-500'
                        : 'mt-0.5 text-[10px] leading-tight text-slate-400'
                }
            >
                {card.activeLine}
            </div>
            {card.earned
                ? card.period && (
                    <div className="mt-0.5 text-[10px] leading-tight text-slate-400">
                        {card.period}
                    </div>
                )
                : card.remaining != null && (
                    <div className="mt-1 text-[10px] font-semibold tabular-nums text-slate-500">
                        {card.remaining} more to unlock
                    </div>
                )}
        </div>
    );
}

function ConsistencyTrailRow({ consistency }: { consistency: PassportConsistency }) {
    const cards: ConsistencyCardModel[] = [
        ...consistency.earned.map((c) => ({
            key: c.key,
            icon: c.icon,
            name: c.name,
            earned: true,
            activeLine: `${c.threshold}/${consistency.window} active months`,
            period: formatPeriodRange(c.period_start, c.reached),
        })),
        ...consistency.locked.map((c) => ({
            key: c.key,
            icon: c.icon,
            name: c.name,
            earned: false,
            activeLine: `Be active in ${c.threshold} of ${consistency.window} months`,
            remaining: Math.max(0, c.threshold - c.active_months),
        })),
    ];
    if (cards.length === 0) return null;
    return (
        <div>
            <div className="mb-1.5 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Consistency
                </h3>
                <span className="text-[11px] tabular-nums text-slate-400">
                    Current · {consistency.active_months}/{consistency.window} active months
                </span>
            </div>
            <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
                {cards.map((c) => (
                    <div
                        key={c.key}
                        className="shrink-0 basis-[calc(25%_-_0.375rem)] snap-start md:basis-[calc(16.666%_-_0.417rem)]"
                    >
                        <ConsistencyCard card={c} />
                    </div>
                ))}
            </div>
        </div>
    );
}

const SECTION_LABELS: Record<PassportSection, string> = {
    milestones: 'Milestones',
    timeline: 'Timeline',
    cities: 'Cities',
    countries: 'Countries',
};

export interface PassportViewProps {
    data: PassportResponse;
    title?: string;
    /** Which tabs to render, in order. Defaults to all four. */
    sections?: PassportSection[];
    /** Owner-only controls rendered under the summary header (e.g. share button). */
    headerActions?: ReactNode;
    /** Owner-only replacement for the "Dancing since" line (editable date + first-event). */
    dancingSinceSlot?: ReactNode;
    /** Owner-only controls rendered at the top of the Timeline tab (e.g. add past event). */
    timelineActions?: ReactNode;
    // Timeline data (only used when 'timeline' is in sections).
    timelineItems?: PassportTimelineItem[];
    timelineMarkers?: PassportTimelineMarker[];
    timelineHasMore?: boolean;
    onLoadMoreTimeline?: () => void;
    loadingMoreTimeline?: boolean;
    // Map data (only used when 'cities'/'countries' are in sections). When
    // mapEvents is null and onNeedMapEvents is provided, the view requests a
    // lazy load on first opening a map tab.
    mapEvents?: PassportMapEvent[] | null;
    onNeedMapEvents?: () => void;
}

export default function PassportView({
    data,
    title = 'Your Dance Passport',
    sections = ALL_SECTIONS,
    headerActions,
    dancingSinceSlot,
    timelineActions,
    timelineItems = [],
    timelineMarkers = [],
    timelineHasMore = false,
    onLoadMoreTimeline,
    loadingMoreTimeline = false,
    mapEvents = null,
    onNeedMapEvents,
}: PassportViewProps) {
    const shown = ALL_SECTIONS.filter((s) => sections.includes(s));
    const [tab, setTab] = useState<PassportSection>(shown[0] ?? 'milestones');
    const tabsRef = useRef<HTMLDivElement>(null);
    const has = (s: PassportSection) => shown.includes(s);

    const selectTab = useCallback((next: PassportSection) => {
        setTab(next);
        requestAnimationFrame(() => {
            tabsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        });
    }, []);

    // Ask the caller to load map events the first time a map tab is opened.
    useEffect(() => {
        if (tab !== 'cities' && tab !== 'countries') return;
        if (mapEvents !== null) return;
        onNeedMapEvents?.();
    }, [tab, mapEvents, onNeedMapEvents]);

    type Row =
        | { kind: 'event'; date: number; item: PassportTimelineItem }
        | { kind: 'marker'; date: number; markers: PassportTimelineMarker[] };
    const timelineRows = useMemo<Row[]>(() => {
        const eventRows: Row[] = timelineItems.map((item) => ({
            kind: 'event',
            date: new Date(item.start).getTime(),
            item,
        }));
        const oldestLoaded =
            timelineHasMore && eventRows.length > 0
                ? eventRows[eventRows.length - 1].date
                : -Infinity;
        // Group markers unlocked at the same time (same triggering event) into one row.
        const byTime = new Map<number, PassportTimelineMarker[]>();
        for (const m of timelineMarkers) {
            const raw = new Date(m.date).getTime();
            if (raw < oldestLoaded) continue;
            const list = byTime.get(raw);
            if (list) list.push(m);
            else byTime.set(raw, [m]);
        }
        const markerRows: Row[] = [...byTime.entries()].map(([raw, markers]) => ({
            kind: 'marker',
            // Sort a hair below the same-dated event so the milestone renders just
            // after (directly under) the event that unlocked it, not the newer one
            // above it (list is newest-first).
            date: raw - 1,
            markers,
        }));
        return [...eventRows, ...markerRows].sort((a, b) => b.date - a.date);
    }, [timelineItems, timelineMarkers, timelineHasMore]);

    // First (newest) event of each month gets a scroll anchor so the activity
    // heatmap can jump the timeline to a clicked month.
    const monthAnchorIds = useMemo(() => {
        const seen = new Set<string>();
        const byEvent = new Map<string, string>();
        for (const row of timelineRows) {
            if (row.kind !== 'event') continue;
            const month = row.item.start.slice(0, 7);
            if (!seen.has(month)) {
                seen.add(month);
                byEvent.set(row.item.event_id, month);
            }
        }
        return byEvent;
    }, [timelineRows]);

    const timelineListRef = useRef<HTMLUListElement>(null);
    const [highlightMonth, setHighlightMonth] = useState<string | null>(null);
    const pendingMonthRef = useRef<string | null>(null);

    const scrollToMonth = useCallback((month: string) => {
        const el = timelineListRef.current?.querySelector(
            `[data-month-anchor="${month}"]`,
        );
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
        }
        return false;
    }, []);

    const handleSelectMonth = useCallback(
        (month: string) => {
            setHighlightMonth(month);
            // Scroll now if the month is loaded; otherwise remember it and page
            // in more history until its events arrive.
            if (!scrollToMonth(month) && timelineHasMore) {
                pendingMonthRef.current = month;
                onLoadMoreTimeline?.();
            }
        },
        [scrollToMonth, timelineHasMore, onLoadMoreTimeline],
    );

    // Resolve a pending month scroll once newly-loaded items arrive.
    useEffect(() => {
        const month = pendingMonthRef.current;
        if (!month) return;
        if (scrollToMonth(month)) {
            pendingMonthRef.current = null;
        } else if (timelineHasMore && !loadingMoreTimeline) {
            onLoadMoreTimeline?.();
        } else {
            pendingMonthRef.current = null;
        }
    }, [timelineItems, scrollToMonth, timelineHasMore, loadingMoreTimeline, onLoadMoreTimeline]);

    return (
        <>
            <SummaryHeader data={data} title={title} actions={headerActions} dancingSinceSlot={dancingSinceSlot} />

            <section ref={tabsRef}>
                <div role="tablist" className="flex border-b border-slate-200">
                    {shown.map((s) => (
                        <TabButton key={s} active={tab === s} onClick={() => setTab(s)}>
                            {SECTION_LABELS[s]}
                        </TabButton>
                    ))}
                </div>

                <div className="mt-4">
                    {tab === 'milestones' && has('milestones') && (
                        <>
                            <section className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
                                <StatCard
                                    value={data.stats.total_events_attended}
                                    label="Events attended"
                                    action={
                                        has('timeline')
                                            ? { label: 'Timeline', onClick: () => selectTab('timeline') }
                                            : undefined
                                    }
                                />
                                <StatCard
                                    value={data.stats.cities_visited}
                                    label="Cities"
                                    onLabelClick={has('cities') ? () => selectTab('cities') : undefined}
                                />
                                <StatCard
                                    value={data.stats.countries_visited}
                                    label="Countries"
                                    onLabelClick={has('countries') ? () => selectTab('countries') : undefined}
                                />
                                <StatCard
                                    value={`${data.stats.active_months_last_12}/12`}
                                    label="Active months"
                                />
                                <StatCard
                                    value={data.stats.avg_gap_days == null ? '—' : Math.max(1, Math.round(data.stats.avg_gap_days))}
                                    label="Days between events"
                                />
                                <StatCard value={data.stats.reviews_written} label="Reviews written" />
                            </section>
                            <MilestonesGrid
                                milestones={data.milestones}
                                consistency={data.consistency}
                            />
                        </>
                    )}
                    {tab === 'timeline' && has('timeline') && (
                        <>
                            {timelineActions && (
                                <div className="mb-3 flex justify-end">{timelineActions}</div>
                            )}
                            <PassportActivityHeatmap
                                months={data.monthly_activity ?? []}
                                onSelectMonth={handleSelectMonth}
                                highlightMonth={highlightMonth}
                            />
                            {timelineItems.length === 0 ? (
                                <div className="border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                                    No attended events yet.
                                </div>
                            ) : (
                                <ul className="relative space-y-1.5" ref={timelineListRef}>
                                    <span
                                        className="absolute left-[6px] top-2 bottom-2 w-px bg-slate-200"
                                        aria-hidden
                                    />
                                    {timelineRows.map((row) =>
                                        row.kind === 'event' ? (
                                            <TimelineRow
                                                key={`e-${row.item.event_id}`}
                                                item={row.item}
                                                anchorMonth={monthAnchorIds.get(row.item.event_id) ?? null}
                                                highlighted={highlightMonth != null && row.item.start.slice(0, 7) === highlightMonth}
                                            />
                                        ) : (
                                            <TimelineMarkerRow
                                                key={`m-${row.date}`}
                                                markers={row.markers}
                                            />
                                        ),
                                    )}
                                </ul>
                            )}
                            {timelineHasMore && (
                                <button
                                    type="button"
                                    onClick={onLoadMoreTimeline}
                                    disabled={loadingMoreTimeline}
                                    className="mt-4 w-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    {loadingMoreTimeline ? 'Loading…' : 'Show more'}
                                </button>
                            )}
                        </>
                    )}
                    {tab === 'cities' && has('cities') && (
                        mapEvents === null ? (
                            <div className="border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                                Loading map…
                            </div>
                        ) : (
                            <CitiesPanel data={data} events={mapEvents} />
                        )
                    )}
                    {tab === 'countries' && has('countries') && (
                        mapEvents === null ? (
                            <div className="border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                                Loading map…
                            </div>
                        ) : (
                            <CountriesPanel data={data} events={mapEvents} />
                        )
                    )}
                </div>
            </section>
        </>
    );
}
