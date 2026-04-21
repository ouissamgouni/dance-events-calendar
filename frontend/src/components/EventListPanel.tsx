import { useEffect, useRef, useState, useCallback } from 'react';
import type { CalendarEvent } from '../types';
import { useSavedEvents } from '../context/SavedEventsContext';
import SaveEventButton from './SaveEventButton';
import TagBadges from './TagBadges';

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
    sortBy: 'date' | 'popularity';
    onSortChange: (sort: 'date' | 'popularity') => void;
    hoveredEventId?: string | null;
    onEventHover?: (eventId: string | null) => void;
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

function PopularityBadge({ viewCount, allViewCounts }: { viewCount: number; allViewCounts: number[] }) {
    if (viewCount === 0) return null;

    // Check if this is in top 3 of current visible events
    const sorted = [...allViewCounts].sort((a, b) => b - a);
    const isTop3 = viewCount > 0 && sorted.indexOf(viewCount) < 3 && sorted[0] > 0;

    if (isTop3 && viewCount >= 10) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700">
                🔥 Trending
            </span>
        );
    }
    if (viewCount >= 10) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                🔥 Popular
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
            👁 {viewCount}
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
    sortBy,
    onSortChange,
    hoveredEventId,
    onEventHover,
}: EventListPanelProps) {
    const { isSaved } = useSavedEvents();
    const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
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

    // Show all events — on-map first, off-map / ungeolocated pushed to the bottom
    const sortedEvents = [...events].sort((a, b) => {
        const aOnMap = isOnMap(a, mapBounds);
        const bOnMap = isOnMap(b, mapBounds);
        if (aOnMap !== bOnMap) return aOnMap ? -1 : 1;
        if (sortBy === 'popularity') return b.view_count - a.view_count;
        return new Date(a.start).getTime() - new Date(b.start).getTime();
    });

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
                        sortedEvents.map((event) => {
                            const start = new Date(event.start);
                            const onMap = isOnMap(event, mapBounds);
                            const isHighlighted = hoveredEventId === event.event_id;
                            return (
                                <button
                                    key={event.event_id}
                                    ref={(el) => { if (el) cardRefs.current.set(event.event_id, el); else cardRefs.current.delete(event.event_id); }}
                                    className={`event-card${onMap ? '' : ' opacity-40'}${isHighlighted ? ' event-card-highlighted' : ''}`}
                                    onClick={() => onEventClick(event)}
                                    onMouseEnter={() => onEventHover?.(event.event_id)}
                                    onMouseLeave={() => onEventHover?.(null)}
                                >
                                    <div className="event-card-color" style={{ backgroundColor: onMap ? (event.color || '#6b7280') : '#d1d5db' }} />
                                    <div className="event-card-content relative">
                                        <h4 className="event-card-title">{event.title}</h4>
                                        <p className="event-card-date">
                                            {event.all_day ? formatDate(start) : `${formatDate(start)} · ${formatTime(start)}`}
                                        </p>
                                        {event.location && (
                                            <p className="event-card-location">📍 {event.location}</p>
                                        )}
                                        {((showPrices && (event.price_is_free || (event.price_min != null && event.price_currency))) ||
                                            (showPopularity && event.view_count > 0)) && (
                                                <div className="event-card-badges">
                                                    {showPrices && <PriceBadge event={event} />}
                                                    {showPopularity && (
                                                        <PopularityBadge viewCount={event.view_count} allViewCounts={allViewCounts} />
                                                    )}
                                                </div>
                                            )}
                                        {event.tags?.length > 0 && (
                                            <div className="mt-1">
                                                <TagBadges tags={event.tags} maxVisible={3} />
                                            </div>
                                        )}
                                        <SaveEventButton
                                            eventId={event.event_id}
                                            appearance="icon"
                                            size="sm"
                                            stopPropagation
                                            className={`absolute top-0 right-0 ${isSaved(event.event_id) ? 'text-slate-700' : ''}`}
                                        />
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>
                {showBottomFade && <div className="event-list-fade" />}
            </div>
        </div>
    );
}
