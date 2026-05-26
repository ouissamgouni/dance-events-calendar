import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import type { CalendarEvent } from '../types';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import RateEventButton from './RateEventButton';
import TagBadges from './TagBadges';
import { getTagColors } from '../utils/eventColor';

interface MapBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface EventListPanelProps {
    events: CalendarEvent[];
    mapBounds: MapBounds | null;
    onEventClick: (event: CalendarEvent) => void;
    showPrices: boolean;
    showPopularity: boolean;
    popularityThreshold?: number;
    sortBy: 'date' | 'popularity';
    onSortChange: (sort: 'date' | 'popularity') => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
    pastEventIds?: Set<string>;
    /** Optional callback to open the "Suggest an event" flow from the empty state. */
    onSuggestEvent?: () => void;
    /** When true, render the New state UI (dot + bold title + chip + counter). */
    newEnabled?: boolean;
    /** Set of event ids added after the current viewer's local baseline. */
    newEventIds?: Set<string>;
    /** Hide one event from this list, used when mobile map selection renders it above the list. */
    excludedEventId?: string | null;
    /** Scroll highlighted cards into view when the highlight comes from the map/calendar. */
    scrollHighlightedIntoView?: boolean;
    /**
        * Optional CTA invoked when the user has rendered every event in the
        * current period and asks for more. Parent extends the explorer's
        * ``endDate`` through the next future window that has matches. When
        * undefined, the future-events button is hidden and only the
        * paginate-within-period CTA is shown.
     */
    onExtendPeriod?: () => void;
    /**
     * Optional callback to clear all active filters from the empty state.
     * When undefined, the "Clear filters" button is hidden.
     */
    onClearFilters?: () => void;
    /** True while ``onExtendPeriod`` is in flight (disables the CTA). */
    extendingPeriod?: boolean;
    /** Count before tag filters, used for "displayed / scope" header copy. */
    scopeTotalCount?: number;
    /** Count for the next available future batch, if already known by the parent. */
    nextPeriodEventCount?: number | null;
}

export interface EventListCardProps {
    event: CalendarEvent;
    mapBounds: MapBounds | null;
    onEventClick: (event: CalendarEvent) => void;
    showPrices: boolean;
    showPopularity: boolean;
    popularityThreshold: number;
    trendingTopN: number;
    trendingTopPercent: number;
    allViewCounts: number[];
    followingBadgeEnabled: boolean;
    showRatings: boolean;
    isSavedFlag: boolean;
    isHighlighted?: boolean;
    isNew?: boolean;
    onEventHover?: (eventId: string | null) => void;
    cardRef?: (el: HTMLDivElement | null) => void;
    /** First-card coachmark for the Save/Going CTAs. Triggers a subtle
     * pulse on the action cluster and renders an inline hint underneath
     * the card content explaining what tapping them does. Dismissed via
     * the inline × button (writes localStorage flag). */
    coachMark?: boolean;
    onDismissCoachMark?: () => void;
}

function PriceBadge({ event }: { event: CalendarEvent }) {
    if (event.price_is_free) {
        return (
            <span className="inline-flex items-center bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Free
            </span>
        );
    }
    if (event.price_min != null && event.price_currency) {
        const priceText = event.price_max != null && event.price_max !== event.price_min
            ? `${event.price_currency} ${event.price_min}–${event.price_max}`
            : `${event.price_currency} ${event.price_min}`;
        return (
            <span className="inline-flex items-center bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                {priceText}
            </span>
        );
    }
    return null;
}

function PopularityBadge({
    score,
    allScores,
    threshold,
    topN,
    topPercent,
}: {
    score: number;
    allScores: number[];
    threshold: number;
    topN: number;
    topPercent: number;
}) {
    if (score <= 0 || score < threshold) return null;
    // Top-K of currently visible events where K is the effective cap
    //   min(topN, ceil(positiveVisible * topPercent / 100))
    // The score itself stays hidden — it's an internal blend (going +
    // saved + tiny view term, decayed by age), not a user-facing count.
    const sorted = [...allScores].sort((a, b) => b - a);
    const positiveCount = sorted.filter((s) => s > 0).length;
    const effectiveCap = Math.max(
        1,
        Math.min(topN, Math.ceil((positiveCount * topPercent) / 100)),
    );
    const isTopK = sorted.indexOf(score) < effectiveCap && sorted[0] > 0;
    if (!isTopK) return null;
    return (
        <span
            className="inline-flex items-center gap-0.5 bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700"
            data-testid="trending-badge"
        >
            🔥 Trending
        </span>
    );
}

function isInBounds(event: CalendarEvent, bounds: MapBounds): boolean {
    if (event.latitude == null || event.longitude == null) return false;
    return (
        event.latitude >= bounds.south &&
        event.latitude <= bounds.north &&
        event.longitude >= bounds.west &&
        event.longitude <= bounds.east
    );
}

/** True if the event is visible on the current map viewport. */
function isOnMap(event: CalendarEvent, bounds: MapBounds | null): boolean {
    if (!bounds) return true;
    return isInBounds(event, bounds);
}

const formatCardDate = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const formatCardTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Initial number of events to render before the user taps Show more. */
const INITIAL_VISIBLE = 10;
/** How many additional events each Show more click reveals. */
const SHOW_MORE_INCREMENT = 10;

/** Local YYYY-MM-DD key used to bucket events into day groups. */
function localDayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Human-friendly day header label: "Today", "Tomorrow", or weekday + date.
 * Keeps the user oriented inside long, day-grouped lists.
 */
function formatDayHeader(d: Date): string {
    const today = new Date();
    const todayKey = localDayKey(today);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowKey = localDayKey(tomorrow);
    const key = localDayKey(d);
    if (key === todayKey) return 'Today';
    if (key === tomorrowKey) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function EventListCard({
    event,
    mapBounds,
    onEventClick,
    showPrices,
    showPopularity,
    popularityThreshold,
    trendingTopN,
    trendingTopPercent,
    allViewCounts,
    followingBadgeEnabled,
    showRatings,
    isSavedFlag,
    isHighlighted = false,
    isNew = false,
    onEventHover,
    cardRef,
    coachMark = false,
    onDismissCoachMark,
}: EventListCardProps) {
    const start = new Date(event.start);
    const onMap = isOnMap(event, mapBounds);
    const offMapBadge = !onMap ? (
        <span className="event-card-offmap-badge" role="img" aria-label="Off map" title="Off map">
            <img src="/location-off.png" alt="" aria-hidden="true" className="event-card-offmap-icon" />
        </span>
    ) : null;

    return (
        <>
            <div
                ref={cardRef}
                role="button"
                tabIndex={0}
                className={`event-card${onMap ? '' : ' event-card-offmap'}${isHighlighted ? ' event-card-highlighted' : ''}`}
                onClick={() => onEventClick(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEventClick(event); } }}
                onMouseEnter={() => onEventHover?.(event.event_id)}
                onMouseLeave={() => onEventHover?.(null)}
            >
                <div className="event-card-color event-tag-stripes" aria-hidden="true">
                    {(() => {
                        const colors = getTagColors(event);
                        if (colors.length === 0) {
                            return <span className="event-tag-stripe" style={{ backgroundColor: '#6b7280' }} />;
                        }
                        return colors.map((c, i) => (
                            <span
                                key={i}
                                className="event-tag-stripe"
                                style={{ backgroundColor: c }}
                            />
                        ));
                    })()}
                </div>
                <div className="event-card-content relative">
                    <h4
                        className={`event-card-title${isNew ? ' font-semibold' : ''}`}
                        data-new={isNew ? 'true' : undefined}
                    >
                        {isNew && (
                            <span
                                className="inline-block h-1.5 w-1.5 bg-blue-500 mr-1.5 align-middle"
                                style={{ borderRadius: '9999px' }}
                                aria-label="New"
                                data-testid="new-event-dot"
                            />
                        )}
                        {event.title}
                    </h4>
                    <p className="event-card-date">
                        {event.all_day ? formatCardDate(start) : `${formatCardDate(start)} · ${formatCardTime(start)}`}
                    </p>
                    {event.location && (
                        <p className="event-card-location">
                            {offMapBadge}
                            <span className="event-card-location-text">📍 {event.location}</span>
                        </p>
                    )}
                    {!onMap && !event.location && (
                        <span className="event-card-offmap-badge event-card-offmap-badge-standalone" role="img" aria-label="Off map" title="Off map">
                            <img src="/location-off.png" alt="" aria-hidden="true" className="event-card-offmap-icon" />
                        </span>
                    )}
                    {((showPrices && (event.price_is_free || (event.price_min != null && event.price_currency)))) && (
                        <div className="event-card-badges">
                            {showPrices && <PriceBadge event={event} />}
                        </div>
                    )}
                    {event.tags?.length > 0 && (
                        <div className="mt-1">
                            <TagBadges tags={event.tags} maxVisible={3} />
                        </div>
                    )}
                    <div className="mt-1 flex items-center gap-2">
                        <AttendeeAvatarStack
                            eventId={event.event_id}
                            friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                        />
                        {event.has_active_promo_codes && (
                            <img
                                src="/promo-code.png"
                                alt=""
                                aria-hidden="true"
                                title="Has promo codes"
                                className="w-4 h-4 object-contain"
                                data-testid="event-card-promo-icon"
                            />
                        )}
                        {showPopularity && (
                            <PopularityBadge
                                score={event.popularity_score ?? 0}
                                allScores={allViewCounts}
                                threshold={popularityThreshold}
                                topN={trendingTopN}
                                topPercent={trendingTopPercent}
                            />
                        )}
                    </div>
                    <div className={`event-card-actions absolute top-0 right-0 flex items-center gap-1.5${coachMark ? ' animate-pulse' : ''}`}>
                        <ActionCountCluster eventId={event.event_id} showRatings={!!showRatings} isSavedFlag={isSavedFlag} />
                    </div>
                </div>
            </div>
            {coachMark && (
                <div
                    className="flex items-start justify-between gap-2 border border-blue-100 bg-blue-50 px-3 py-1.5 text-[11px] text-blue-800"
                    data-testid="event-card-coachmark"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <span>
                        Tap the bookmark to save events to your calendar, or the check to mark you’re going.
                    </span>
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDismissCoachMark?.(); }}
                        aria-label="Dismiss hint"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-blue-500 hover:text-blue-800 hover:bg-blue-100"
                    >
                        ×
                    </button>
                </div>
            )}
        </>
    );
}

export default function EventListPanel({
    events,
    mapBounds,
    onEventClick,
    showPrices,
    showPopularity,
    popularityThreshold = 10,
    sortBy,
    onSortChange,
    hoveredEventId,
    onEventHover,
    pastEventIds,
    onSuggestEvent,
    newEnabled = false,
    newEventIds,
    excludedEventId,
    scrollHighlightedIntoView = true,
    onExtendPeriod,
    onClearFilters,
    extendingPeriod = false,
    scopeTotalCount,
    nextPeriodEventCount,
}: EventListPanelProps) {
    const { isSaved } = useSavedEvents();
    const { showRatings, trendingEnabled, trendingTopN, trendingTopPercent, followingBadgeEnabled } = useFeatureFlags();
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const scrollRef = useRef<HTMLDivElement>(null);
    const pendingExtendVisibleCountRef = useRef(0);
    const [showBottomFade, setShowBottomFade] = useState(false);
    // Client-side only filter: hide events that are not new for this viewer.
    // Per the scenario, no network call is made when toggled.
    const [newOnly, setNewOnly] = useState(false);
    // Progressive disclosure cap so the landing page doesn't dump hundreds
    // of events on first paint. Resets whenever the underlying ``events``
    // array identity changes (new filter / period / refetch).
    const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
    useEffect(() => {
        if (pendingExtendVisibleCountRef.current > 0) {
            const increment = pendingExtendVisibleCountRef.current;
            pendingExtendVisibleCountRef.current = 0;
            setVisibleCount((current) => current + increment);
            return;
        }
        setVisibleCount(INITIAL_VISIBLE);
    }, [events]);

    // First-card coachmark for Save/Going CTAs. Stored in localStorage so
    // a dismissal sticks across reloads/devices for the same browser. We
    // hydrate from storage on mount to avoid an SSR-like flash; the
    // coachmark is only ever rendered on the first event card.
    const COACHMARK_KEY = 'explorer.coachmark.saveGoing.shown';
    const [coachMarkDismissed, setCoachMarkDismissed] = useState<boolean>(() => {
        try {
            return typeof window !== 'undefined' && window.localStorage.getItem(COACHMARK_KEY) === '1';
        } catch {
            return true;
        }
    });
    const dismissCoachMark = useCallback(() => {
        setCoachMarkDismissed(true);
        try { window.localStorage.setItem(COACHMARK_KEY, '1'); } catch { /* storage may be blocked */ }
    }, []);

    const updateFade = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const canScroll = el.scrollHeight > el.clientHeight;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        setShowBottomFade(canScroll && !atBottom);
    }, []);

    useEffect(() => {
        updateFade();
    }, [events, updateFade]);

    // Scroll to highlighted card when hoveredEventId changes from an external source (map/calendar)
    useEffect(() => {
        if (!scrollHighlightedIntoView) return;
        if (!hoveredEventId) return;
        const el = cardRefs.current.get(hoveredEventId);
        if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [hoveredEventId, scrollHighlightedIntoView]);

    const listEvents = excludedEventId
        ? events.filter((event) => event.event_id !== excludedEventId)
        : events;

    // Counter over the unfiltered list so toggling the chip doesn't make it jump.
    const newCount = newEnabled && newEventIds
        ? listEvents.reduce((n, e) => (newEventIds.has(e.event_id) ? n + 1 : n), 0)
        : 0;
    const effectiveNewOnly = newOnly && newCount > 0;

    // Show all events — on-map first, off-map / ungeolocated pushed to the bottom.
    // When pastEventIds is provided, keep upcoming events before past events.
    const visibleEvents = newEnabled && effectiveNewOnly && newEventIds
        ? listEvents.filter((e) => newEventIds.has(e.event_id))
        : listEvents;
    const sortedEvents = [...visibleEvents].sort((a, b) => {
        if (pastEventIds) {
            const aPast = pastEventIds.has(a.event_id);
            const bPast = pastEventIds.has(b.event_id);
            if (aPast !== bPast) return aPast ? 1 : -1;
            // Within the past group, sort descending by date (most recent first)
            if (aPast && sortBy === 'date') {
                const aOnMap = isOnMap(a, mapBounds);
                const bOnMap = isOnMap(b, mapBounds);
                if (aOnMap !== bOnMap) return aOnMap ? -1 : 1;
                return new Date(b.start).getTime() - new Date(a.start).getTime();
            }
        }
        const aOnMap = isOnMap(a, mapBounds);
        const bOnMap = isOnMap(b, mapBounds);
        if (aOnMap !== bOnMap) return aOnMap ? -1 : 1;
        if (sortBy === 'popularity') {
            // popularity_score is the weighted, time-decayed score
            // computed server-side when ``trending_enabled`` is on. When
            // the flag is off, all scores are 0 and this becomes a no-op
            // tiebreaker (the secondary date sort below takes over).
            const sa = a.popularity_score ?? 0;
            const sb = b.popularity_score ?? 0;
            if (sa !== sb) return sb - sa;
        }
        return new Date(a.start).getTime() - new Date(b.start).getTime();
    });

    const firstPastIndex = pastEventIds
        ? sortedEvents.findIndex((e) => pastEventIds.has(e.event_id))
        : -1;

    const onMapCount = mapBounds ? listEvents.filter((e) => isOnMap(e, mapBounds)).length : listEvents.length;

    // Slice the sorted list to the current ``visibleCount`` so the user only
    // sees what they explicitly asked for. The full count drives the
    // "Showing X of Y" counter and the Show more remaining count.
    const totalCount = sortedEvents.length;
    const totalInScope = scopeTotalCount ?? totalCount;
    const cappedVisible = Math.min(visibleCount, totalCount);
    const renderedEvents = sortedEvents.slice(0, cappedVisible);
    const remainingInPeriod = Math.max(0, totalCount - cappedVisible);
    const periodExhausted = remainingInPeriod === 0;
    const futureLookupPending = !!onExtendPeriod && nextPeriodEventCount == null;

    const allViewCounts = renderedEvents.map((e) => e.popularity_score ?? 0);

    const handleExtendPeriodClick = useCallback(() => {
        if (!onExtendPeriod) return;
        pendingExtendVisibleCountRef.current = Math.max(nextPeriodEventCount ?? 0, 0);
        onExtendPeriod();
    }, [onExtendPeriod, nextPeriodEventCount]);

    return (
        <div className="event-list-panel">
            <div className="event-list-header">
                <span className="event-list-count">
                    {totalCount === 0
                        ? `0 / ${totalInScope}`
                        : `Displayed ${cappedVisible} / ${totalInScope}`}
                    {mapBounds && onMapCount < totalCount && (
                        <span className="text-slate-400 font-normal"> · {totalCount - onMapCount} off map</span>
                    )}
                </span>
                <div className="event-list-sort">
                    <button
                        className={`sort-btn ${sortBy === 'date' ? 'active' : ''}`}
                        onClick={() => onSortChange('date')}
                    >
                        Date {sortBy === 'date' && '↓'}
                    </button>
                    {showPopularity && (
                        <button
                            className={`sort-btn ${sortBy === 'popularity' ? 'active' : ''}`}
                            onClick={() => onSortChange('popularity')}
                        >
                            Popular {sortBy === 'popularity' && '↓'}
                        </button>
                    )}
                    {newEnabled && newCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setNewOnly((v) => !v)}
                            aria-pressed={effectiveNewOnly}
                            data-testid="new-events-only-chip"
                            className={`sort-btn inline-flex items-center gap-1 border px-1.5 py-0.5 ${effectiveNewOnly
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'}`}
                        >
                            {/* eslint-disable-next-line no-restricted-syntax -- small status dot */}
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden="true" />
                            <span className="sm:hidden">New</span>
                            <span className="hidden sm:inline">New only</span>
                        </button>
                    )}
                </div>
            </div>
            {newEnabled && newCount > 0 && (
                <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]" data-testid="new-events-bar">
                    <span className="text-slate-600" data-testid="new-events-counter">
                        {/* eslint-disable-next-line no-restricted-syntax -- small status dot */}
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 mr-1.5 align-middle" aria-hidden="true" />
                        {newCount} new since your last visit
                    </span>
                </div>
            )}

            <div className="event-list-scroll-wrapper">
                <div className="event-list-scroll" ref={scrollRef} onScroll={updateFade}>
                    {totalCount === 0 ? (
                        <div
                            className="event-list-empty bg-blue-50 border border-blue-100 p-4 m-3 text-center"
                            data-testid="event-list-empty"
                        >
                            <p className="text-sm font-medium text-slate-800">
                                No events match your filters
                            </p>
                            <p className="text-xs text-slate-600 mt-1">
                                Try finding the next matching events or clearing filters.
                            </p>
                            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                                {onExtendPeriod && (
                                    <button
                                        type="button"
                                        onClick={handleExtendPeriodClick}
                                        disabled={extendingPeriod || futureLookupPending || nextPeriodEventCount === 0}
                                        className="inline-flex items-center bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
                                        data-testid="event-list-empty-extend"
                                    >
                                        {extendingPeriod
                                            ? 'Loading…'
                                            : futureLookupPending
                                                ? 'Looking ahead…'
                                                : nextPeriodEventCount === 0
                                                    ? 'No future events found'
                                                    : 'Find next events'}
                                    </button>
                                )}
                                {onClearFilters && (
                                    <button
                                        type="button"
                                        onClick={onClearFilters}
                                        className="inline-flex items-center border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-1.5 transition"
                                        data-testid="event-list-empty-clear"
                                    >
                                        Clear filters
                                    </button>
                                )}
                                {onSuggestEvent && (
                                    <button
                                        type="button"
                                        onClick={onSuggestEvent}
                                        className="inline-flex items-center border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-1.5 transition"
                                    >
                                        + Suggest an event
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
                            {(() => {
                                // When sorting by date, render sticky day-group headers so the
                                // user can scan the list day-by-day. Past events (when present)
                                // still get their existing divider above the past block.
                                const groupByDay = sortBy === 'date';
                                let lastDayKey: string | null = null;
                                return renderedEvents.map((event, idx) => {
                                    const isHighlighted = hoveredEventId === event.event_id;
                                    const isNew = newEnabled && !!newEventIds?.has(event.event_id);
                                    const start = new Date(event.start);
                                    const dayKey = localDayKey(start);
                                    const isPast = !!pastEventIds?.has(event.event_id);
                                    const showDayHeader =
                                        groupByDay && !isPast && dayKey !== lastDayKey;
                                    if (showDayHeader) {
                                        // Compute the count of events on this day within the
                                        // currently-rendered slice so the header reflects what
                                        // the user sees (not events hidden behind Show more).
                                        let countOnDay = 0;
                                        for (const e of renderedEvents) {
                                            if (pastEventIds?.has(e.event_id)) continue;
                                            if (localDayKey(new Date(e.start)) === dayKey) {
                                                countOnDay += 1;
                                            }
                                        }
                                        lastDayKey = dayKey;
                                        return (
                                            <Fragment key={event.event_id}>
                                                {idx === firstPastIndex && (
                                                    <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-t border-slate-200 mt-2">
                                                        Past events
                                                    </div>
                                                )}
                                                <div
                                                    className="sticky top-0 z-[5] flex items-center justify-between gap-2 bg-slate-50 border-y border-slate-200 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
                                                    data-testid="event-list-day-header"
                                                    data-day={dayKey}
                                                >
                                                    <span>{formatDayHeader(start)}</span>
                                                    <span className="text-slate-400 font-normal tabular-nums">
                                                        {countOnDay}
                                                    </span>
                                                </div>
                                                <EventListCard
                                                    event={event}
                                                    mapBounds={mapBounds}
                                                    onEventClick={onEventClick}
                                                    showPrices={showPrices}
                                                    showPopularity={showPopularity && trendingEnabled}
                                                    popularityThreshold={popularityThreshold}
                                                    trendingTopN={trendingTopN}
                                                    trendingTopPercent={trendingTopPercent}
                                                    allViewCounts={allViewCounts}
                                                    followingBadgeEnabled={followingBadgeEnabled}
                                                    showRatings={!!showRatings}
                                                    isSavedFlag={isSaved(event.event_id)}
                                                    isHighlighted={isHighlighted}
                                                    isNew={isNew}
                                                    onEventHover={onEventHover}
                                                    cardRef={(el) => { if (el) cardRefs.current.set(event.event_id, el); else cardRefs.current.delete(event.event_id); }}
                                                    coachMark={!coachMarkDismissed && idx === 0 && !isPast}
                                                    onDismissCoachMark={dismissCoachMark}
                                                />
                                            </Fragment>
                                        );
                                    }
                                    if (isPast) lastDayKey = null;
                                    return (
                                        <Fragment key={event.event_id}>
                                            {idx === firstPastIndex && (
                                                <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-t border-slate-200 mt-2">
                                                    Past events
                                                </div>
                                            )}
                                            <EventListCard
                                                event={event}
                                                mapBounds={mapBounds}
                                                onEventClick={onEventClick}
                                                showPrices={showPrices}
                                                showPopularity={showPopularity && trendingEnabled}
                                                popularityThreshold={popularityThreshold}
                                                trendingTopN={trendingTopN}
                                                trendingTopPercent={trendingTopPercent}
                                                allViewCounts={allViewCounts}
                                                followingBadgeEnabled={followingBadgeEnabled}
                                                showRatings={!!showRatings}
                                                isSavedFlag={isSaved(event.event_id)}
                                                isHighlighted={isHighlighted}
                                                isNew={isNew}
                                                onEventHover={onEventHover}
                                                cardRef={(el) => { if (el) cardRefs.current.set(event.event_id, el); else cardRefs.current.delete(event.event_id); }}
                                                coachMark={!coachMarkDismissed && idx === 0 && !isPast}
                                                onDismissCoachMark={dismissCoachMark}
                                            />
                                        </Fragment>
                                    );
                                });
                            })()}
                            {/* Progressive disclosure CTAs. Within the
                                current period we paginate in 10-event
                                increments; once exhausted we offer to
                                append the next future batch with matches
                                (handled by the parent). Both buttons are
                                square and use the secondary chrome from
                                .github/instructions/frontend.instructions.md. */}
                            {!periodExhausted && (
                                <div className="px-3 py-3 text-center">
                                    <button
                                        type="button"
                                        onClick={() => setVisibleCount((n) => n + SHOW_MORE_INCREMENT)}
                                        className="inline-flex items-center justify-center border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 transition"
                                        data-testid="event-list-show-more"
                                    >
                                        Show {Math.min(SHOW_MORE_INCREMENT, remainingInPeriod)} more
                                        <span className="ml-1 text-slate-400 font-normal">
                                            ({remainingInPeriod} remaining)
                                        </span>
                                    </button>
                                </div>
                            )}
                            {periodExhausted && onExtendPeriod && (
                                <div className="px-3 py-3 text-center">
                                    <button
                                        type="button"
                                        onClick={handleExtendPeriodClick}
                                        disabled={extendingPeriod || futureLookupPending || nextPeriodEventCount === 0}
                                        className="inline-flex items-center justify-center border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                        data-testid="event-list-extend-period"
                                    >
                                        {extendingPeriod
                                            ? 'Loading…'
                                            : futureLookupPending
                                                ? 'Looking ahead…'
                                                : nextPeriodEventCount === 0
                                                    ? 'No future events found'
                                                    : `Show ${nextPeriodEventCount} next available events`}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
                {showBottomFade && <div className="event-list-fade" />}
            </div>
        </div>
    );
}

/**
 * CTA cluster for an event card: each action icon is paired with its live
 * count (saved / going), Twitter-style. Counts are hidden when zero so
 * cards with no engagement stay quiet. Single source of truth for the
 * number is the attendance summary — `AttendeeAvatarStack` shows *who*,
 * not *how many*.
 */
function ActionCountCluster({ eventId, showRatings, isSavedFlag }: { eventId: string; showRatings: boolean; isSavedFlag: boolean }) {
    const summary = useAttendanceSummary(eventId);
    const savedCount = summary?.total_saved ?? 0;
    const goingCount = summary?.total_going ?? 0;
    return (
        <>
            <span className="inline-flex items-center">
                <SaveEventButton
                    eventId={eventId}
                    appearance="icon"
                    size="sm"
                    stopPropagation
                    className={isSavedFlag ? 'text-slate-700' : ''}
                />
                {savedCount > 0 && (
                    <span className="text-[11px] text-slate-500 -ml-0.5 mr-1 tabular-nums" aria-label={`${savedCount} saved`}>
                        {savedCount}
                    </span>
                )}
            </span>
            <span className="inline-flex items-center">
                <GoingButton
                    eventId={eventId}
                    appearance="icon"
                    size="sm"
                    stopPropagation
                />
                {goingCount > 0 && (
                    <span className="text-[11px] text-emerald-700 -ml-0.5 mr-1 tabular-nums" aria-label={`${goingCount} going`}>
                        {goingCount}
                    </span>
                )}
            </span>
            {showRatings && (
                <RateEventButton
                    eventId={eventId}
                    appearance="icon"
                    size="sm"
                    stopPropagation
                />
            )}
        </>
    );
}
