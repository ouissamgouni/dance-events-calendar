/** Shared owner, profile, and public Dance Passport presentation. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
    ArrowRight,
    CalendarDays,
    Check,
    ChevronRight,
    Clock3,
    Globe2,
    LockKeyhole,
    MapPin,
    MessageSquareText,
    Search,
    Trophy,
    X,
} from 'lucide-react';
import EventMap from './EventMap';
import MyDanceActivityStrip from './MyDanceActivityStrip';
import MyDanceJourneyMap from './MyDanceJourneyMap';
import PassportActivityHeatmap from './PassportActivityHeatmap';
import PassportSummaryCard from './PassportSummaryCard';
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
type PassportTab = 'milestones' | 'journey' | 'places';
type MilestoneCategoryKey = 'events' | 'consistency' | 'cities' | 'countries' | 'reviews';
type MilestoneCardState = 'unlocked' | 'in-progress' | 'locked';

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

function formatPeriodRange(startYm: string, endYm: string): string {
    const [startYear, startMonth] = startYm.split('-').map(Number);
    const [endYear, endMonth] = endYm.split('-').map(Number);
    if (!startYear || !startMonth || !endYear || !endMonth) return `${startYm}-${endYm}`;
    const month = (year: number, value: number) =>
        new Date(year, value - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    if (startYear === endYear && startMonth === endMonth) return `${month(startYear, startMonth)} ${startYear}`;
    if (startYear === endYear) return `${month(startYear, startMonth)}-${month(endYear, endMonth)} ${endYear}`;
    return `${month(startYear, startMonth)} ${startYear}-${month(endYear, endMonth)} ${endYear}`;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={active
                ? 'flex-1 border-b-2 border-brand px-3 py-3 text-sm font-semibold text-brand'
                : 'flex-1 border-b-2 border-transparent px-3 py-3 text-sm font-medium text-ink-soft hover:text-ink'}
        >
            {children}
        </button>
    );
}



function SummaryHeader({
    data,
    displayName,
    handle,
    avatarUrl,
    actions,
    dancingSinceSlot,
}: {
    data: PassportResponse;
    displayName: string;
    handle: string | null;
    avatarUrl: string | null;
    actions?: ReactNode;
    dancingSinceSlot?: ReactNode;
}) {
    const mapCoords = data.collections.cities.flatMap((city) =>
        city.latitude != null && city.longitude != null
            ? [{ lat: city.latitude, lng: city.longitude }]
            : [],
    );
    return (
        <PassportSummaryCard
            displayName={displayName}
            handle={handle}
            avatarUrl={avatarUrl}
            eventsCount={data.stats.total_events_attended}
            citiesCount={data.stats.cities_visited}
            countriesCount={data.stats.countries_visited}
            coords={mapCoords}
            monthlyActivity={data.monthly_activity ?? []}
            actions={actions}
            footer={
                dancingSinceSlot ?? (
                    <div className="text-xs leading-5 text-white/85 space-y-1">
                        <div className="whitespace-nowrap">Dancing since {formatDate(data.stats.dancing_since ?? data.stats.member_since)}</div>
                        {data.stats.first_event_date && (
                            <div className="whitespace-nowrap">First event on Movida {formatDate(data.stats.first_event_date)}</div>
                        )}
                    </div>
                )
            }
        />
    );
}

function StatCell({ value, label, icon }: { value: number | string; label: string; icon: ReactNode }) {
    return (
        <div className="flex min-h-20 flex-col items-center justify-center px-2 py-3 text-center">
            <div className="flex items-center gap-2">
                {icon}
                <span className="text-xl font-semibold text-ink tabular-nums">{value}</span>
            </div>
            <div className="mt-1 text-[11px] font-medium leading-tight text-ink-soft">{label}</div>
        </div>
    );
}

function PassportStatsPanel({ data }: { data: PassportResponse }) {
    const cadence = data.stats.avg_gap_days == null ? '-' : Math.max(1, Math.round(data.stats.avg_gap_days));
    return (
        <section aria-label="Your stats" className="rounded-card bg-brand/5 p-2">
            <h2 className="px-2 pt-1 text-xs font-semibold uppercase text-ink-soft">Your stats</h2>
            <div className="mt-1 grid grid-cols-3 divide-x divide-y divide-brand/10">
                <StatCell value={data.stats.total_events_attended} label="Events" icon={<Trophy className="h-5 w-5 text-amber-600" aria-hidden="true" />} />
                <StatCell value={data.stats.cities_visited} label="Cities" icon={<MapPin className="h-5 w-5 text-brand" aria-hidden="true" />} />
                <StatCell value={data.stats.countries_visited} label="Countries" icon={<Globe2 className="h-5 w-5 text-action" aria-hidden="true" />} />
                <StatCell value={`${data.stats.active_months_last_12}/12`} label="Active months" icon={<CalendarDays className="h-5 w-5 text-brand" aria-hidden="true" />} />
                <StatCell value={cadence} label="Days / event" icon={<Clock3 className="h-5 w-5 text-brand" aria-hidden="true" />} />
                <StatCell value={data.stats.reviews_written} label="Reviews" icon={<MessageSquareText className="h-5 w-5 text-ink-soft" aria-hidden="true" />} />
            </div>
        </section>
    );
}

interface MilestoneCardModel {
    key: string;
    name: string;
    description: string;
    icon: string;
    state: MilestoneCardState;
    progress?: string;
    progressValue?: number;
    progressThreshold?: number;
    date?: string;
}

interface MilestoneCategoryModel {
    key: MilestoneCategoryKey;
    label: string;
    description: string;
    cards: MilestoneCardModel[];
    unlockedCount: number;
}

const MILESTONE_CATEGORY_ORDER: MilestoneCategoryKey[] = ['events', 'consistency', 'cities', 'countries', 'reviews'];
const MILESTONE_CATEGORY_META: Record<MilestoneCategoryKey, {
    label: string;
    description: string;
    iconClass: string;
    progressClass: string;
}> = {
    events: { label: 'Events', description: 'Attend events and build your dance journey.', iconClass: 'text-amber-600', progressClass: 'border-amber-300 bg-amber-50' },
    consistency: { label: 'Consistency', description: 'Build a steady rhythm across active months.', iconClass: 'text-brand', progressClass: 'border-brand/30 bg-brand/5' },
    cities: { label: 'Cities', description: 'Discover dance communities in new cities.', iconClass: 'text-action', progressClass: 'border-action/30 bg-blue-50' },
    countries: { label: 'Countries', description: 'Take your dance journey across borders.', iconClass: 'text-success', progressClass: 'border-success/30 bg-emerald-50' },
    reviews: { label: 'Community', description: 'Help dancers with useful event reviews.', iconClass: 'text-violet-600', progressClass: 'border-violet-300 bg-violet-50' },
};

function CategoryIcon({ category, className = 'h-5 w-5' }: { category: MilestoneCategoryKey; className?: string }) {
    const classes = `${className} ${MILESTONE_CATEGORY_META[category].iconClass}`;
    if (category === 'events') return <Trophy className={classes} aria-hidden="true" />;
    if (category === 'consistency') return <CalendarDays className={classes} aria-hidden="true" />;
    if (category === 'cities') return <MapPin className={classes} aria-hidden="true" />;
    if (category === 'countries') return <Globe2 className={classes} aria-hidden="true" />;
    return <MessageSquareText className={classes} aria-hidden="true" />;
}

function ordinaryMilestoneCards(milestones: PassportMilestone[]): MilestoneCardModel[] {
    const nextLocked = milestones.find((milestone) => !milestone.unlocked)?.key ?? null;
    return milestones.map((milestone) => ({
        key: milestone.key,
        name: milestone.name,
        description: milestone.unlocked ? milestone.achieved_description : milestone.description,
        icon: milestone.icon,
        state: milestone.unlocked ? 'unlocked' : milestone.key === nextLocked ? 'in-progress' : 'locked',
        progress: milestone.key === nextLocked
            ? `${Math.min(milestone.progress, milestone.threshold)} / ${milestone.threshold}`
            : undefined,
        progressValue: milestone.key === nextLocked ? Math.min(milestone.progress, milestone.threshold) : undefined,
        progressThreshold: milestone.key === nextLocked ? milestone.threshold : undefined,
        date: milestone.unlocked_at ? `Unlocked ${formatDate(milestone.unlocked_at)}` : undefined,
    }));
}

function consistencyCards(consistency: PassportConsistency | null | undefined): MilestoneCardModel[] {
    if (!consistency) return [];
    const firstLocked = consistency.locked[0]?.key ?? null;
    return [
        ...consistency.earned.map((card) => ({
            key: card.key,
            name: card.name,
            description: `${card.threshold}/${consistency.window} active months`,
            icon: card.icon,
            state: 'unlocked' as const,
            date: `Reached ${formatPeriodRange(card.period_start, card.reached)}`,
        })),
        ...consistency.locked.map((card) => ({
            key: card.key,
            name: card.name,
            description: `Be active in ${card.threshold} of ${consistency.window} months`,
            icon: card.icon,
            state: card.key === firstLocked ? 'in-progress' as const : 'locked' as const,
            progress: card.key === firstLocked ? `${card.active_months} / ${card.threshold}` : undefined,
            progressValue: card.key === firstLocked ? card.active_months : undefined,
            progressThreshold: card.key === firstLocked ? card.threshold : undefined,
        })),
    ];
}

function buildMilestoneCategories(data: PassportResponse): MilestoneCategoryModel[] {
    const byCategory = new Map<string, PassportMilestone[]>();
    for (const milestone of data.milestones) {
        const current = byCategory.get(milestone.category) ?? [];
        current.push(milestone);
        byCategory.set(milestone.category, current);
    }
    return MILESTONE_CATEGORY_ORDER.map((key) => {
        const cards = key === 'consistency'
            ? consistencyCards(data.consistency)
            : ordinaryMilestoneCards(byCategory.get(key) ?? []);
        return {
            key,
            label: MILESTONE_CATEGORY_META[key].label,
            description: MILESTONE_CATEGORY_META[key].description,
            cards,
            unlockedCount: cards.filter((card) => card.state === 'unlocked').length,
        };
    });
}

function MilestoneStateIcons({ cards }: { cards: MilestoneCardModel[] }) {
    return (
        <span className="flex min-h-5 items-center justify-end gap-1.5 overflow-hidden" aria-hidden="true">
            {cards.map((card) => (
                <span
                    key={card.key}
                    className={card.state === 'unlocked'
                        ? 'shrink-0 text-base leading-none'
                        : card.state === 'in-progress'
                            ? 'shrink-0 text-base leading-none opacity-80'
                            : 'shrink-0 text-base leading-none grayscale opacity-70 contrast-125'}
                >
                    {card.icon}
                </span>
            ))}
            {cards.length === 0 && <span className="text-[11px] text-muted">No milestones yet</span>}
        </span>
    );
}

function MilestoneCategoryRow({ category, onOpen }: { category: MilestoneCategoryModel; onOpen: () => void }) {
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`${category.label}, ${category.unlockedCount} / ${category.cards.length} unlocked`}
            className="grid min-h-16 w-full grid-cols-[2.25rem_minmax(0,1fr)_auto_1.25rem] items-center gap-3 rounded-card border border-card-line bg-surface/60 p-3 text-left transition hover:border-line hover:bg-surface"
        >
            <span className={`flex h-9 w-9 items-center justify-center self-center rounded-lg border ${MILESTONE_CATEGORY_META[category.key].progressClass}`}>
                <CategoryIcon category={category.key} />
            </span>
            <span className="min-w-[6.5rem] flex-1">
                <span className="block truncate text-sm font-semibold text-ink">{category.label}</span>
                <span className="block text-[11px] tabular-nums text-ink-soft">
                    {category.unlockedCount} / {category.cards.length} unlocked
                </span>
            </span>
            <MilestoneStateIcons cards={category.cards} />
            <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
        </button>
    );
}

function MilestonesOverview({ categories, onOpen }: { categories: MilestoneCategoryModel[]; onOpen: (key: MilestoneCategoryKey) => void }) {
    const unlocked = categories.reduce((sum, category) => sum + category.unlockedCount, 0);
    const total = categories.reduce((sum, category) => sum + category.cards.length, 0);
    return (
        <section>
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase text-ink-soft">Milestone progress</h2>
                <span className="text-xs tabular-nums text-ink-soft">{unlocked} / {total} unlocked</span>
            </div>
            <div className="space-y-2">
                {categories.map((category) => (
                    <MilestoneCategoryRow key={category.key} category={category} onOpen={() => onOpen(category.key)} />
                ))}
            </div>
        </section>
    );
}

function MilestoneDetailCard({ card, category }: { card: MilestoneCardModel; category: MilestoneCategoryKey }) {
    const stateClass = card.state === 'unlocked'
        ? 'border-success/20 bg-success/5'
        : card.state === 'in-progress'
            ? MILESTONE_CATEGORY_META[category].progressClass
            : 'border-line bg-surface';
    const progressPercent = card.progressValue != null && card.progressThreshold
        ? Math.min(100, Math.round((card.progressValue / card.progressThreshold) * 100))
        : 0;
    return (
        <article className={`relative flex min-h-32 flex-col items-center rounded-card border p-3 text-center ${stateClass}`}>
            {card.state === 'unlocked' && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Unlocked</span>
                </span>
            )}
            {card.state === 'locked' && <LockKeyhole className="absolute right-2 top-2 h-4 w-4 text-muted" aria-label="Locked" />}
            <div className={card.state === 'locked' ? 'text-2xl opacity-60 grayscale' : 'text-2xl'}>{card.icon}</div>
            <h3 className={card.state === 'locked' ? 'mt-2 text-xs font-semibold text-muted' : 'mt-2 text-xs font-semibold text-ink'}>{card.name}</h3>
            <p className={card.state === 'locked' ? 'mt-1 text-[11px] leading-4 text-muted' : 'mt-1 text-[11px] leading-4 text-ink-soft'}>{card.description}</p>
            {card.progress && (
                <div className="mt-2 w-full">
                    <div
                        role="progressbar"
                        aria-label={`${card.name} progress`}
                        aria-valuemin={0}
                        aria-valuemax={card.progressThreshold}
                        aria-valuenow={card.progressValue}
                        className="h-1.5 overflow-hidden rounded-full bg-line"
                    >
                        <div className="h-full rounded-full bg-brand" style={{ width: `${progressPercent}%` }} />
                    </div>
                    <p className={`mt-1 text-xs font-semibold tabular-nums ${MILESTONE_CATEGORY_META[category].iconClass}`}>{card.progress}</p>
                </div>
            )}
            {card.date && <p className="mt-2 text-[10px] text-ink-soft">{card.date}</p>}
        </article>
    );
}

function MilestoneCategorySheet({ category, onClose }: { category: MilestoneCategoryModel; onClose: () => void }) {
    return (
        <div
            className="fixed inset-0 z-[11000] flex items-end justify-center bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label={`${category.label} Milestones`}
        >
            <div
                className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-card bg-canvas shadow-xl"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="sticky top-0 z-10 flex min-h-12 items-center border-b border-line bg-surface px-2">
                    <span className="h-10 w-10" aria-hidden="true" />
                    <h1 className="flex-1 text-center text-sm font-semibold text-ink">{category.label} Milestones</h1>
                    <button type="button" onClick={onClose} aria-label="Close milestone details" className="flex h-10 w-10 items-center justify-center text-ink-soft hover:text-ink">
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>
                <div className="p-4">
                    <section className={`rounded-card border p-4 ${MILESTONE_CATEGORY_META[category.key].progressClass}`}>
                        <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface/80">
                                <CategoryIcon category={category.key} className="h-6 w-6" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <h2 className="text-sm font-semibold text-ink">{category.label}</h2>
                                <p className="text-xs tabular-nums text-ink-soft">{category.unlockedCount} / {category.cards.length} unlocked</p>
                            </div>
                            <div className="max-w-[45%] overflow-hidden"><MilestoneStateIcons cards={category.cards} /></div>
                        </div>
                        <p className="mt-3 text-xs leading-5 text-ink-soft">{category.description}</p>
                    </section>
                    {category.cards.length > 0 ? (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                            {category.cards.map((card) => <MilestoneDetailCard key={card.key} card={card} category={category.key} />)}
                        </div>
                    ) : (
                        <div className="mt-3 rounded-card bg-surface p-6 text-center text-sm text-ink-soft">No milestones yet.</div>
                    )}
                </div>
            </div>
        </div>
    );
}

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

function railDate(iso: string): { weekday: string; month: string; day: number } {
    const date = new Date(iso);
    return {
        weekday: date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
        month: date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
        day: date.getDate(),
    };
}

function MilestoneCard({ marker }: { marker: PassportTimelineMarker }) {
    const copy = TIMELINE_MILESTONE[marker.key.split(':')[0]];
    const description = marker.description ?? marker.label ?? copy?.label;
    return (
        <div className="flex gap-2.5 bg-orange-50/70 px-3 py-2 first:rounded-t-card last:rounded-b-card">
            <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" aria-hidden="true" />
            <div className="min-w-0">
                <div className="text-sm font-semibold leading-4 text-ink">
                    {marker.name} <span className="ml-1" aria-hidden="true">{marker.icon ?? copy?.icon}</span>
                </div>
                {description && <div className="mt-0.5 text-xs leading-4 text-ink-soft">{description}</div>}
            </div>
        </div>
    );
}

interface JourneyEntry {
    key: string;
    date: string;
    event?: PassportTimelineItem;
    markers: PassportTimelineMarker[];
}

function JourneyEntryRow({ entry, anchorMonth, highlighted }: { entry: JourneyEntry; anchorMonth?: string | null; highlighted?: boolean }) {
    const date = railDate(entry.date);
    const place = entry.event
        ? [entry.event.city, entry.event.country].filter(Boolean).join(', ') || entry.event.location
        : null;
    return (
        <li className="relative grid grid-cols-[3rem_1.25rem_minmax(0,1fr)] gap-x-2 pb-5 last:pb-1" data-month-anchor={anchorMonth ?? undefined} data-testid="journey-entry">
            <div className="pt-0.5 text-center leading-none">
                <div className="text-[10px] font-semibold text-brand">{date.weekday}</div>
                <div className="mt-1 text-[10px] font-medium text-ink-soft">{date.month}</div>
                <div className="mt-1 text-lg font-semibold text-ink">{date.day}</div>
            </div>
            <div className="relative flex justify-center">
                <span className="relative z-10 mt-2 h-2.5 w-2.5 rounded-full bg-brand ring-[3px] ring-canvas" aria-hidden="true" />
            </div>
            <div className={`min-w-0 ${highlighted ? 'rounded-card bg-blue-50 ring-2 ring-action' : ''}`}>
                {entry.event && (
                    <Link to={`/event/${entry.event.event_id}`} className="group block px-1 pb-2 pt-0.5">
                        <div className="text-sm font-semibold leading-5 text-ink group-hover:text-action">{entry.event.title}</div>
                        {place && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-ink-soft">
                                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="truncate">{place}</span>
                            </div>
                        )}
                    </Link>
                )}
                {entry.markers.length > 0 && (
                    <div className="max-w-[420px] divide-y divide-orange-100">
                        {entry.markers.map((marker) => <MilestoneCard key={marker.key} marker={marker} />)}
                    </div>
                )}
            </div>
        </li>
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
    eventKeyOf: (event: PassportMapEvent) => string | null;
    emptyLabel: string;
}) {
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [activeFilterKey, setActiveFilterKey] = useState<string | null>(null);
    const [autoFitToken, setAutoFitToken] = useState(0);
    const listRef = useRef<HTMLUListElement>(null);
    const rowRefs = useRef(new Map<string, HTMLLIElement>());
    const filtered = useMemo(
        () => activeFilterKey === null ? events : events.filter((event) => eventKeyOf(event) === activeFilterKey),
        [activeFilterKey, events, eventKeyOf],
    );
    const selectEntry = (key: string) => {
        setSelectedKey(key);
        setActiveFilterKey(key);
        setAutoFitToken((token) => token + 1);
    };
    const revealEntry = useCallback((key: string) => {
        const list = listRef.current;
        const row = rowRefs.current.get(key);
        if (!list || !row) return;
        const rowTop = row.offsetTop;
        const rowBottom = rowTop + row.offsetHeight;
        if (rowTop < list.scrollTop) list.scrollTop = rowTop;
        else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
    }, []);
    const selectMarker = useCallback((event: PassportMapEvent) => {
        const key = eventKeyOf(event);
        if (!key || !rowRefs.current.has(key)) return;
        setSelectedKey(key);
        revealEntry(key);
    }, [eventKeyOf, revealEntry]);
    const optionClass = (active: boolean) => active
        ? 'flex h-12 w-full items-center justify-between gap-4 bg-action/5 px-4 text-left text-action'
        : 'flex h-12 w-full items-center justify-between gap-4 px-4 text-left text-ink hover:bg-canvas';
    return (
        <div>
            <div className="h-60 w-full overflow-hidden bg-surface sm:h-[360px]">
                <EventMap
                    events={filtered}
                    minimalPopup
                    detailLinkSource="passport"
                    autoFitToken={autoFitToken}
                    onMarkerSelect={(event) => selectMarker(event as PassportMapEvent)}
                    showFollowingBadgeOverlay={false}
                    showTrendingOverlay={false}
                    cooperativeGestures
                />
            </div>
            <div className="bg-surface">
                <ul ref={listRef} className="relative h-60 divide-y divide-line overflow-y-auto overscroll-contain">
                    {entries.map((entry) => (
                        <li
                            key={entry.key}
                            ref={(element) => {
                                if (element) rowRefs.current.set(entry.key, element);
                                else rowRefs.current.delete(entry.key);
                            }}
                        >
                            <button
                                type="button"
                                aria-pressed={selectedKey === entry.key}
                                aria-label={`${entry.label} ${entry.count} ${entry.count === 1 ? 'event' : 'events'}`}
                                onClick={() => selectEntry(entry.key)}
                                className={optionClass(selectedKey === entry.key)}
                            >
                                <span className="min-w-0 truncate text-base font-semibold">{entry.label}</span>
                                <span className="shrink-0 text-sm font-normal text-ink-soft tabular-nums">
                                    {entry.count} {entry.count === 1 ? 'event' : 'events'}
                                </span>
                            </button>
                        </li>
                    ))}
                    {entries.length === 0 && <li className="flex h-12 items-center px-4 text-sm text-muted">{emptyLabel}</li>}
                </ul>
            </div>
        </div>
    );
}

function cityKey(city: string, country: string | null, includeCountry: boolean): string {
    return includeCountry ? `${city}|${country ?? ''}` : city;
}

function PlacesPanel({
    data,
    events,
    showCities,
    showCountries,
}: {
    data: PassportResponse;
    events: PassportMapEvent[];
    showCities: boolean;
    showCountries: boolean;
}) {
    const [mode, setMode] = useState<'cities' | 'countries'>(showCities ? 'cities' : 'countries');
    const baseCityEntries: FilterEntry[] = data.collections.cities.map((city) => ({
        key: cityKey(city.city, city.country, showCountries),
        label: showCountries && city.country ? `${city.city}, ${city.country}` : city.city,
        count: city.count,
    }));
    const baseCountryEntries: FilterEntry[] = data.collections.countries.map((country) => ({
        key: country.country,
        label: country.country,
        count: country.count,
    }));
    const cityEntries: FilterEntry[] = [
        { key: null, label: 'All', count: baseCityEntries.reduce((sum, entry) => sum + entry.count, 0) },
        ...baseCityEntries,
    ];
    const countryEntries: FilterEntry[] = [
        { key: null, label: 'All', count: baseCountryEntries.reduce((sum, entry) => sum + entry.count, 0) },
        ...baseCountryEntries,
    ];
    const cityEvents = showCountries ? events : events.map((event) => ({ ...event, country: null }));
    const countryEvents = showCities ? events : events.map((event) => ({ ...event, city: null }));
    const available = mode === 'cities' ? showCities : showCountries;
    const cityCount = data.stats.cities_visited;
    const countryCount = data.stats.countries_visited;
    return (
        <section>
            <div className="grid grid-cols-2 border-b border-line bg-surface" role="group" aria-label="Place type">
                <button type="button" aria-pressed={mode === 'cities'} onClick={() => setMode('cities')} className={mode === 'cities' ? 'whitespace-nowrap border-b-2 border-action px-3 py-3 text-base font-semibold text-action' : 'whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-base font-medium text-ink-soft'}>
                    {cityCount} {cityCount === 1 ? 'city' : 'cities'}
                </button>
                <button type="button" aria-pressed={mode === 'countries'} onClick={() => setMode('countries')} className={mode === 'countries' ? 'whitespace-nowrap border-b-2 border-action px-3 py-3 text-base font-semibold text-action' : 'whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-base font-medium text-ink-soft'}>
                    {countryCount} {countryCount === 1 ? 'country' : 'countries'}
                </button>
            </div>
            {!available ? (
                <UnavailableState message={`${mode === 'cities' ? 'Cities' : 'Countries'} are not shared on this passport.`} />
            ) : mode === 'cities' ? (
                <FilterableEventMap
                    key="cities"
                    events={cityEvents}
                    entries={cityEntries}
                    eventKeyOf={(event) => event.city ? cityKey(event.city, event.country, showCountries) : null}
                    emptyLabel="No cities yet."
                />
            ) : (
                <FilterableEventMap
                    key="countries"
                    events={countryEvents}
                    entries={countryEntries}
                    eventKeyOf={(event) => event.country ?? null}
                    emptyLabel="No countries yet."
                />
            )}
        </section>
    );
}

function UnavailableState({ message }: { message: string }) {
    return <div className="rounded-card bg-surface p-6 text-center text-sm text-ink-soft">{message}</div>;
}

export interface PassportViewProps {
    data: PassportResponse;
    displayName?: string;
    handle?: string | null;
    avatarUrl?: string | null;
    title?: string;
    sections?: PassportSection[];
    headerActions?: ReactNode;
    dancingSinceSlot?: ReactNode;
    timelineActions?: ReactNode;
    timelineItems?: PassportTimelineItem[];
    timelineMarkers?: PassportTimelineMarker[];
    timelineHasMore?: boolean;
    onLoadMoreTimeline?: () => void;
    loadingMoreTimeline?: boolean;
    mapEvents?: PassportMapEvent[] | null;
    onNeedMapEvents?: () => void;
    onTimelineSearch?: (query: string) => void;
}

export default function PassportView({
    data,
    displayName,
    handle = null,
    avatarUrl = null,
    title = 'Dance Passport',
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
    onTimelineSearch,
}: PassportViewProps) {
    const [tab, setTab] = useState<PassportTab>('milestones');
    const [selectedCategory, setSelectedCategory] = useState<MilestoneCategoryKey | null>(null);
    const hasMilestones = sections.includes('milestones');
    const hasJourney = sections.includes('timeline');
    const hasCities = sections.includes('cities');
    const hasCountries = sections.includes('countries');
    const categories = useMemo(() => buildMilestoneCategories(data), [data]);
    const activeCategory = categories.find((category) => category.key === selectedCategory) ?? null;

    const selectTab = useCallback((next: PassportTab) => {
        setSelectedCategory(null);
        setTab(next);
    }, []);

    useEffect(() => {
        if (tab !== 'places' || (!hasCities && !hasCountries) || mapEvents !== null) return;
        onNeedMapEvents?.();
    }, [tab, hasCities, hasCountries, mapEvents, onNeedMapEvents]);

    const [timelineSearch, setTimelineSearch] = useState('');
    useEffect(() => {
        if (!onTimelineSearch) return;
        const timer = window.setTimeout(() => onTimelineSearch(timelineSearch), 250);
        return () => window.clearTimeout(timer);
    }, [timelineSearch, onTimelineSearch]);
    const visibleTimelineItems = useMemo(() => {
        const query = timelineSearch.trim().toLocaleLowerCase();
        if (!query) return timelineItems;
        return timelineItems.filter((item) =>
            item.title.toLocaleLowerCase().includes(query)
            || (item.city ?? '').toLocaleLowerCase().includes(query)
            || (item.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(query)),
        );
    }, [timelineItems, timelineSearch]);
    const timelineEntries = useMemo<JourneyEntry[]>(() => {
        const entries = new Map<string, JourneyEntry>();
        for (const item of visibleTimelineItems) {
            entries.set(item.event_id, { key: `event-${item.event_id}`, date: item.start, event: item, markers: [] });
        }
        const oldestLoaded = timelineHasMore && timelineItems.length > 0
            ? Math.min(...timelineItems.map((item) => new Date(item.start).getTime()))
            : -Infinity;
        for (const marker of timelineMarkers) {
            if (marker.event_id) {
                entries.get(marker.event_id)?.markers.push(marker);
                continue;
            }
            if (timelineSearch.trim()) continue;
            const timestamp = new Date(marker.date).getTime();
            if (timestamp < oldestLoaded) continue;
            entries.set(`marker-${marker.key}`, { key: `marker-${marker.key}`, date: marker.date, markers: [marker] });
        }
        return [...entries.values()].sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
    }, [visibleTimelineItems, timelineItems, timelineMarkers, timelineHasMore, timelineSearch]);
    const timelineYears = useMemo(() => {
        const years = new Map<number, JourneyEntry[]>();
        for (const entry of timelineEntries) {
            const year = new Date(entry.date).getFullYear();
            years.set(year, [...(years.get(year) ?? []), entry]);
        }
        return [...years.entries()];
    }, [timelineEntries]);

    const monthAnchorIds = useMemo(() => {
        const seen = new Set<string>();
        const anchors = new Map<string, string>();
        for (const row of timelineEntries) {
            if (!row.event) continue;
            const month = row.event.start.slice(0, 7);
            if (!seen.has(month)) {
                seen.add(month);
                anchors.set(row.event.event_id, month);
            }
        }
        return anchors;
    }, [timelineEntries]);

    const timelineListRef = useRef<HTMLDivElement>(null);
    const [highlightMonth, setHighlightMonth] = useState<string | null>(null);
    const pendingMonthRef = useRef<string | null>(null);
    const scrollToMonth = useCallback((month: string) => {
        const element = timelineListRef.current?.querySelector(`[data-month-anchor="${month}"]`);
        if (!element) return false;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
    }, []);
    const handleSelectMonth = useCallback((month: string) => {
        setTimelineSearch('');
        setHighlightMonth(month);
        if (!scrollToMonth(month) && timelineHasMore) {
            pendingMonthRef.current = month;
            onLoadMoreTimeline?.();
        }
    }, [scrollToMonth, timelineHasMore, onLoadMoreTimeline]);
    useEffect(() => {
        const month = pendingMonthRef.current;
        if (!month) return;
        if (scrollToMonth(month)) pendingMonthRef.current = null;
        else if (timelineHasMore && !loadingMoreTimeline) onLoadMoreTimeline?.();
        else pendingMonthRef.current = null;
    }, [timelineItems, scrollToMonth, timelineHasMore, loadingMoreTimeline, onLoadMoreTimeline]);

    return (
        <>
            <div className="overflow-hidden bg-canvas sm:rounded-card">
                <SummaryHeader
                    data={data}
                    displayName={displayName ?? title}
                    handle={handle}
                    avatarUrl={avatarUrl}
                    actions={headerActions}
                    dancingSinceSlot={dancingSinceSlot}
                />
                <section>
                    <div role="tablist" className="flex border-b border-line bg-surface">
                        <TabButton active={tab === 'milestones'} onClick={() => selectTab('milestones')}>Milestones</TabButton>
                        <TabButton active={tab === 'journey'} onClick={() => selectTab('journey')}>Journey</TabButton>
                        <TabButton active={tab === 'places'} onClick={() => selectTab('places')}>Places</TabButton>
                    </div>
                    <div className="space-y-6 py-4">
                        {tab === 'milestones' && (
                            <>
                                <PassportStatsPanel data={data} />
                                {hasMilestones
                                    ? <MilestonesOverview categories={categories} onOpen={setSelectedCategory} />
                                    : <UnavailableState message="Milestones are not shared on this passport." />}
                            </>
                        )}
                        {tab === 'journey' && (
                            hasJourney ? (
                                <div className="space-y-6 px-4">
                                    <PassportActivityHeatmap months={data.monthly_activity ?? []} onSelectMonth={handleSelectMonth} highlightMonth={highlightMonth} />
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <h2 className="text-xl font-semibold text-ink">Timeline</h2>
                                            {(hasCities || hasCountries) && (
                                                <button type="button" onClick={() => selectTab('places')} className="inline-flex items-center gap-1 text-sm font-medium text-action hover:underline">
                                                    <MapPin className="h-4 w-4" aria-hidden="true" />
                                                    Show in map
                                                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                                                </button>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <label className="flex min-w-0 flex-1 items-center gap-2 border border-line bg-surface px-3 py-2">
                                                <Search className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
                                                <span className="sr-only">Search timeline events</span>
                                                <input
                                                    type="search"
                                                    value={timelineSearch}
                                                    onChange={(event) => setTimelineSearch(event.target.value)}
                                                    placeholder="Search events by name, city or tag"
                                                    className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
                                                />
                                            </label>
                                            <div className="shrink-0">
                                                {timelineActions}
                                            </div>
                                        </div>
                                    </div>
                                    {timelineEntries.length === 0 ? (
                                        <UnavailableState message="No attended events yet." />
                                    ) : (
                                        <div className="space-y-6" ref={timelineListRef}>
                                            {timelineYears.map(([year, entries]) => (
                                                <section key={year} aria-labelledby={`journey-year-${year}`}>
                                                    <h3 id={`journey-year-${year}`} className="mb-3 text-xl font-semibold text-ink">{year}</h3>
                                                    <ul className="relative">
                                                        <span className="absolute bottom-1 left-[3.6rem] top-2 w-px bg-line" aria-hidden="true" />
                                                        {entries.map((entry) => (
                                                            <JourneyEntryRow
                                                                key={entry.key}
                                                                entry={entry}
                                                                anchorMonth={entry.event ? monthAnchorIds.get(entry.event.event_id) ?? null : null}
                                                                highlighted={entry.event != null && highlightMonth != null && entry.event.start.slice(0, 7) === highlightMonth}
                                                            />
                                                        ))}
                                                    </ul>
                                                </section>
                                            ))}
                                        </div>
                                    )}
                                    {timelineHasMore && (
                                        <button type="button" onClick={onLoadMoreTimeline} disabled={loadingMoreTimeline} className="w-full rounded-card border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50">
                                            {loadingMoreTimeline ? 'Loading...' : 'Show more'}
                                        </button>
                                    )}
                                </div>
                            ) : <UnavailableState message="Journey is not shared on this passport." />
                        )}
                        {tab === 'places' && (
                            !hasCities && !hasCountries ? (
                                <UnavailableState message="Places are not shared on this passport." />
                            ) : mapEvents === null ? (
                                <UnavailableState message="Loading map..." />
                            ) : (
                                <PlacesPanel data={data} events={mapEvents} showCities={hasCities} showCountries={hasCountries} />
                            )
                        )}
                    </div>
                </section>
            </div>
            {activeCategory && <MilestoneCategorySheet category={activeCategory} onClose={() => setSelectedCategory(null)} />}
        </>
    );
}
