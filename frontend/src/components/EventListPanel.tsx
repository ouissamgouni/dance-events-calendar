import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { CalendarEvent } from '../types';
import { useAuth } from '../context/AuthContext';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAttendanceSummary } from '../context/AttendanceSummariesContext';
import SaveEventButton from './SaveEventButton';
import GoingButton from './GoingButton';
import AttendeeAvatarStack from './AttendeeAvatarStack';
import RateEventButton from './RateEventButton';
import TagBadges from './TagBadges';
import { isTrendingScore } from '../utils/trending';
import { shortLocation } from '../utils/locationShort';

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
    /** When true, anonymous viewers hit a persistent lock before deeper pagination. */
    gateMoreEventsForAnonymous?: boolean;
    /** When true, render tags as light-grey badges (max 4) instead of the
     * default plain-text/flag-driven look. Used by the Explorer list. */
    tagsAsBadge?: boolean;
    /**
     * Fires once per event id when a card has been at least 50% visible
     * inside the list scroller for ~500ms on touch devices (`hover:
     * none`). Provides a mobile-friendly equivalent of the desktop
     * hover-to-mark-seen affordance — parent calls `markSeen(id)` here.
     * Idempotent by contract; the observer may fire the same id multiple
     * times if the viewer scrolls it out and back.
     */
    onMarkSeen?: (eventId: string) => void;
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
    /** When true, tags render as light-grey badges (max 4) on this card. */
    tagsAsBadge?: boolean;
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
    if (!isTrendingScore(score, allScores, threshold, topN, topPercent)) return null;
    return (
        <span
            className="inline-flex items-center bg-orange-50 px-1.5 py-px text-[10px] font-medium text-orange-400"
            data-testid="trending-badge"
            title="Trending"
        >
            Trending
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
    tagsAsBadge = false,
}: EventListCardProps) {
    const { tagsPerCard } = useFeatureFlags();
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
                // eslint-disable-next-line no-restricted-syntax -- rounded event cards per explicit design request (Explorer list)
                className={`event-card rounded-md${onMap ? '' : ' event-card-offmap'}${isHighlighted ? ' event-card-highlighted' : ''}`}
                onClick={() => onEventClick(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEventClick(event); } }}
                onMouseEnter={() => onEventHover?.(event.event_id)}
                onMouseLeave={() => onEventHover?.(null)}
            >
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
                    {showPopularity && (
                        <div className="mt-0.5">
                            <PopularityBadge
                                score={event.popularity_score ?? 0}
                                allScores={allViewCounts}
                                threshold={popularityThreshold}
                                topN={trendingTopN}
                                topPercent={trendingTopPercent}
                            />
                        </div>
                    )}
                    <div className="flex items-center gap-8">
                        <p className="event-card-date shrink-0">
                            {event.all_day ? formatCardDate(start) : `${formatCardDate(start)} · ${formatCardTime(start)}`}
                        </p>
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <AttendeeAvatarStack
                                eventId={event.event_id}
                                friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                            />
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                        </div>
                    </div>
                    {event.location && (
                        <p className="event-card-location">
                            {offMapBadge}
                            <span className="event-card-location-text" title={event.location ?? undefined}>{shortLocation(event.location) ?? event.location}</span>
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
                            <TagBadges
                                tags={event.tags}
                                maxVisible={tagsAsBadge ? 4 : tagsPerCard}
                                forceBadge={tagsAsBadge}
                            />
                        </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2">

                    </div>
                    <div className="event-card-actions absolute top-0 right-0 flex items-center gap-1.5">
                        <ActionCountCluster eventId={event.event_id} showRatings={!!showRatings} isSavedFlag={isSavedFlag} />
                    </div>
                </div>
            </div>
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
    gateMoreEventsForAnonymous = false,
    onMarkSeen,
    tagsAsBadge = false,
}: EventListPanelProps) {
    const { user } = useAuth();
    const { isSaved } = useSavedEvents();
    const { showRatings, trendingEnabled, trendingTopN, trendingTopPercent, followingBadgeEnabled } = useFeatureFlags();
    const location = useLocation();
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const scrollRef = useRef<HTMLDivElement>(null);
    // Touch-device auto-mark-seen: fires 500ms after a card has been
    // ≥50% visible inside the list scroller. Desktop keeps using the
    // hover-to-mark-seen path (see Home.tsx handleExplorerListEventHover),
    // so we only wire the observer where hover is impossible.
    const seenObserverRef = useRef<IntersectionObserver | null>(null);
    const seenTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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

    // Touch-device auto-mark-seen. Set up a single IntersectionObserver
    // scoped to the browser viewport (NOT ``scrollRef.current``): on
    // mobile the CSS in index.css switches ``.event-list-scroll`` to
    // ``overflow: visible`` so the page scrolls instead of the inner
    // container, which means an observer rooted on the inner div never
    // sees intersection changes. Rooting on the viewport works for both
    // the mobile page-scroll and the desktop inner-container-scroll
    // (cards move relative to the viewport in both cases). Cards
    // register/unregister through ``observeCardForSeen`` below. Fires
    // the parent callback 500ms after a card has been ≥50% visible so a
    // fast scroll-past doesn't silently clear every unseen dot on the
    // way to the target card.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        if (!onMarkSeen) return;
        if (!('IntersectionObserver' in window)) return;
        if (!window.matchMedia('(hover: none)').matches) return;
        const timers = seenTimersRef.current;
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const id = (entry.target as HTMLElement).dataset.seenId;
                if (!id) continue;
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    if (timers.has(id)) continue;
                    const timer = setTimeout(() => {
                        timers.delete(id);
                        onMarkSeen(id);
                    }, 500);
                    timers.set(id, timer);
                } else {
                    const timer = timers.get(id);
                    if (timer) {
                        clearTimeout(timer);
                        timers.delete(id);
                    }
                }
            }
        }, { root: null, threshold: [0, 0.5, 1] });
        seenObserverRef.current = observer;
        for (const el of cardRefs.current.values()) observer.observe(el);
        return () => {
            observer.disconnect();
            seenObserverRef.current = null;
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        };
    }, [onMarkSeen]);

    // Scroll to highlighted card when hoveredEventId changes from an external source (map/calendar)
    useEffect(() => {
        if (!scrollHighlightedIntoView) return;
        if (!hoveredEventId) return;
        const el = cardRefs.current.get(hoveredEventId);
        if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [hoveredEventId, scrollHighlightedIntoView]);

    // Stable ref-callback used by <EventListCard cardRef=...>. Registers
    // the DOM node under both the id→node lookup (used by the scroll-
    // into-view effect above) AND the touch auto-mark-seen observer.
    const observeCardForSeen = useCallback((eventId: string) => (el: HTMLDivElement | null) => {
        const previous = cardRefs.current.get(eventId);
        if (el) {
            cardRefs.current.set(eventId, el);
            el.dataset.seenId = eventId;
            seenObserverRef.current?.observe(el);
        } else {
            cardRefs.current.delete(eventId);
            if (previous) seenObserverRef.current?.unobserve(previous);
        }
    }, []);

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

    // Slice the sorted list to the current ``visibleCount`` so the user only
    // sees what they explicitly asked for. The full count drives the
    // "Showing X of Y" counter and the Show more remaining count.
    const totalCount = scopeTotalCount ?? sortedEvents.length;
    const cappedVisible = Math.min(visibleCount, totalCount);
    const renderedEvents = sortedEvents.slice(0, cappedVisible);
    const remainingInPeriod = Math.max(0, totalCount - cappedVisible);
    const periodExhausted = remainingInPeriod === 0;
    const futureLookupPending = !!onExtendPeriod && nextPeriodEventCount == null;
    const canRevealFutureEvents = !!onExtendPeriod && (nextPeriodEventCount ?? 0) > 0;
    const showAnonymousMoreEventsGate = gateMoreEventsForAnonymous
        && !user
        && cappedVisible >= Math.min(INITIAL_VISIBLE, totalCount)
        && (remainingInPeriod > 0 || canRevealFutureEvents);
    const hiddenEventCount = remainingInPeriod > 0
        ? remainingInPeriod
        : Math.max(nextPeriodEventCount ?? 0, 0);
    const next = encodeURIComponent(location.pathname + location.search);

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
                    {`${totalCount} Events`}
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
                            <span className="sm:hidden">{newCount} New</span>
                            <span className="hidden sm:inline">New only</span>
                        </button>
                    )}
                </div>
            </div>

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
                                        lastDayKey = dayKey;
                                        return (
                                            <Fragment key={event.event_id}>
                                                {idx === firstPastIndex && (
                                                    <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-t border-slate-200 mt-2">
                                                        Past events
                                                    </div>
                                                )}
                                                <div
                                                    className="sticky top-0 z-[5] flex items-center gap-2 bg-slate-50 border-b border-slate-300 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
                                                    data-testid="event-list-day-header"
                                                    data-day={dayKey}
                                                >
                                                    <span>{formatDayHeader(start)}</span>
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
                                                    cardRef={observeCardForSeen(event.event_id)}
                                                    tagsAsBadge={tagsAsBadge}
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
                                                cardRef={observeCardForSeen(event.event_id)}
                                                tagsAsBadge={tagsAsBadge}
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
                            {showAnonymousMoreEventsGate && (
                                <div className="m-3 border border-blue-100 bg-blue-50 p-4" data-testid="event-list-more-events-gate">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">
                                        More events available
                                    </p>
                                    <p className="mt-1 text-sm font-medium text-slate-800">
                                        Sign in to unlock {hiddenEventCount} more {hiddenEventCount === 1 ? 'event' : 'events'}.
                                    </p>
                                    <p className="mt-1 text-xs text-slate-600">
                                        You are viewing the anonymous preview. Sign in to keep exploring from this point.
                                    </p>
                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <Link
                                            to={`/login?next=${next}`}
                                            className="inline-flex items-center justify-center bg-blue-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-600"
                                        >
                                            Sign in to see more
                                        </Link>
                                        <span className="text-[11px] text-slate-500">
                                            {remainingInPeriod > 0
                                                ? `${remainingInPeriod} more in this view`
                                                : `${hiddenEventCount} more in the next available window`}
                                        </span>
                                    </div>
                                </div>
                            )}
                            {!showAnonymousMoreEventsGate && !periodExhausted && (
                                <div className="px-3 py-3 text-center">
                                    <button
                                        type="button"
                                        onClick={() => setVisibleCount((n) => n + SHOW_MORE_INCREMENT)}
                                        className="inline-flex items-center justify-center border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 py-2 transition"
                                        data-testid="event-list-show-more"
                                    >
                                        + {Math.min(SHOW_MORE_INCREMENT, remainingInPeriod)} more
                                    </button>
                                </div>
                            )}
                            {!showAnonymousMoreEventsGate && periodExhausted && onExtendPeriod && (
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
                                                    : `+ ${nextPeriodEventCount} more`}
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
