import type { CalendarEvent } from '../types';

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

export default function EventListPanel({
    events,
    mapBounds,
    onEventClick,
    showPrices,
    showPopularity,
    sortBy,
    onSortChange,
}: EventListPanelProps) {
    // Filter to events within map bounds
    const visibleEvents = mapBounds
        ? events.filter((e) => isInBounds(e, mapBounds))
        : events;

    // Sort
    const sortedEvents = [...visibleEvents].sort((a, b) => {
        if (sortBy === 'popularity') return b.view_count - a.view_count;
        return new Date(a.start).getTime() - new Date(b.start).getTime();
    });

    const allViewCounts = sortedEvents.map((e) => e.view_count);

    const formatDate = (d: Date) =>
        d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const formatTime = (d: Date) =>
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return (
        <div className="event-list-panel">
            <div className="event-list-header">
                <span className="event-list-count">{sortedEvents.length} event{sortedEvents.length !== 1 ? 's' : ''}</span>
                <div className="event-list-sort">
                    <button
                        className={`sort-btn ${sortBy === 'date' ? 'active' : ''}`}
                        onClick={() => onSortChange('date')}
                    >
                        Date
                    </button>
                    {showPopularity && (
                        <button
                            className={`sort-btn ${sortBy === 'popularity' ? 'active' : ''}`}
                            onClick={() => onSortChange('popularity')}
                        >
                            Popular
                        </button>
                    )}
                </div>
            </div>

            <div className="event-list-scroll">
                {sortedEvents.length === 0 ? (
                    <div className="event-list-empty">
                        <p>No events in this area for the selected dates.</p>
                        <p className="text-xs text-slate-400 mt-1">Try zooming out or adjusting the date range.</p>
                    </div>
                ) : (
                    sortedEvents.map((event) => {
                        const start = new Date(event.start);
                        return (
                            <button
                                key={event.event_id}
                                className="event-card"
                                onClick={() => onEventClick(event)}
                            >
                                <div className="event-card-color" style={{ backgroundColor: event.color || '#6b7280' }} />
                                <div className="event-card-content">
                                    <h4 className="event-card-title">{event.title}</h4>
                                    <p className="event-card-date">
                                        {event.all_day ? formatDate(start) : `${formatDate(start)} · ${formatTime(start)}`}
                                    </p>
                                    {event.location && (
                                        <p className="event-card-location">📍 {event.location}</p>
                                    )}
                                    <div className="event-card-badges">
                                        {showPrices && <PriceBadge event={event} />}
                                        {showPopularity && (
                                            <PopularityBadge viewCount={event.view_count} allViewCounts={allViewCounts} />
                                        )}
                                    </div>
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
}
