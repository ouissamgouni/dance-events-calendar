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
import TagBadges from './TagBadges';
import { useRatingAggregate } from '../context/RatingAggregatesContext';
import { useEventMessageCount } from '../context/MessageCountsContext';
import { isTrendingScore } from '../utils/trending';
import { shortLocation } from '../utils/locationShort';
import { isPriceSectionVisible } from '../utils/sectionVisibility';
import { currencySymbol } from '../utils/currency';

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
    /** When true, order the list by how many people are going/saved
     * (``going_count + saved_count`` desc) instead of date/popularity, and
     * skip day-group headers. Used by the Tribe (subscriptions) list. */
    orderByFollows?: boolean;
    /**
     * Fires once per event id when a card has been at least 50% visible
     * inside the list scroller for ~500ms on touch devices (`hover:
     * none`). Provides a mobile-friendly equivalent of the desktop
     * hover-to-mark-seen affordance — parent calls `markSeen(id)` here.
     * Idempotent by contract; the observer may fire the same id multiple
     * times if the viewer scrolls it out and back.
     */
    onMarkSeen?: (eventId: string) => void;
    /** Optional content rendered at the very top of the scrolling list
     * (e.g. the trending trail rail). Scrolls away with the results. */
    headerSlot?: React.ReactNode;
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
    /** When true, the card gets a muted grey background (past events). */
    isPast?: boolean;
    /** When true, render the left date rail (timeline layout) and move the
        attendee avatar stack onto its own line. */
    timeline?: boolean;
}

function PriceBadge({ event }: { event: CalendarEvent }) {
    if (event.price_is_free) {
        return (
            <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-px text-[10px] font-medium leading-3 text-ink-soft">
                <img src="/price-tag.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
                Free
            </span>
        );
    }
    if (event.price_min != null && event.price_currency) {
        const sign = currencySymbol(event.price_currency);
        const priceText = event.price_max != null && event.price_max !== event.price_min
            ? `${sign}${event.price_min}–${sign}${event.price_max}`
            : `${sign}${event.price_min}`;
        return (
            <span className="inline-flex items-center gap-1 bg-slate-100 px-1.5 py-px text-[10px] font-medium leading-3 text-ink-soft">
                <img src="/price-tag.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
                {priceText}
            </span>
        );
    }
    return null;
}

function DiscountBadge() {
    return (
        <span
            className="inline-flex items-center gap-1 bg-amber-50 px-1.5 py-px text-[10px] font-medium leading-3 text-amber-700"
            title="Has promo codes"
            data-testid="event-card-promo-icon"
        >
            <img src="/promo-code.png" alt="" aria-hidden="true" className="w-2.5 h-2.5 object-contain" />
            Discount
        </span>
    );
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

/** Short weekday label for the timeline rail, e.g. "SAT". */
const formatRailWeekday = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();

/** Short month label for the timeline rail, e.g. "AUG". */
const formatRailMonth = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();

/** Initial number of events to render before the user taps Show more. */
const INITIAL_VISIBLE = 10;
/** How many additional events each Show more click reveals. */
const SHOW_MORE_INCREMENT = 10;

function CardEngagementBadges({ eventId, showRatings }: { eventId: string; showRatings: boolean }) {
    const agg = useRatingAggregate(eventId);
    const messageCount = useEventMessageCount(eventId);
    const reviews = showRatings ? (agg?.count ?? 0) : 0;
    const messages = messageCount ?? 0;
    if (reviews === 0 && messages === 0) return null;
    return (
        <div className="flex shrink-0 items-center gap-2">
            {reviews > 0 && (
                <Link
                    to={`/event/${encodeURIComponent(eventId)}#community`}
                    onClick={(e) => e.stopPropagation()}
                    title="See reviews"
                    aria-label={`${reviews} review${reviews === 1 ? '' : 's'}`}
                    className="flex items-center gap-1 text-ink-soft hover:text-ink"
                >
                    <img src="/star.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                    <span className="tabular-nums text-[10px] font-medium">{reviews}</span>
                </Link>
            )}
            {messages > 0 && (
                <Link
                    to={`/event/${encodeURIComponent(eventId)}#messages`}
                    onClick={(e) => e.stopPropagation()}
                    title="See messages"
                    aria-label={`${messages} message${messages === 1 ? '' : 's'}`}
                    className="flex items-center gap-1 text-ink-soft hover:text-ink"
                >
                    <img src="/comment.png" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
                    <span className="tabular-nums text-[10px] font-medium">{messages}</span>
                </Link>
            )}
        </div>
    );
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
    isPast = false,
    timeline = false,
}: EventListCardProps) {
    const { tagsPerCard } = useFeatureFlags();
    const priceVisible = isPriceSectionVisible(event, showPrices);
    const start = new Date(event.start);
    const end = new Date(event.end);
    // Multi-day events must surface the end date, not just an end time, or a
    // range like "1:00 PM – 5:00 AM" reads as same-day when it isn't.
    const sameDay = start.toDateString() === end.toDateString();
    const timelineWhen = event.all_day
        ? (sameDay ? 'All day' : `Until ${formatCardDate(new Date(end.getTime() - 1))}`)
        : (sameDay
            ? `${formatCardTime(start)} – ${formatCardTime(end)}`
            : `${formatCardTime(start)} – ${formatCardDate(end)}, ${formatCardTime(end)}`);
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
                className={`event-card${timeline ? ' event-card-timeline' : ''}${onMap ? '' : ' event-card-offmap'}${isHighlighted ? ' event-card-highlighted' : ''}${isPast ? ' event-card-past' : ''}`}
                onClick={() => onEventClick(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEventClick(event); } }}
                onMouseEnter={() => onEventHover?.(event.event_id)}
                onMouseLeave={() => onEventHover?.(null)}
            >
                {timeline && (
                    <div className="event-card-rail" aria-hidden="true" data-testid="event-card-rail">
                        <div className="event-card-rail-date">
                            <span className="event-card-rail-weekday">{formatRailWeekday(start)}</span>
                            <span className="event-card-rail-month">{formatRailMonth(start)}</span>
                            <span className="event-card-rail-day">{start.getDate()}</span>
                        </div>
                        <div className="event-card-rail-track">
                            <span className="event-card-rail-dot" />
                        </div>
                    </div>
                )}
                <div className="event-card-content relative">
                    <h4
                        className={`event-card-title${isNew ? ' font-semibold' : ''}`}
                        data-new={isNew ? 'true' : undefined}
                    >
                        {isNew && (
                            <span
                                className="inline-block h-1.5 w-1.5 bg-action mr-1.5 align-middle"
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
                            {timeline
                                ? timelineWhen
                                : (event.all_day ? formatCardDate(start) : `${formatCardDate(start)} · ${formatCardTime(start)}`)}
                        </p>
                        {!timeline && (
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                <AttendeeAvatarStack
                                    eventId={event.event_id}
                                    friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                                />
                            </div>
                        )}
                    </div>
                    {(priceVisible || event.has_active_promo_codes || event.location) ? (
                        <p className="event-card-location gap-1.5">
                            {offMapBadge}
                            {event.location && (
                                <span className="event-card-location-text" title={event.location ?? undefined}>{shortLocation(event.location) ?? event.location}</span>
                            )}
                            {(priceVisible || event.has_active_promo_codes) && (
                                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                    {priceVisible && <PriceBadge event={event} />}
                                    {event.has_active_promo_codes && <DiscountBadge />}
                                </span>
                            )}
                        </p>
                    ) : (
                        !onMap && (
                            <span className="event-card-offmap-badge event-card-offmap-badge-standalone" role="img" aria-label="Off map" title="Off map">
                                <img src="/location-off.png" alt="" aria-hidden="true" className="event-card-offmap-icon" />
                            </span>
                        )
                    )}
                    {timeline && (
                        <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
                            <AttendeeAvatarStack
                                eventId={event.event_id}
                                friendsPreview={followingBadgeEnabled ? event.following_friends_preview : undefined}
                            />
                        </div>
                    )}
                    {event.tags?.length > 0 && (
                        <div className="mt-1 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                                <TagBadges
                                    tags={event.tags}
                                    maxVisible={tagsAsBadge ? 4 : tagsPerCard}
                                    forceBadge={tagsAsBadge}
                                />
                            </div>
                            <CardEngagementBadges eventId={event.event_id} showRatings={showRatings} />
                        </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                        {!(event.tags?.length > 0) && (
                            <CardEngagementBadges eventId={event.event_id} showRatings={showRatings} />
                        )}
                    </div>
                    <div className="event-card-actions absolute top-0 right-0 flex items-center gap-1.5">
                        <ActionCountCluster eventId={event.event_id} isSavedFlag={isSavedFlag} isPast={new Date(event.end).getTime() < Date.now()} />
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
    orderByFollows = false,
    headerSlot,
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
        if (orderByFollows) {
            // Most people (follows) going/saved first — mirrors the For You
            // "Following and friends" trail ordering.
            const pa = (a.going_count ?? 0) + (a.saved_count ?? 0);
            const pb = (b.going_count ?? 0) + (b.saved_count ?? 0);
            if (pa !== pb) return pb - pa;
        }
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
            {headerSlot}
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
                                ? 'border-action bg-action text-white'
                                : 'border-line bg-surface text-ink-soft hover:border-line'}`}
                        >
                            {/* eslint-disable-next-line no-restricted-syntax -- small status dot */}
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-action" aria-hidden="true" />
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
                            <p className="text-sm font-medium text-ink">
                                No events match your filters
                            </p>
                            <p className="text-xs text-ink-soft mt-1">
                                Try finding the next matching events or clearing filters.
                            </p>
                            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                                {onExtendPeriod && (
                                    <button
                                        type="button"
                                        onClick={handleExtendPeriodClick}
                                        disabled={extendingPeriod || futureLookupPending || nextPeriodEventCount === 0}
                                        className="inline-flex items-center bg-action hover:bg-action text-white text-xs font-semibold px-3 py-1.5 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
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
                                        className="inline-flex items-center border border-line bg-surface hover:bg-canvas text-ink text-xs font-semibold px-3 py-1.5 transition"
                                        data-testid="event-list-empty-clear"
                                    >
                                        Clear filters
                                    </button>
                                )}
                                {onSuggestEvent && (
                                    <button
                                        type="button"
                                        onClick={onSuggestEvent}
                                        className="inline-flex items-center border border-line bg-surface hover:bg-canvas text-ink text-xs font-semibold px-3 py-1.5 transition"
                                    >
                                        + Suggest an event
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
                            {(() => {
                                // Timeline layout: each card carries its own left date rail
                                // (weekday / month / day + dot on a continuous line), so no
                                // sticky day-group headers are needed. Past events still get
                                // their divider above the past block.
                                return renderedEvents.map((event, idx) => {
                                    const isHighlighted = hoveredEventId === event.event_id;
                                    const isNew = newEnabled && !!newEventIds?.has(event.event_id);
                                    const isPast = !!pastEventIds?.has(event.event_id);
                                    return (
                                        <Fragment key={event.event_id}>
                                            {idx === firstPastIndex && (
                                                <div className="px-3 py-2 text-xs font-semibold text-muted uppercase tracking-wide border-t border-line mt-2">
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
                                                isPast={isPast}
                                                timeline
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
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-action">
                                        More events available
                                    </p>
                                    <p className="mt-1 text-sm font-medium text-ink">
                                        Sign in to unlock {hiddenEventCount} more {hiddenEventCount === 1 ? 'event' : 'events'}.
                                    </p>
                                    <p className="mt-1 text-xs text-ink-soft">
                                        You are viewing the anonymous preview. Sign in to keep exploring from this point.
                                    </p>
                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <Link
                                            to={`/login?next=${next}`}
                                            className="inline-flex items-center justify-center bg-action px-3 py-2 text-xs font-semibold text-white transition hover:bg-action"
                                        >
                                            Sign in to see more
                                        </Link>
                                        <span className="text-[11px] text-ink-soft">
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
                                        className="inline-flex items-center justify-center border border-line bg-surface hover:bg-canvas text-ink text-xs font-semibold px-3 py-2 transition"
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
                                        className="inline-flex items-center justify-center border border-line bg-surface hover:bg-canvas text-ink text-xs font-semibold px-3 py-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
function ActionCountCluster({ eventId, isSavedFlag, isPast = false }: { eventId: string; isSavedFlag: boolean; isPast?: boolean }) {
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
                    className={isSavedFlag ? 'text-ink' : ''}
                />
                {savedCount > 0 && (
                    <span className="text-[11px] text-ink-soft -ml-0.5 mr-1 tabular-nums" aria-label={`${savedCount} saved`}>
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
                    isPast={isPast}
                />
                {goingCount > 0 && (
                    <span className="text-[11px] text-success -ml-0.5 mr-1 tabular-nums" aria-label={`${goingCount} ${isPast ? 'attended' : 'going'}`}>
                        {goingCount}
                    </span>
                )}
            </span>
        </>
    );
}
