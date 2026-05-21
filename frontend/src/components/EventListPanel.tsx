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
}: EventListPanelProps) {
    const { isSaved } = useSavedEvents();
    const { showRatings, trendingEnabled, trendingTopN, trendingTopPercent, followingBadgeEnabled } = useFeatureFlags();
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const scrollRef = useRef<HTMLDivElement>(null);
    const [showBottomFade, setShowBottomFade] = useState(false);
    // Client-side only filter: hide events that are not new for this viewer.
    // Per the scenario, no network call is made when toggled.
    const [newOnly, setNewOnly] = useState(false);

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
        if (!hoveredEventId) return;
        const el = cardRefs.current.get(hoveredEventId);
        if (el) {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [hoveredEventId]);

    // Counter over the unfiltered list so toggling the chip doesn't make it jump.
    const newCount = newEnabled && newEventIds
        ? events.reduce((n, e) => (newEventIds.has(e.event_id) ? n + 1 : n), 0)
        : 0;
    const effectiveNewOnly = newOnly && newCount > 0;

    // Show all events — on-map first, off-map / ungeolocated pushed to the bottom.
    // When pastEventIds is provided, keep upcoming events before past events.
    const visibleEvents = newEnabled && effectiveNewOnly && newEventIds
        ? events.filter((e) => newEventIds.has(e.event_id))
        : events;
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

    const onMapCount = mapBounds ? events.filter((e) => isOnMap(e, mapBounds)).length : events.length;

    const allViewCounts = sortedEvents.map((e) => e.popularity_score ?? 0);

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (
        <div className="event-list-panel">
            <div className="event-list-header">
                <span className="event-list-count">
                    {onMapCount} event{onMapCount !== 1 ? 's' : ''}
                    {mapBounds && onMapCount < sortedEvents.length && (
                        <span className="text-slate-400 font-normal"> · {sortedEvents.length - onMapCount} off map</span>
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
                    {sortedEvents.length === 0 ? (
                        <div className="event-list-empty">
                            <p>No events in this area for the selected dates.</p>
                            <p className="text-xs text-slate-400 mt-1">Try zooming out or adjusting the date range.</p>
                            {onSuggestEvent && (
                                <button
                                    type="button"
                                    onClick={onSuggestEvent}
                                    className="mt-4 inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-4 py-2 shadow-sm transition"
                                >
                                    + Suggest an event
                                </button>
                            )}
                        </div>
                    ) : (
                        sortedEvents.map((event, idx) => {
                            const start = new Date(event.start);
                            const onMap = isOnMap(event, mapBounds);
                            const isHighlighted = hoveredEventId === event.event_id;
                            const isNew = newEnabled && !!newEventIds?.has(event.event_id);
                            return (
                                <Fragment key={event.event_id}>
                                    {idx === firstPastIndex && (
                                        <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-t border-slate-200 mt-2">
                                            Past events
                                        </div>
                                    )}
                                    <div
                                        ref={(el) => { if (el) cardRefs.current.set(event.event_id, el); else cardRefs.current.delete(event.event_id); }}
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
                                                    return <span className="event-tag-stripe" style={{ backgroundColor: onMap ? '#6b7280' : '#d1d5db' }} />;
                                                }
                                                return colors.map((c, i) => (
                                                    <span
                                                        key={i}
                                                        className="event-tag-stripe"
                                                        style={{ backgroundColor: onMap ? c : '#d1d5db' }}
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
                                                {event.all_day ? formatDate(start) : `${formatDate(start)} · ${formatTime(start)}`}
                                            </p>
                                            {event.location && (
                                                <p className="event-card-location">📍 {event.location}</p>
                                            )}
                                            {!onMap && (
                                                <span className="event-card-offmap-badge">Off map</span>
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
                                                {showPopularity && trendingEnabled && (
                                                    <PopularityBadge
                                                        score={event.popularity_score ?? 0}
                                                        allScores={allViewCounts}
                                                        threshold={popularityThreshold}
                                                        topN={trendingTopN}
                                                        topPercent={trendingTopPercent}
                                                    />
                                                )}
                                            </div>
                                            <div className="absolute top-0 right-0 flex items-center gap-1.5">
                                                <ActionCountCluster eventId={event.event_id} showRatings={!!showRatings} isSavedFlag={isSaved(event.event_id)} />
                                            </div>
                                        </div>
                                    </div>
                                </Fragment>
                            );
                        })
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
