import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import type { CalendarEvent } from '../types';
import { useSavedEvents } from '../context/SavedEventsContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
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
}

function PriceBadge({ event }: { event: CalendarEvent }) {
    if (event.price_is_free) {
        return (
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Free
            </span>
        );
    }
    if (event.price_min != null && event.price_currency) {
        const priceText = event.price_max != null && event.price_max !== event.price_min
            ? `${event.price_currency} ${event.price_min}–${event.price_max}`
            : `${event.price_currency} ${event.price_min}`;
        return (
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                {priceText}
            </span>
        );
    }
    return null;
}

function PopularityBadge({ viewCount, allViewCounts, threshold }: { viewCount: number; allViewCounts: number[]; threshold: number }) {
    if (viewCount === 0) return null;

    // Check if this is in top 3 of current visible events
    const sorted = [...allViewCounts].sort((a, b) => b - a);
    const isTop3 = viewCount > 0 && sorted.indexOf(viewCount) < 3 && sorted[0] > 0;

    const countBadge = (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
            👁 {viewCount}
        </span>
    );

    if (isTop3 && viewCount >= threshold) {
        return (
            <>
                <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700">
                    🔥 Trending
                </span>
                {countBadge}
            </>
        );
    }
    if (viewCount >= threshold) {
        return (
            <>
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                    🔥 Popular
                </span>
                {countBadge}
            </>
        );
    }
    return countBadge;
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
}: EventListPanelProps) {
    const { isSaved } = useSavedEvents();
    const { showRatings } = useFeatureFlags();
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const scrollRef = useRef<HTMLDivElement>(null);
    const [showBottomFade, setShowBottomFade] = useState(false);

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

    // Show all events — on-map first, off-map / ungeolocated pushed to the bottom.
    // When pastEventIds is provided, keep upcoming events before past events.
    const sortedEvents = [...events].sort((a, b) => {
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
        if (sortBy === 'popularity') return b.view_count - a.view_count;
        return new Date(a.start).getTime() - new Date(b.start).getTime();
    });

    const firstPastIndex = pastEventIds
        ? sortedEvents.findIndex((e) => pastEventIds.has(e.event_id))
        : -1;

    const onMapCount = mapBounds ? events.filter((e) => isOnMap(e, mapBounds)).length : events.length;

    const allViewCounts = sortedEvents.map((e) => e.view_count);

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
                </div>
            </div>

            <div className="event-list-scroll-wrapper">
                <div className="event-list-scroll" ref={scrollRef} onScroll={updateFade}>
                    {sortedEvents.length === 0 ? (
                        <div className="event-list-empty">
                            <p>No events in this area for the selected dates.</p>
                            <p className="text-xs text-slate-400 mt-1">Try zooming out or adjusting the date range.</p>
                        </div>
                    ) : (
                        sortedEvents.map((event, idx) => {
                            const start = new Date(event.start);
                            const onMap = isOnMap(event, mapBounds);
                            const isHighlighted = hoveredEventId === event.event_id;
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
                                            <h4 className="event-card-title">{event.title}</h4>
                                            <p className="event-card-date">
                                                {event.all_day ? formatDate(start) : `${formatDate(start)} · ${formatTime(start)}`}
                                            </p>
                                            {event.location && (
                                                <p className="event-card-location">📍 {event.location}</p>
                                            )}
                                            {!onMap && (
                                                <span className="event-card-offmap-badge">Off map</span>
                                            )}
                                            {((showPrices && (event.price_is_free || (event.price_min != null && event.price_currency))) ||
                                                (showPopularity && event.view_count > 0)) && (
                                                    <div className="event-card-badges">
                                                        {showPrices && <PriceBadge event={event} />}
                                                        {showPopularity && (
                                                            <PopularityBadge viewCount={event.view_count} allViewCounts={allViewCounts} threshold={popularityThreshold} />
                                                        )}
                                                    </div>
                                                )}
                                            {event.tags?.length > 0 && (
                                                <div className="mt-1">
                                                    <TagBadges tags={event.tags} maxVisible={3} />
                                                </div>
                                            )}
                                            <div className="mt-1">
                                                <AttendeeAvatarStack eventId={event.event_id} />
                                            </div>
                                            <div className="absolute top-0 right-0 flex items-center gap-0.5">
                                                <SaveEventButton
                                                    eventId={event.event_id}
                                                    appearance="icon"
                                                    size="sm"
                                                    stopPropagation
                                                    className={isSaved(event.event_id) ? 'text-slate-700' : ''}
                                                />
                                                <GoingButton
                                                    eventId={event.event_id}
                                                    appearance="icon"
                                                    size="sm"
                                                    stopPropagation
                                                />
                                                {showRatings && (
                                                    <RateEventButton
                                                        eventId={event.event_id}
                                                        appearance="icon"
                                                        size="sm"
                                                        stopPropagation
                                                    />
                                                )}
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
